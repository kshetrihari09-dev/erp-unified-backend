/**
 * voucherEditService.js — Password-protected editing of POSTED vouchers.
 *
 * Why this is "reverse + repost" and not an UPDATE
 * ------------------------------------------------
 * `journal_entries` is append-only (trigger-enforced: no UPDATE/DELETE) and
 * has a UNIQUE constraint on `voucher_id` (one ledger entry per voucher,
 * forever). The only accounting-correct way to change a POSTED voucher's
 * financial impact without touching the schema is the standard
 * immutable-ledger pattern:
 *
 *     reverse the LIVE entry   +   post the corrected entry
 *
 * The corrected entry is posted against a bare internal "ledger anchor"
 * voucher (`SYS-CORR-…`, metadata.system_correction = true) because the
 * visible voucher's own journal slot is already taken. The anchor never
 * draws from next_voucher_number(), is excluded from every user-facing
 * list/report, and is posted by the existing PostingEngine.postInTransaction()
 * (balance, period-lock, account validation and hash chaining unchanged).
 *
 * The visible voucher keeps its id, voucher_no and POSTED status; its
 * header, lines and metadata are updated in place.
 *
 * Which table is the source of truth after an edit?
 *   - vouchers / voucher_lines  → the CURRENT visible voucher (always in step)
 *   - vouchers.metadata.ledger_correction.active_entry_voucher_id
 *                               → which anchor owns the CURRENT journal entry
 *   - journal_entries/lines     → immutable history; only the entry owned by
 *                                 the active anchor (or the voucher itself,
 *                                 if never edited) is "current". Everything
 *                                 else is superseded and nets to zero with
 *                                 its reversal. See services/currentEntry.js.
 *
 * Atomicity
 * ---------
 * The ENTIRE edit — reverse live entry, create anchor, post correction,
 * rewrite voucher_lines, update the voucher + metadata, write the audit row
 * — runs in ONE database transaction, with the voucher row locked
 * (SELECT … FOR UPDATE) so concurrent edits/reversals of the same voucher
 * serialise. Any failure rolls all of it back: you can never end up with
 * "voucher = new amount, ledger = old amount" (or the reverse).
 *
 * Repeated edits: each edit reverses `active_entry_voucher_id` (the previous
 * edit's anchor), never blindly the original entry, so corrections never
 * accumulate.
 *
 * Audit trail: the existing append-only `audit_log` (EDIT_VOUCHER), written
 * with AuditLogger.logStrict() INSIDE the transaction — no audit row, no
 * edit. A failed attempt additionally records EDIT_VOUCHER_FAILED after the
 * rollback. The "Edited" badge remains a computed EXISTS against audit_log.
 */
const crypto         = require('crypto')
const db             = require('../db/knex')
const AuditLogger    = require('../utils/auditLogger')
const PostingEngine  = require('../engines/postingEngine')
const VoucherService = require('./voucherService')
const { activeEntryVoucherId, parseMeta } = require('./currentEntry')
const { isValidDateOnly } = require('../utils/dateOnly')
const { AppError }   = require('../engines/postingEngine')

class VoucherEditService {
  /**
   * @param {object} params
   * @param {string} params.voucherId
   * @param {string} params.companyId
   * @param {string} params.userId      - editor (already step-up confirmed by the route)
   * @param {string} params.reason      - mandatory edit reason, goes into the audit trail
   * @param {string} [params.voucherDate]  'YYYY-MM-DD'
   * @param {string|null} [params.partyId]
   * @param {string} [params.narration]
   * @param {Array}  params.lines       - corrected lines, same shape as VoucherService.create()
   * @param {string} [params.expectedType] - e.g. 'RECEIPT'; rejects editing a voucher of another type
   * @param {string} [ipAddress]
   * @returns {Promise<{voucher, lines, journal_entry, journal_lines, accounting, correction_voucher_id, previous_party_id}>}
   */
  static async edit({ voucherId, companyId, userId, reason, voucherDate, partyId, narration, lines, expectedType }, ipAddress = null) {
    if (!reason?.trim()) throw new AppError('An edit reason is required', 400)
    if (!Array.isArray(lines) || lines.length < 2) throw new AppError('A voucher requires at least 2 lines', 400)
    if (voucherDate !== undefined && voucherDate !== null && !isValidDateOnly(voucherDate)) {
      throw new AppError('Invalid voucher date', 400)
    }

    // ── Double-entry validation on the corrected lines ──────────────────────
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

    // Captured for the failure audit entry written after a rollback.
    let before = null
    let voucherNoForAudit = null
    let financialPhase = false

    try {
      return await db.transaction(async trx => {
        await db.setRLSContext(trx, companyId)

        // Lock the visible voucher row: concurrent edits / reversals of the
        // SAME voucher queue up here, so each one sees the previous one's
        // result (and its active_entry_voucher_id) instead of racing it.
        const voucher = await trx('vouchers').where({ id: voucherId, company_id: companyId }).forUpdate().first()
        if (!voucher) throw new AppError('Voucher not found', 404)
        if (expectedType && voucher.voucher_type !== expectedType) {
          throw new AppError(`This voucher is a ${voucher.voucher_type}, not a ${expectedType}`, 400)
        }
        if (voucher.status !== 'POSTED') {
          throw new AppError('Only posted vouchers go through this edit workflow (drafts can be edited directly)', 400)
        }
        if (partyId) {
          const party = await trx('parties').where({ id: partyId, company_id: companyId }).first('id')
          if (!party) throw new AppError('Party not found', 404)
        }
        voucherNoForAudit = voucher.voucher_no

        const newDate = voucherDate || String(voucher.voucher_date).slice(0, 10)
        const newPartyId = partyId !== undefined ? (partyId || null) : voucher.party_id
        const newNarration = narration !== undefined ? narration : voucher.narration

        // Respect period locks for both the original and the new date.
        for (const d of new Set([String(voucher.voucher_date).slice(0, 10), newDate])) {
          const { rows } = await trx.raw(`SELECT is_period_locked(?, ?::date) AS locked`, [companyId, d])
          if (rows[0].locked) throw new AppError(`Cannot edit — the accounting period containing ${d} is locked`, 400)
        }

        // Validate every account up-front, before anything is written.
        for (const line of lines) {
          const account = await trx('accounts').where({ id: line.account_id, company_id: companyId }).first('id')
          if (!account) throw new AppError(`Account not found: ${line.account_id}`, 404)
        }

        // Snapshot BEFORE state for the audit trail.
        const originalLines = await trx('voucher_lines').where({ voucher_id: voucherId }).orderBy('line_no')
        before = {
          voucher_date: voucher.voucher_date,
          party_id:     voucher.party_id,
          narration:    voucher.narration,
          total_amount: voucher.total_amount,
          lines: originalLines.map(l => ({
            account_id: l.account_id, debit: Number(l.debit), credit: Number(l.credit), description: l.description,
          })),
        }

        const existingMeta = parseMeta(voucher.metadata)
        const activeBefore = activeEntryVoucherId(voucher)
        financialPhase = true

        // ── 1. Reverse the LIVE entry (original, or previous edit's anchor). ──
        const reversal = await PostingEngine.reverseForCorrection({
          trx, voucher, userId, reason: `Correction (edit): ${reason}`, ipAddress,
        })

        // ── 2. Post the corrected figures to a NEW internal anchor. ──────────
        const period = await trx('accounting_periods')
          .where({ company_id: companyId })
          .where('start_date', '<=', newDate)
          .where('end_date', '>=', newDate)
          .andWhere('is_locked', false)
          .first()

        const [anchor] = await trx('vouchers').insert({
          company_id:    companyId,
          period_id:     period?.id || null,
          party_id:      newPartyId,
          created_by:    userId,
          // Internal label only — never drawn from next_voucher_number().
          voucher_no:    `SYS-CORR-${crypto.randomUUID()}`,
          voucher_type:  voucher.voucher_type,
          status:        'DRAFT',
          voucher_date:  newDate,
          currency:      voucher.currency || 'NPR',
          exchange_rate: voucher.exchange_rate || 1,
          total_amount:  totalDebit,
          reference_no:  voucher.reference_no,
          narration:     newNarration,
          notes:         voucher.notes,
          // No `items` carried over: SALES/PURCHASE strategies would re-run
          // inventory side effects. An edit corrects the accounting entry
          // only; it never re-runs stock movements.
          metadata: JSON.stringify({ system_correction: true, corrects_voucher_id: voucherId, internal_only: true, kind: 'edit_correction' }),
        }).returning('*')

        const lineRows = (ownerId) => lines.map((line, i) => ({
          voucher_id:  ownerId,
          account_id:  line.account_id,
          party_id:    line.party_id    || null,
          line_no:     i + 1,
          description: line.description || null,
          debit:       Number(line.debit  || 0),
          credit:      Number(line.credit || 0),
          tax_rate:    Number(line.tax_rate   || 0),
          tax_amount:  Number(line.tax_amount || 0),
        }))
        await trx('voucher_lines').insert(lineRows(anchor.id))

        await PostingEngine.postInTransaction({ trx, voucherId: anchor.id, userId, ipAddress, companyId })

        // ── 3. Update the SAME visible voucher in place. ─────────────────────
        await trx('voucher_lines').where({ voucher_id: voucherId }).del()
        await trx('voucher_lines').insert(lineRows(voucherId))

        const priorSuperseded = existingMeta.ledger_correction?.superseded_entry_voucher_ids || []
        const [updated] = await trx('vouchers').where({ id: voucherId }).update({
          voucher_date: newDate,
          party_id:     newPartyId,
          narration:    newNarration,
          total_amount: totalDebit,
          status:       'POSTED',
          period_ref:   newDate.slice(0, 7),
          period_id:    period?.id || null,
          metadata: JSON.stringify({
            ...existingMeta,
            ledger_correction: {
              active_entry_voucher_id: anchor.id,
              correction_count: (existingMeta.ledger_correction?.correction_count || 0) + 1,
              last_edited_at: new Date().toISOString(),
              superseded_entry_voucher_ids: [...priorSuperseded, activeBefore],
            },
          }),
          updated_at:   new Date(),
        }).returning('*')

        // ── 4. Audit row — part of the transaction: no audit row, no edit. ───
        await AuditLogger.logStrict(trx, {
          companyId, userId, action: 'EDIT_VOUCHER',
          entityType: 'voucher', entityId: voucherId, voucherNo: voucher.voucher_no,
          payloadBefore: before,
          payloadAfter: {
            voucher_date: newDate, party_id: updated.party_id, narration: updated.narration,
            total_amount: updated.total_amount,
            lines: lines.map(l => ({ account_id: l.account_id, debit: Number(l.debit || 0), credit: Number(l.credit || 0), description: l.description })),
            reason,
            reversed_entry_voucher_id: reversal.reversed_entry_voucher_id,
            active_entry_voucher_id: anchor.id,
          },
          ipAddress,
        })

        // Read the result back INSIDE the transaction: what the caller gets
        // is exactly what was committed, including the CURRENT journal entry.
        const fresh = await VoucherService.get(voucherId, companyId, trx)
        return {
          ...fresh,
          correction_voucher_id: anchor.id,
          previous_party_id: before.party_id,
        }
      })
    } catch (err) {
      // The transaction has rolled back — nothing financial changed. Leave a
      // forensic trace of the failed attempt (outside the rolled-back trx).
      if (financialPhase) {
        await AuditLogger.log(db, {
          companyId, userId, action: 'EDIT_VOUCHER_FAILED',
          entityType: 'voucher', entityId: voucherId, voucherNo: voucherNoForAudit,
          payloadBefore: before, payloadAfter: { error: err.message, reason, rolled_back: true },
          ipAddress, isSuspicious: true,
        })
      }
      throw err
    }
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
