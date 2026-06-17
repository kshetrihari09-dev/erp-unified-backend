/**
 * AccountingIntegration — The Bridge Between Operations and Accounting
 *
 * This service is the single integration point for all operational modules
 * (Sales, Purchase, Receives, Returns, Banking) to create vouchers and
 * post them through PostingEngine.
 *
 * Architecture:
 *
 *   [Sales Route]        ──┐
 *   [Purchases Route]    ──┤
 *   [Receives Route]     ──┤──► AccountingIntegration ──► VoucherService.create()
 *   [Returns Route]      ──┤                          ──► PostingEngine.post()
 *   [Banking Route]      ──┘                          ──► voucher_postings record
 *
 * Rules:
 *   - Always runs inside the caller's transaction (trx passed in)
 *   - Never commits or rolls back — caller owns the transaction
 *   - On accounting failure, the entire caller transaction rolls back
 *     (because we're in the same trx — no orphaned operational records)
 *   - Idempotent: if a voucher already exists for the source, skips creation
 *   - Posting failure is non-fatal if `failSilently=true` (for legacy mode)
 *
 * Usage in routes:
 *
 *   const trx = await db.transaction()
 *   try {
 *     const [sale] = await trx('sales').insert({...}).returning('*')
 *     // ... insert items, FIFO deduction ...
 *
 *     await AccountingIntegration.postSale({ sale, items, trx, companyId, userId, ipAddress })
 *
 *     await trx.commit()
 *     res.json({ success: true, sale })
 *   } catch (err) {
 *     await trx.rollback()
 *     next(err)
 *   }
 */

const VoucherService  = require('./voucherService')
const PostingEngine   = require('../engines/postingEngine')
const VoucherBuilder  = require('./voucherBuilder')
const AuditLogger     = require('../utils/auditLogger')

// ─── Internal Helper ──────────────────────────────────────────────────────────

/**
 * Core integration function.
 * Builds a voucher payload, creates the voucher+lines via VoucherService,
 * posts it via PostingEngine, and records the cross-reference.
 *
 * @param {object} opts
 * @param {object}   opts.trx            — active Knex transaction
 * @param {string}   opts.companyId
 * @param {string}   opts.userId
 * @param {string}   opts.ipAddress
 * @param {string}   opts.sourceType     — 'SALE'|'PURCHASE'|'RECEIVE'|etc.
 * @param {string}   opts.sourceId       — UUID of the source record
 * @param {string}   opts.sourceRef      — human-readable ref (invoice_no / bill_no)
 * @param {object}   opts.voucherPayload — from VoucherBuilder.buildXxx()
 * @param {boolean}  [opts.failSilently] — if true, accounting errors only warn (legacy mode)
 * @returns {{ voucher, journal_entry }}
 */
async function _integrate({ trx, companyId, userId, ipAddress, sourceType, sourceId, sourceRef, voucherPayload, failSilently = false }) {
  try {
    // 1. Check idempotency — has this source already been posted?
    const existing = await trx('voucher_postings')
      .where({ company_id: companyId, source_type: sourceType })
      .where(function () {
        this.where('sale_id', sourceId)
            .orWhere('purchase_id', sourceId)
            .orWhere('receive_id', sourceId)
      })
      .first()

    if (existing) {
      // Already integrated — return existing voucher (idempotent)
      const voucher = await trx('vouchers').where({ id: existing.voucher_id }).first()
      const je      = await trx('journal_entries').where({ voucher_id: existing.voucher_id }).first()
      return { voucher, journal_entry: je, alreadyPosted: true }
    }

    // 2. Create the voucher and its lines (inside the same trx)
    const { voucher } = await VoucherService.createInTransaction({
      trx,
      ...voucherPayload,
    })

    // 3. Update the source record's voucher_id FK (if the table has the column)
    await _linkSourceToVoucher(trx, sourceType, sourceId, voucher.id)

    // 4. Post the voucher via PostingEngine (inside same trx)
    const postResult = await PostingEngine.postInTransaction({
      trx,
      voucherId: voucher.id,
      userId,
      ipAddress,
      companyId,
    })

    // 5. Record the cross-reference
    await trx('voucher_postings').insert({
      company_id:  companyId,
      voucher_id:  voucher.id,
      source_type: sourceType,
      source_ref:  sourceRef || null,
      ...sourceIdColumn(sourceType, sourceId),
      posted_at:   new Date(),
    })

    return { voucher, journal_entry: postResult.journal_entry }

  } catch (err) {
    if (failSilently) {
      // Legacy mode: log the failure but don't crash the sale/purchase save
      console.error(`[AccountingIntegration] Non-fatal accounting failure for ${sourceType} ${sourceId}:`, err.message)
      return { voucher: null, journal_entry: null, accountingError: err.message }
    }
    // Default: re-throw so the caller's transaction rolls back entirely
    throw err
  }
}

/**
 * Map sourceType to the correct FK column in voucher_postings.
 */
function sourceIdColumn(sourceType, sourceId) {
  const map = {
    SALE:             { sale_id: sourceId },
    PURCHASE:         { purchase_id: sourceId },
    RECEIVE:          { receive_id: sourceId },
    SALE_RETURN:      { sale_id: sourceId },
    PURCHASE_RETURN:  { purchase_id: sourceId },
    PAYMENT:          {},   // voucher_id is the identifier; no separate source table
    RECEIPT:          {},   // voucher_id is the identifier; no separate source table
  }
  return map[sourceType] || {}
}

/**
 * Update the source record's voucher_id FK.
 * Uses a try/catch so missing columns on older tables are non-fatal.
 */
async function _linkSourceToVoucher(trx, sourceType, sourceId, voucherId) {
  const tableMap = {
    SALE:            { table: 'sales',     idCol: 'id' },
    PURCHASE:        { table: 'purchases', idCol: 'id' },
    RECEIVE:         { table: 'receives',  idCol: 'id' },
    SALE_RETURN:     { table: 'sales',     idCol: 'id' },
    PURCHASE_RETURN: { table: 'purchases', idCol: 'id' },
  }
  const meta = tableMap[sourceType]
  if (!meta) return
  try {
    await trx(meta.table).where({ id: sourceId }).update({ voucher_id: voucherId })
  } catch {
    // Column may not exist on older schema — non-fatal
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const AccountingIntegration = {

  /**
   * Post accounting entries for a completed sale.
   * Call this after the sale record and sale_items are inserted
   * but BEFORE committing the transaction.
   */
  async postSale({ sale, items, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildSaleVoucher({
      sale, items, trx, companyId, userId,
    })
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'SALE',
      sourceId:   sale.id,
      sourceRef:  sale.invoice_no,
      voucherPayload,
    })
  },

  /**
   * Post accounting entries for a completed purchase.
   * NOTE: inventory_batches and inventory_movements are created by
   * PurchaseStrategy inside PostingEngine (via metadata.items).
   * The purchases route should NOT insert inventory_batches itself
   * when using full accounting integration mode.
   */
  async postPurchase({ purchase, items, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildPurchaseVoucher({
      purchase, items, trx, companyId, userId,
    })
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'PURCHASE',
      sourceId:   purchase.id,
      sourceRef:  purchase.bill_no,
      voucherPayload,
    })
  },

  /**
   * Post accounting entries for a stock receive.
   */
  async postReceive({ receive, items, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildReceiveVoucher({
      receive, items, trx, companyId, userId,
    })
    if (!voucherPayload) return { voucher: null, journal_entry: null }  // zero-value receive
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'RECEIVE',
      sourceId:   receive.id,
      sourceRef:  null,
      voucherPayload,
    })
  },

  /**
   * Post accounting entries for a sales return.
   */
  async postSaleReturn({ originalSale, returnItems, returnDate, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildSaleReturnVoucher({
      originalSale, returnItems, returnDate, trx, companyId, userId,
    })
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'SALE_RETURN',
      sourceId:   originalSale.id,
      sourceRef:  originalSale.invoice_no,
      voucherPayload,
    })
  },

  /**
   * Post accounting entries for a purchase return.
   */
  async postPurchaseReturn({ originalPurchase, returnItems, returnDate, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildPurchaseReturnVoucher({
      originalPurchase, returnItems, returnDate, trx, companyId, userId,
    })
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'PURCHASE_RETURN',
      sourceId:   originalPurchase.id,
      sourceRef:  originalPurchase.bill_no,
      voucherPayload,
    })
  },

  /**
   * Post a supplier payment voucher.
   */
  async postPayment({ partyId, amount, paymentMode, paymentDate, narration, referenceNo, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildPaymentVoucher({
      partyId, amount, paymentMode, paymentDate, narration, referenceNo, trx, companyId, userId,
    })
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'PAYMENT',
      sourceId:   partyId || 'manual',
      sourceRef:  referenceNo,
      voucherPayload,
      failSilently: false,
    })
  },

  /**
   * Post a customer receipt voucher.
   */
  async postReceipt({ partyId, amount, paymentMode, receiptDate, narration, referenceNo, trx, companyId, userId, ipAddress }) {
    const voucherPayload = await VoucherBuilder.buildReceiptVoucher({
      partyId, amount, paymentMode, receiptDate, narration, referenceNo, trx, companyId, userId,
    })
    return _integrate({
      trx, companyId, userId, ipAddress,
      sourceType: 'RECEIPT',
      sourceId:   partyId || 'manual',
      sourceRef:  referenceNo,
      voucherPayload,
      failSilently: false,
    })
  },

  /**
   * Check whether a source record has already been posted.
   * Useful in route handlers for idempotency checks.
   */
  async isPosted(db, companyId, sourceType, sourceId) {
    // PAYMENT and RECEIPT have no dedicated source table — the voucher IS the
    // source record, so we look up directly by voucher_id.
    if (sourceType === 'PAYMENT' || sourceType === 'RECEIPT') {
      const existing = await db('voucher_postings')
        .where({ company_id: companyId, source_type: sourceType, voucher_id: sourceId })
        .first()
      return !!existing
    }
    const existing = await db('voucher_postings')
      .where({ company_id: companyId, source_type: sourceType })
      .where(function () {
        this.where('sale_id', sourceId)
            .orWhere('purchase_id', sourceId)
            .orWhere('receive_id', sourceId)
      })
      .first()
    return !!existing
  },

  /**
   * Get the voucher and journal entry for a given source record.
   */
  async getAccountingRecord(db, companyId, sourceType, sourceId) {
    const posting = await db('voucher_postings as vp')
      .join('vouchers as v', 'vp.voucher_id', 'v.id')
      .leftJoin('journal_entries as je', 'v.id', 'je.voucher_id')
      .where('vp.company_id', companyId)
      .where('vp.source_type', sourceType)
      .where(function () {
        if (sourceType === 'PAYMENT' || sourceType === 'RECEIPT') {
          this.where('vp.voucher_id', sourceId)
        } else {
          this.where('vp.sale_id', sourceId)
              .orWhere('vp.purchase_id', sourceId)
              .orWhere('vp.receive_id', sourceId)
        }
      })
      .select('v.*', 'je.id as journal_entry_id', 'je.entry_hash', 'je.total_debit', 'je.total_credit')
      .first()
    return posting || null
  },
}

module.exports = AccountingIntegration
