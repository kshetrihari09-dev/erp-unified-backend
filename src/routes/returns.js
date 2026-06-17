/**
 * returns.js — Fully integrated with PostingEngine
 *
 * Every return now creates a proper accounting voucher via AccountingIntegration:
 *   Sales Return   → CREDIT_NOTE voucher → restores inventory + reverses revenue
 *   Purchase Return → DEBIT_NOTE voucher → removes inventory + reduces payable
 *
 * Changes from previous version:
 *   - Added AccountingIntegration.postSaleReturn() in POST /returns/sales
 *   - Added AccountingIntegration.postPurchaseReturn() in POST /returns/purchase
 *   - Both run inside the same transaction as the inventory adjustment
 *   - GET /returns now includes voucher and journal_entry data in response
 *   - Added GET /returns/:id to fetch a single return with full accounting detail
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { adToBS, todayBS, auditLog } = require('../utils/helpers')
const AccountingIntegration = require('../services/accountingIntegration')

router.use(authenticate)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /returns ─────────────────────────────────────────────────────────────
 * Lists sale and purchase returns stored as CREDIT_NOTE / DEBIT_NOTE vouchers.
 * Includes journal_entry_id so the UI can link to the ledger entry.
 * ──────────────────────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { type } = req.query  // 'sales' | 'purchase'

    const typeFilter = type === 'sales'
      ? ['CREDIT_NOTE']
      : type === 'purchase'
        ? ['DEBIT_NOTE']
        : ['CREDIT_NOTE', 'DEBIT_NOTE']

    const [{ count }] = await db('vouchers as v')
      .where('v.company_id', req.companyId)
      .whereIn('v.voucher_type', typeFilter)
      .count('v.id as count')

    const data = await db('vouchers as v')
      .leftJoin('parties as p', 'v.party_id', 'p.id')
      .leftJoin('journal_entries as je', 'v.id', 'je.voucher_id')
      .where('v.company_id', req.companyId)
      .whereIn('v.voucher_type', typeFilter)
      .select(
        'v.id', 'v.voucher_no', 'v.voucher_type', 'v.voucher_date',
        'v.narration', 'v.total_amount', 'v.status', 'v.reference_no',
        'v.created_at',
        'p.name as party_name',
        'je.id as journal_entry_id', 'je.total_debit',
      )
      .orderBy('v.voucher_date', 'desc')
      .limit(limit)
      .offset(offset)

    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /returns/:id ────────────────────────────────────────────────────────
 * Fetch a single return with its voucher lines and journal entry.
 * ──────────────────────────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const voucher = await db('vouchers as v')
      .leftJoin('parties as p', 'v.party_id', 'p.id')
      .where('v.id', req.params.id)
      .andWhere('v.company_id', req.companyId)
      .whereIn('v.voucher_type', ['CREDIT_NOTE', 'DEBIT_NOTE'])
      .select('v.*', 'p.name as party_name')
      .first()

    if (!voucher) return res.status(404).json({ success: false, message: 'Return not found' })

    const lines = await db('voucher_lines as vl')
      .leftJoin('accounts as a', 'vl.account_id', 'a.id')
      .where('vl.voucher_id', voucher.id)
      .select('vl.*', 'a.name as account_name', 'a.code as account_code')
      .orderBy('vl.line_no')

    const journalEntry = await db('journal_entries').where({ voucher_id: voucher.id }).first()

    return successResponse(res, { ...voucher, lines, journal_entry: journalEntry || null })
  } catch (err) { next(err) }
})

/* ── POST /returns/sales ──────────────────────────────────────────────────────
 * Record a sales return (customer returns goods).
 *
 * Inventory: re-inserts into inventory_batches (goods come back in).
 * Accounting: creates CREDIT_NOTE voucher → DR Sales Revenue / CR Cash/Receivable.
 *
 * Request body:
 *   { sale_id, party_id, items: [{ product_id, qty, rate, batch_no, expiry }],
 *     narration, date_ad }
 * ──────────────────────────────────────────────────────────────────────────── */
router.post('/sales', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { sale_id, party_id, items, narration, date_ad } = req.body
    if (!items?.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'Items required' })
    }

    const date    = date_ad || new Date().toISOString().split('T')[0]
    const date_bs = adToBS(date) || todayBS()
    let   total   = 0

    // ── Validate and load original sale if provided ──────────────────────────
    let originalSale = null
    if (sale_id) {
      originalSale = await trx('sales')
        .where({ id: sale_id, company_id: req.companyId })
        .first()
      if (!originalSale) {
        await trx.rollback()
        return res.status(404).json({ success: false, message: 'Original sale not found' })
      }
      if (originalSale.status === 'cancelled') {
        await trx.rollback()
        return res.status(400).json({ success: false, message: 'Cannot return items from a cancelled sale' })
      }
    }

    const returnItems = []
    for (const item of items) {
      const qty  = Number(item.qty)  || 0
      const rate = Number(item.rate) || 0
      if (qty <= 0) continue
      total += qty * rate
      returnItems.push({ ...item, qty, rate })

      // Re-add stock to inventory (customer returns goods)
      if (item.product_id) {
        await trx(T).insert({
          company_id:    req.companyId,
          product_id:    item.product_id,
          batch_no:      item.batch_no  || 'RETURN',
          expiry:        item.expiry    || null,
          expiry_date:   parseExpiryToDate(item.expiry),
          receipt_date:  date,
          qty_received:  qty,
          qty_remaining: qty,
          unit_cost:     rate,
          total_cost:    Math.round(qty * rate * 100) / 100,
        })
      }
    }

    if (returnItems.length === 0) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'No valid items to return' })
    }

    total = Math.round(total * 100) / 100

    // ── Accounting: CREDIT_NOTE via PostingEngine ────────────────────────────
    // Use the original sale for account resolution (payment_mode, party).
    // If no original sale was provided, create a synthetic one from the request.
    const saleForAccounting = originalSale || {
      id:           sale_id || `return-${Date.now()}`,
      invoice_no:   sale_id ? `unknown` : `MANUAL`,
      payment_mode: req.body.payment_mode || 'cash',
      party_id:     party_id || null,
    }

    let accountingResult = null
    try {
      accountingResult = await AccountingIntegration.postSaleReturn({
        originalSale:  saleForAccounting,
        returnItems:   returnItems.map(i => ({ product_id: i.product_id, qty: i.qty, rate: i.rate })),
        returnDate:    date,
        trx,
        companyId:     req.companyId,
        userId:        req.user.id,
        ipAddress:     req.ip,
      })
    } catch (acctErr) {
      if (acctErr.status === 422) {
        console.warn(`[ACCOUNTING] COA not configured — sale return saved without journal. ${acctErr.message}`)
        accountingResult = { voucher: null, journal_entry: null, accountingError: acctErr.message }
      } else {
        await trx.rollback()
        return res.status(acctErr.status || 400).json({ success: false, message: acctErr.message })
      }
    }

    await trx.commit()

    auditLog(
      req.companyId, req.user.id, 'SALE_RETURN', 'sales',
      sale_id || null,
      { total, items: returnItems.length, voucher_no: accountingResult?.voucher?.voucher_no },
      req.ip,
    )

    return successResponse(res, {
      type:     'sale_return',
      total,
      date_ad:  date,
      date_bs,
      narration,
      sale_id:  sale_id || null,
      items:    returnItems,
      accounting: accountingResult?.journal_entry
        ? { voucher_no: accountingResult.voucher?.voucher_no, journal_entry_id: accountingResult.journal_entry?.id }
        : { status: 'pending_coa', note: accountingResult?.accountingError || 'Chart of Accounts not configured' },
    }, 'Sales return recorded', 201)

  } catch (err) { await trx.rollback(); next(err) }
})

/* ── POST /returns/purchase ───────────────────────────────────────────────────
 * Record a purchase return (returning goods to supplier).
 *
 * Inventory: deducts from existing inventory_batches (goods leave warehouse).
 * Accounting: creates DEBIT_NOTE voucher → DR Accounts Payable / CR Inventory.
 *
 * Request body:
 *   { purchase_id, party_id, items: [{ product_id, qty, rate, batch_no }],
 *     narration, date_ad }
 * ──────────────────────────────────────────────────────────────────────────── */
router.post('/purchase', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { purchase_id, party_id, items, narration, date_ad } = req.body
    if (!items?.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'Items required' })
    }

    const date    = date_ad || new Date().toISOString().split('T')[0]
    const date_bs = adToBS(date) || todayBS()
    let   total   = 0

    // ── Validate and load original purchase if provided ──────────────────────
    let originalPurchase = null
    if (purchase_id) {
      originalPurchase = await trx('purchases')
        .where({ id: purchase_id, company_id: req.companyId })
        .first()
      if (!originalPurchase) {
        await trx.rollback()
        return res.status(404).json({ success: false, message: 'Original purchase not found' })
      }
      if (originalPurchase.status === 'cancelled') {
        await trx.rollback()
        return res.status(400).json({ success: false, message: 'Cannot return items from a cancelled purchase' })
      }
    }

    const returnItems = []
    for (const item of items) {
      const qty  = Number(item.qty)  || 0
      const rate = Number(item.rate) || 0
      if (qty <= 0) continue
      total += qty * rate
      returnItems.push({ ...item, qty, rate })

      // Deduct stock from inventory (goods go back to supplier)
      if (item.product_id) {
        const batch = await trx(T)
          .where({ product_id: item.product_id, company_id: req.companyId })
          .where(QTY, '>', 0)
          .orderBy('created_at', 'desc')
          .first()

        if (batch) {
          await trx(T).where({ id: batch.id }).update({
            [QTY]: Math.max(0, Number(batch[QTY]) - qty),
          })
        }
        // Record outbound movement
        await trx('inventory_movements').insert({
          company_id:    req.companyId,
          product_id:    item.product_id,
          batch_id:      batch?.id || null,
          movement_type: 'OUT',
          qty,
          unit_cost:     rate,
          total_cost:    Math.round(qty * rate * 100) / 100,
          movement_date: date,
          description:   `Purchase Return — ${originalPurchase?.bill_no || 'manual'}`,
        }).catch(() => { /* inventory_movements insert is best-effort */ })
      }
    }

    if (returnItems.length === 0) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'No valid items to return' })
    }

    total = Math.round(total * 100) / 100

    // ── Accounting: DEBIT_NOTE via PostingEngine ─────────────────────────────
    const purchaseForAccounting = originalPurchase || {
      id:       purchase_id || `return-${Date.now()}`,
      bill_no:  purchase_id ? 'unknown' : 'MANUAL',
      party_id: party_id || null,
    }

    let accountingResult = null
    try {
      accountingResult = await AccountingIntegration.postPurchaseReturn({
        originalPurchase: purchaseForAccounting,
        returnItems:      returnItems.map(i => ({ product_id: i.product_id, qty: i.qty, rate: i.rate })),
        returnDate:       date,
        trx,
        companyId:        req.companyId,
        userId:           req.user.id,
        ipAddress:        req.ip,
      })
    } catch (acctErr) {
      if (acctErr.status === 422) {
        console.warn(`[ACCOUNTING] COA not configured — purchase return saved without journal. ${acctErr.message}`)
        accountingResult = { voucher: null, journal_entry: null, accountingError: acctErr.message }
      } else {
        await trx.rollback()
        return res.status(acctErr.status || 400).json({ success: false, message: acctErr.message })
      }
    }

    await trx.commit()

    auditLog(
      req.companyId, req.user.id, 'PURCHASE_RETURN', 'purchases',
      purchase_id || null,
      { total, items: returnItems.length, voucher_no: accountingResult?.voucher?.voucher_no },
      req.ip,
    )

    return successResponse(res, {
      type:        'purchase_return',
      total,
      date_ad:     date,
      date_bs,
      narration,
      purchase_id: purchase_id || null,
      items:       returnItems,
      accounting: accountingResult?.journal_entry
        ? { voucher_no: accountingResult.voucher?.voucher_no, journal_entry_id: accountingResult.journal_entry?.id }
        : { status: 'pending_coa', note: accountingResult?.accountingError || 'Chart of Accounts not configured' },
    }, 'Purchase return recorded', 201)

  } catch (err) { await trx.rollback(); next(err) }
})

function parseExpiryToDate(expiry) {
  if (!expiry) return null
  try {
    const [mm, yy] = String(expiry).split('/')
    if (!mm || !yy) return null
    const year  = yy.length === 2 ? 2000 + Number(yy) : Number(yy)
    const month = Number(mm)
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  } catch { return null }
}

module.exports = router
