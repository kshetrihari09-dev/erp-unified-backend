/**
 * voucherDeleteService.js — "Delete" for POSTED vouchers (Receipt / Payment).
 *
 * A posted voucher is never physically deleted: `journal_entries` is
 * append-only and the books must stay auditable. "Delete" therefore means
 *
 *     reverse the voucher's CURRENT accounting effect
 *   + mark the voucher REVERSED (it keeps its number and id)
 *   + write a DELETE_VOUCHER audit row (with who / why / before-state)
 *
 * all in ONE transaction — if any step fails nothing is changed.
 *
 * It builds on PostingEngine.reverseInTransaction(), which already
 *   - reverses the LIVE entry, i.e. metadata.ledger_correction.active_entry_voucher_id
 *     for a voucher that was edited before (never the superseded original),
 *   - posts an equal-and-opposite journal entry on a REV-… reversal voucher
 *     (dated today, period-lock checked),
 *   - is company-scoped and row-locks the voucher, so a double-click or two
 *     concurrent deletes can only ever succeed once.
 *
 * Read models afterwards: the voucher shows as REVERSED (history kept); party
 * ledger / party balance exclude it (they only count POSTED vouchers); the
 * account ledger shows the original row and its reversal netting to zero;
 * the trial balance is back to where it was before the voucher.
 */
const db            = require('../db/knex')
const PostingEngine = require('../engines/postingEngine')
const VoucherService = require('./voucherService')
const { AppError }  = require('../engines/postingEngine')

class VoucherDeleteService {
  /**
   * @param {object} p
   * @param {string} p.voucherId
   * @param {string} p.companyId     authenticated company — voucher must belong to it
   * @param {string} p.userId
   * @param {string} p.reason        mandatory
   * @param {string} [p.expectedType] 'RECEIPT' | 'PAYMENT' — rejects any other type
   * @param {string} [ipAddress]
   * @returns {Promise<{voucher, lines, journal_entry, journal_lines, accounting, reversal_voucher, reversal_journal_entry, party_id}>}
   */
  static async remove({ voucherId, companyId, userId, reason, expectedType }, ipAddress = null) {
    if (!reason?.trim()) throw new AppError('A reason is required to delete a voucher', 400)

    return db.transaction(async trx => {
      await db.setRLSContext(trx, companyId)

      const voucher = await trx('vouchers').where({ id: voucherId, company_id: companyId }).first()
      if (!voucher) throw new AppError('Voucher not found', 404)
      if (expectedType && voucher.voucher_type !== expectedType) {
        throw new AppError(`This voucher is a ${voucher.voucher_type}, not a ${expectedType}`, 400)
      }
      if (voucher.status === 'REVERSED') throw new AppError('This voucher has already been deleted (reversed)', 409)
      if (voucher.status !== 'POSTED')   throw new AppError('Only posted vouchers can be deleted (drafts can be cancelled)', 400)

      const result = await PostingEngine.reverseInTransaction(trx, {
        voucherId, companyId, userId,
        reason: `Deleted: ${reason.trim()}`,
        ipAddress,
        auditAction: 'DELETE_VOUCHER',
        strictAudit: true,          // no audit row → no delete
        auditExtra: { after: { deleted: true } },
      })

      // Standard voucher-detail shape (REVERSED voucher + its lines + journal info).
      const detail = await VoucherService.get(voucherId, companyId, trx)
      return {
        ...detail,
        reversal_voucher: result.reversal_voucher,
        reversal_journal_entry: result.reversal_journal_entry,
        party_id: voucher.party_id,
      }
    })
  }
}

module.exports = VoucherDeleteService
