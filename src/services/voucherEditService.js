/**
 * voucherEditService.js — Password-protected editing of POSTED vouchers.
 *
 * Design note — why this doesn't touch postingEngine.js:
 * `journal_entries` is append-only (trigger-enforced: no UPDATE/DELETE) and has
 * a UNIQUE constraint on `voucher_id` (one ledger entry per voucher, forever).
 * That means the one and only accounting-correct way to change a POSTED
 * voucher's *financial* impact — without touching the schema or the posting
 * engine — is the standard immutable-ledger pattern: reverse the old entry,
 * then post a corrected one. This service does exactly that by calling the
 * EXISTING, unmodified `PostingEngine.reverse()` and `VoucherService.create()`
 * + `PostingEngine.post()` — nothing about how journal entries are built,
 * balanced, hashed or chained is changed here.
 *
 * From the user's point of view the voucher they opened is the one that gets
 * updated: same `id`, same `voucher_no`, same row — its date/party/narration/
 * lines are updated in place and it stays `POSTED`. The reversal + correction
 * entries this generates internally are tagged `metadata.system_correction`
 * so voucher lists (VoucherService.list / receipts / payments) filter them
 * out — they're bookkeeping plumbing, not new user-facing vouchers.
 *
 * Audit trail uses the existing append-only `audit_log` table (via
 * AuditLogger — untouched), so no new tables/columns are needed. The
 * "Edited" badge is a computed `is_edited` flag (EXISTS against audit_log),
 * added as an additive column in VoucherService.list()/get().
 */
const db             = require('../db/knex')
const AuditLogger    = require('../utils/auditLogger')
const PostingEngine  = require('../engines/postingEngine')
const { AppError }   = require('../engines/postingEngine')
const VoucherService = require('./voucherService')

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

    const voucher = await db('vouchers').where({ id: voucherId, company_id: companyId }).first()
    if (!voucher) throw new AppError('Voucher not found', 404)
    if (voucher.status !== 'POSTED') {
      throw new AppError('Only posted vouchers go through this edit workflow (drafts can be edited directly)', 400)
    }

    const newDate = voucherDate || voucher.voucher_date

    // Respect existing period locks — same DB function the rest of the
    // engine already uses, checked for both the original and new date.
    const datesToCheck = new Set([
      new Date(voucher.voucher_date).toISOString().slice(0, 10),
      new Date(newDate).toISOString().slice(0, 10),
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

    const totalDebit = lines.reduce((s, l) => s + Number(l.debit || 0), 0)

    // ── Step 1 — reverse the old ledger impact (existing, unmodified engine) ──
    await PostingEngine.reverse(voucherId, userId, `Correction (edit): ${reason}`, ipAddress)

    // ── Step 2 — post the corrected figures as a system-linked correction
    //    voucher, using the existing, unmodified create + post pipeline. ──
    let correctionVoucher
    try {
      const created = await VoucherService.create({
        companyId, userId,
        voucherType: voucher.voucher_type,
        voucherDate: newDate,
        partyId:     partyId !== undefined ? partyId : voucher.party_id,
        lines,
        narration:   narration !== undefined ? narration : voucher.narration,
        referenceNo: voucher.reference_no,
        notes:       voucher.notes,
        metadata:    { system_correction: true, corrects_voucher_id: voucherId },
        currency:    voucher.currency,
      }, ipAddress)
      correctionVoucher = created.voucher
      await PostingEngine.post(correctionVoucher.id, userId, ipAddress)
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

    return { voucher: updated, correction_voucher_id: correctionVoucher.id }
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
