/**
 * voucherEditService.js — Password-protected editing of POSTED vouchers.
 *
 * Design note — why this doesn't touch postingEngine.js's core mechanics:
 * `journal_entries` is append-only (trigger-enforced: no UPDATE/DELETE) and has
 * a UNIQUE constraint on `voucher_id` (one ledger entry per voucher, forever).
 * That means the one and only accounting-correct way to change a POSTED
 * voucher's *financial* impact — without touching the schema or the posting
 * engine — is the standard immutable-ledger pattern: reverse the old entry,
 * then post a corrected one. This service does exactly that using the
 * EXISTING, unmodified `PostingEngine.reverse()` and `PostingEngine.postInTransaction()`
 * — nothing about how journal entries are built, balanced, hashed or chained
 * is changed here.
 *
 * IMPORTANT — this does NOT call `VoucherService.create()`:
 * That path is the normal user-facing "create a new voucher" flow — it pulls
 * a real, user-visible voucher number from `next_voucher_number()` under the
 * voucher type's real sequence (the same counter real JV/SI/PI/... vouchers
 * use). Calling it from an edit is what made an edit look like "Reverse →
 * Create JV-0002": a second real voucher silently entered the numbering
 * sequence and had to be filtered back out of every list.
 *
 * Instead, the corrected journal effect is posted against a bare internal
 * "ledger anchor" row that this service inserts directly:
 *   - its `voucher_no` is never drawn from `next_voucher_number()` — it's a
 *     `SYS-CORR-…` label that never touches the real sequence, so no
 *     user-facing voucher number is ever generated or burned by an edit,
 *   - `metadata.system_correction = true` marks it as internal ledger
 *     plumbing (not a voucher), and every list/report query that shows
 *     vouchers to the user already filters this flag out,
 *   - the actual journal entry for it is still written by the existing,
 *     unmodified `PostingEngine.postInTransaction()`, so balance validation,
 *     period-lock validation, account validation, and hash chaining are all
 *     exactly the same as for any other post.
 *
 * From the user's point of view the voucher they opened is the one that gets
 * updated: same `id`, same `voucher_no`, same row — its date/party/narration/
 * lines are updated in place and it stays `POSTED`. Nothing new ever appears
 * in the voucher list.
 *
 * Repeated edits: the voucher's own `metadata.ledger_correction.active_entry_voucher_id`
 * tracks which internal anchor currently holds the *live* journal entry, so a
 * second (or third, ...) edit reverses the most recent corrected entry rather
 * than re-reversing the original, stale, already-superseded one. Without this,
 * editing the same voucher twice would silently corrupt the ledger even though
 * the voucher itself kept displaying correctly — exactly the failure mode this
 * service exists to avoid.
 *
 * Audit trail uses the existing append-only `audit_log` table (via
 * AuditLogger — untouched), so no new tables/columns are needed. The
 * "Edited" badge is a computed `is_edited` flag (EXISTS against audit_log),
 * unchanged from before.
 */
const crypto         = require('crypto')
const db             = require('../db/knex')
const AuditLogger    = require('../utils/auditLogger')
const PostingEngine  = require('../engines/postingEngine')
const { AppError }   = require('../engines/postingEngine')

class VoucherEditService {
  /**
   * @param {object} params
   * @param {string} params.voucherId
   * @param {string} params.companyId
   * @param {string} params.userId      - editor (already password-confirmed by the route)
   * @param {string} params.reason      - mandatory edit reason, goes into the audit trail
   * @param {string} [params.voucherDate]
   * @param {string|null} [params.partyId]
   * @param {string} [params.narration]
   * @param {Array}  params.lines       - corrected lines, same shape as VoucherService.create()
   * @param {string} [ipAddress]
   */
  static async edit({ voucherId, companyId, userId, reason, voucherDate, partyId, narration, lines }, ipAddress = null) {
    if (!reason?.trim()) throw new AppError('An edit reason is required', 400)
    if (!Array.isArray(lines) || lines.length < 2) throw new AppError('A voucher requires at least 2 lines', 400)

    // ── Double-entry validation on the corrected lines ──────────────────────
    // Previously delegated to VoucherService.create(); now enforced directly
    // here since the correction no longer goes through that path.
    const totalDebit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0)
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0)
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new AppError(`Voucher does not balance: Dr ${totalDebit.toFixed(2)} ≠ Cr ${totalCredit.toFixed(2)}`, 400)
    }
    if (totalDebit <= 0) throw new AppError('Voucher total must be greater than zero', 400)
    for (const [i, line] of lines.entries()) {
      const dr = Number(line.debit  || 0)
      const cr = Number(line.credit || 0)
      if (dr > 0 && cr > 0) throw new AppError(`Line ${i + 1}: cannot have both debit and credit`, 400)
      if (dr === 0 && cr === 0) throw new AppError(`Line ${i + 1}: debit or credit must be non-zero`, 400)
      if (dr < 0 || cr < 0)  throw new AppError(`Line ${i + 1}: negative amounts not allowed`, 400)
    }

    const voucher = await db('vouchers').where({ id: voucherId, company_id: companyId }).first()
    if (!voucher) throw new AppError('Voucher not found', 404)
    if (voucher.status !== 'POSTED') {
      throw new AppError('Only posted vouchers go through this edit workflow (drafts can be edited directly)', 400)
    }

    const newDate = voucherDate || voucher.voucher_date

    // Respect existing period locks — same DB function the rest of the
    // engine already uses, checked for both the original and new date.
    const datesToCheck = new Set([
      String(voucher.voucher_date).slice(0, 10),
      String(newDate).slice(0, 10),
    ])
    for (const d of datesToCheck) {
      const { rows } = await db.raw(`SELECT is_period_locked(?, ?::date) AS locked`, [companyId, d])
      if (rows[0].locked) throw new AppError(`Cannot edit — the accounting period containing ${d} is locked`, 400)
    }

    // Snapshot BEFORE state for the audit trail.
    const originalLines = await db('voucher_lines').where({ voucher_id: voucherId }).orderBy('line_no')
    const before = {
      voucher_date: voucher.voucher_date,
      party_id:     voucher.party_id,
      narration:    voucher.narration,
      total_amount: voucher.total_amount,
      lines: originalLines.map(l => ({
        account_id: l.account_id, debit: Number(l.debit), credit: Number(l.credit), description: l.description,
      })),
    }

    // The voucher's own metadata (jsonb, parsed to an object by pg) may
    // already carry unrelated business data (e.g. SALES/PURCHASE `items`) —
    // preserve it, only reading/writing the `ledger_correction` sub-key.
    const existingMeta = voucher.metadata || {}

    // Which internal ledger anchor currently holds the *live* journal entry
    // for this voucher? First-ever edit: the voucher's own original entry.
    // Subsequent edits: the anchor created by the previous edit.
    const activeEntryVoucherId = existingMeta.ledger_correction?.active_entry_voucher_id || voucherId

    // ── Step 1 — reverse the currently-live ledger impact (existing,
    //    unmodified engine method). ──────────────────────────────────────────
    const reversal = await PostingEngine.reverse(activeEntryVoucherId, userId, `Correction (edit): ${reason}`, ipAddress)

    // Tag the reversal artifact as internal ledger plumbing so it can never
    // surface as a user-facing voucher — independent of the reversal_of/status
    // heuristic the voucher list also happens to use, so this stays hidden
    // even across several chained edits.
    await db('vouchers').where({ id: reversal.reversal_voucher.id }).update({
      metadata: JSON.stringify({ system_correction: true, corrects_voucher_id: voucherId, internal_only: true, kind: 'edit_reversal' }),
    })

    // ── Step 2 — post the corrected figures to a NEW internal ledger anchor.
    //    This is deliberately NOT VoucherService.create(): no call to
    //    next_voucher_number(), no real user-facing voucher number, and the
    //    row is tagged system_correction so it's excluded from every voucher
    //    list/report query up front. The actual posting — balance check,
    //    period-lock check, account validation, hash chaining — still goes
    //    through the existing, unmodified PostingEngine.postInTransaction(). ──
    let correctionAnchorId
    try {
      correctionAnchorId = await db.transaction(async trx => {
        await db.setRLSContext(trx, companyId)

        const period = await trx('accounting_periods')
          .where({ company_id: companyId })
          .where('start_date', '<=', newDate)
          .where('end_date', '>=', newDate)
          .andWhere('is_locked', false)
          .first()

        const [anchor] = await trx('vouchers').insert({
          company_id:    companyId,
          period_id:     period?.id || null,
          party_id:      partyId !== undefined ? (partyId || null) : voucher.party_id,
          created_by:    userId,
          // Short, internal-only label — never drawn from next_voucher_number(),
          // so it never collides with or consumes a real user-facing sequence
          // number. Traceability back to the edited voucher is via
          // metadata.corrects_voucher_id, not this string, so it only needs
          // to fit the column (`voucher_no` varchar(50)) and stay unique.
          voucher_no:    `SYS-CORR-${crypto.randomUUID()}`,
          voucher_type:  voucher.voucher_type,
          status:        'DRAFT',
          voucher_date:  newDate,
          currency:      voucher.currency || 'NPR',
          exchange_rate: voucher.exchange_rate || 1,
          total_amount:  totalDebit,
          reference_no:  voucher.reference_no,
          narration:     narration !== undefined ? narration : voucher.narration,
          notes:         voucher.notes,
          // Deliberately no `items` carried over here — SALES/PURCHASE
          // strategies only run FIFO/inventory-batch side effects when
          // metadata.items is present, and those already ran once when the
          // voucher was first posted. An edit corrects the accounting entry,
          // it does not re-run inventory movements.
          metadata: JSON.stringify({ system_correction: true, corrects_voucher_id: voucherId, internal_only: true, kind: 'edit_correction' }),
        }).returning('*')

        for (const [i, line] of lines.entries()) {
          const account = await trx('accounts').where({ id: line.account_id, company_id: companyId }).first()
          if (!account) throw new AppError(`Account not found: ${line.account_id}`, 404)
          await trx('voucher_lines').insert({
            voucher_id:  anchor.id,
            account_id:  line.account_id,
            party_id:    line.party_id    || null,
            line_no:     i + 1,
            description: line.description || null,
            debit:       Number(line.debit  || 0),
            credit:      Number(line.credit || 0),
            tax_rate:    Number(line.tax_rate   || 0),
            tax_amount:  Number(line.tax_amount || 0),
          })
        }

        await PostingEngine.postInTransaction({ trx, voucherId: anchor.id, userId, ipAddress, companyId })
        return anchor.id
      })
    } catch (err) {
      // The old entry has already been reversed but the corrected one failed
      // to post — flag this loudly in the audit trail for manual follow-up
      // rather than silently leaving the voucher in an inconsistent state.
      await AuditLogger.log(db, {
        companyId, userId, action: 'EDIT_VOUCHER_FAILED',
        entityType: 'voucher', entityId: voucherId, voucherNo: voucher.voucher_no,
        payloadBefore: before, payloadAfter: { error: err.message, reason },
        ipAddress, isSuspicious: true,
      })
      throw err
    }

    // ── Step 3 — update the SAME voucher row in place: same id, same
    //    voucher_no, still POSTED — this is the voucher the user keeps using. ──
    const updated = await db.transaction(async trx => {
      await trx('voucher_lines').where({ voucher_id: voucherId }).del()
      for (const [i, line] of lines.entries()) {
        const account = await trx('accounts').where({ id: line.account_id, company_id: companyId }).first()
        if (!account) throw new AppError(`Account not found: ${line.account_id}`, 404)
        await trx('voucher_lines').insert({
          voucher_id:  voucherId,
          account_id:  line.account_id,
          party_id:    line.party_id    || null,
          line_no:     i + 1,
          description: line.description || null,
          debit:       Number(line.debit  || 0),
          credit:      Number(line.credit || 0),
          tax_rate:    Number(line.tax_rate   || 0),
          tax_amount:  Number(line.tax_amount || 0),
        })
      }

      const [row] = await trx('vouchers').where({ id: voucherId }).update({
        voucher_date: newDate,
        party_id:     partyId !== undefined ? (partyId || null) : voucher.party_id,
        narration:    narration !== undefined ? narration : voucher.narration,
        total_amount: totalDebit,
        status:       'POSTED',
        metadata: JSON.stringify({
          ...existingMeta,
          ledger_correction: {
            active_entry_voucher_id: correctionAnchorId,
            correction_count: (existingMeta.ledger_correction?.correction_count || 0) + 1,
            last_edited_at: new Date().toISOString(),
          },
        }),
        updated_at:   new Date(),
      }).returning('*')
      return row
    })

    // ── Audit trail — original values, new values, editor, timestamp, reason. ──
    await AuditLogger.log(db, {
      companyId, userId, action: 'EDIT_VOUCHER',
      entityType: 'voucher', entityId: voucherId, voucherNo: voucher.voucher_no,
      payloadBefore: before,
      payloadAfter: {
        voucher_date: newDate, party_id: updated.party_id, narration: updated.narration,
        total_amount: updated.total_amount,
        lines: lines.map(l => ({ account_id: l.account_id, debit: Number(l.debit || 0), credit: Number(l.credit || 0), description: l.description })),
        reason,
      },
      ipAddress,
    })

    return { voucher: updated, correction_voucher_id: correctionAnchorId }
  }

  /** Full edit history for one voucher, read from the append-only audit log. */
  static async history(voucherId, companyId) {
    return db('audit_log as al')
      .leftJoin('users as u', 'al.user_id', 'u.id')
      .where({ 'al.company_id': companyId, 'al.entity_id': voucherId })
      .whereIn('al.action', ['EDIT_VOUCHER', 'EDIT_VOUCHER_FAILED'])
      .select('al.id', 'al.action', 'al.payload_before', 'al.payload_after', 'al.created_at', 'u.name as edited_by_name')
      .orderBy('al.created_at', 'desc')
  }
}

module.exports = VoucherEditService
