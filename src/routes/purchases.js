/**
 * purchases.js — FIXED
 *
 * Original line → bug → fix:
 *
 * L69: trx('stock_batches').insert({
 *   L71: batch_no, expiry,
 *   L72: qty_in: item.qty, qty_out: 0, qty_available: item.qty,
 *   L73: purchase_rate: item.rate, date_ad: date
 * })
 * → trx('inventory_batches').insert({
 *     batch_no, expiry, expiry_date,
 *     qty_received, qty_remaining, unit_cost, total_cost, receipt_date
 *   })
 *
 * None of the following columns exist in inventory_batches (migration 002):
 *   qty_in, qty_out, qty_available, purchase_rate, date_ad
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextBillNo, adToBS, todayBS, auditLog, clampExpiry } = require('../utils/helpers')
const AccountingIntegration = require('../services/accountingIntegration')

router.use(authenticate)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /purchases ────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search, party_id, status, date_from, date_to } = req.query

    let q = db('purchases as pu')
      .leftJoin('parties as p', 'pu.party_id', 'p.id')
      .where('pu.company_id', req.companyId)
      .select('pu.*', 'p.name as party_name')

    if (search)    q = q.where(b => b.whereILike('pu.bill_no', `%${search}%`).orWhereILike('p.name', `%${search}%`))
    if (party_id)  q = q.where('pu.party_id', party_id)
    if (status)    q = q.where('pu.status', status)
    if (date_from) q = q.where('pu.date_ad', '>=', date_from)
    if (date_to)   q = q.where('pu.date_ad', '<=', date_to)

    const [{ count }] = await q.clone().clearSelect().count('pu.id as count')
    const data = await q.orderBy('pu.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /purchases/:id ────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const purchase = await db('purchases as pu')
      .leftJoin('parties as p', 'pu.party_id', 'p.id')
      .where('pu.id', req.params.id).andWhere('pu.company_id', req.companyId)
      .select('pu.*', 'p.name as party_name').first()
    if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found' })
    const items = await db('purchase_items').where({ purchase_id: purchase.id })
    return successResponse(res, { ...purchase, items })
  } catch (err) { next(err) }
})

/* ── POST /purchases ───────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { party_id, date_ad, payment_mode, supplier_bill_no, items, notes } = req.body
    if (!items?.length) { await trx.rollback(); return res.status(400).json({ success: false, message: 'At least one item required' }) }

    const bill_no = await nextBillNo(req.companyId)
    const date    = date_ad || new Date().toISOString().split('T')[0]
    const date_bs = adToBS(date) || todayBS()

    let net_total = 0
    const purchaseItems = items.map(item => {
      const qty     = Number(item.qty)    || 0
      const rate    = Number(item.rate)   || 0
      const bonus   = Number(item.bonus)  || 0
      // purchase_items schema has cc_pct + cc_amount, NOT vat_pct
      // VAT is baked into the rate on purchase bills in Nepal pharma
      const cc_pct   = Number(item.cc_pct)  || 0
      const cc_amount = Math.round(qty * rate * (cc_pct / 100) * 100) / 100
      const amount   = Math.round(((qty * rate) + cc_amount) * 100) / 100
      net_total     += amount
      // Only spread columns that exist in purchase_items (migration 002):
      // id, purchase_id, product_id, product_name, batch_no, expiry_date, expiry,
      // qty, bonus, rate, cc_pct, cc_amount, amount
      return {
        product_id:   item.product_id   || null,
        product_name: item.product_name || '',
        batch_no:     item.batch_no     || null,
        expiry:       clampExpiry(item.expiry),
        qty,
        bonus,
        rate,
        cc_pct,      // real column — was vat_pct (does not exist)
        cc_amount,   // real column — calculated above
        amount,
      }
    })
    net_total = Math.round(net_total * 100) / 100

    const paid_amount = payment_mode === 'credit' ? 0 : net_total
    const due_amount  = net_total - paid_amount

    const [purchase] = await trx('purchases').insert({
      company_id: req.companyId, party_id: party_id || null, created_by: req.user.id,
      bill_no, supplier_bill_no: supplier_bill_no || null, date_ad: date, date_bs,
      payment_mode: payment_mode || 'credit', net_total, paid_amount, due_amount,
      notes: notes || null, status: 'active',
    }).returning('*')

    for (const item of purchaseItems) {
      await trx('purchase_items').insert({ purchase_id: purchase.id, ...item })

      // L69-73 FIX: was trx('stock_batches').insert({
      //   qty_in, qty_out: 0, qty_available, purchase_rate, date_ad
      // })
      // Correct columns in inventory_batches (migration 002):
      //   qty_received, qty_remaining, unit_cost, total_cost, receipt_date
      if (item.product_id && item.qty > 0) {
        const totalQty = item.qty + (item.bonus || 0)
        const unitCost = item.rate || 0
        await trx(T).insert({
          company_id:    req.companyId,
          product_id:    item.product_id,
          batch_no:      item.batch_no || null,
          expiry:        clampExpiry(item.expiry),
          expiry_date:   parseExpiryToDate(item.expiry),
          receipt_date:  date,          // FIX L73: was date_ad (as a column key, not value)
          qty_received:  totalQty,      // FIX L72: was qty_in
          qty_remaining: totalQty,      // FIX L72: was qty_available
          // qty_out: 0 — column does not exist, removed
          unit_cost:     unitCost,      // FIX L73: was purchase_rate
          total_cost:    Math.round(totalQty * unitCost * 100) / 100,
        })
      }
    }

    // ── Accounting Integration ─────────────────────────────────────────────────
    // Post purchase through PostingEngine (same transaction — atomic rollback on failure).
    // PurchaseStrategy inside PostingEngine will create inventory_batches from metadata.items.
    // NOTE: inventory_batches are already inserted above for backward compatibility.
    // Once fully migrated, remove the inventory_batches INSERT above and rely solely on
    // PurchaseStrategy. For now, both run safely (batch is created by route, not strategy).
    let accountingResult = null
    try {
      accountingResult = await AccountingIntegration.postPurchase({
        purchase,
        items: purchaseItems,
        trx,
        companyId: req.companyId,
        userId:    req.user.id,
        ipAddress: req.ip,
      })
    } catch (acctErr) {
      if (acctErr.status === 422) {
        console.warn(`[ACCOUNTING] COA not configured — purchase saved without journal. ${acctErr.message}`)
        accountingResult = { voucher: null, journal_entry: null, accountingError: acctErr.message }
      } else {
        await trx.rollback()
        return res.status(acctErr.status || 400).json({ success: false, message: acctErr.message })
      }
    }

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CREATE', 'purchases', purchase.id, { bill_no, net_total }, req.ip)
    return successResponse(res, {
      ...purchase,
      items: purchaseItems,
      accounting: accountingResult?.journal_entry
        ? { voucher_no: accountingResult.voucher?.voucher_no, journal_entry_id: accountingResult.journal_entry?.id }
        : { status: 'pending_coa', note: accountingResult?.accountingError || 'Chart of Accounts not configured' },
    }, 'Purchase created', 201)
  } catch (err) { await trx.rollback(); next(err) }
})

/* ── PUT /purchases/:id/cancel ─────────────────────────────────────────────── */
router.put('/:id/cancel', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const purchase = await trx('purchases').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!purchase)                         { await trx.rollback(); return res.status(404).json({ success: false, message: 'Purchase not found' }) }
    if (purchase.status === 'cancelled')   { await trx.rollback(); return res.status(400).json({ success: false, message: 'Already cancelled' }) }

    const items = await trx('purchase_items').where({ purchase_id: purchase.id })
    for (const item of items) {
      if (!item.product_id || !item.qty) continue
      const totalQty = item.qty + (item.bonus || 0)
      const batch = await trx(T)
        .where({ product_id: item.product_id, company_id: req.companyId, batch_no: item.batch_no })
        .orderBy('created_at', 'desc').first()
      if (batch) {
        await trx(T).where({ id: batch.id }).update({
          [QTY]: Math.max(0, Number(batch[QTY]) - totalQty),
        })
      }
    }

    const [updated] = await trx('purchases').where({ id: req.params.id }).update({ status: 'cancelled', updated_at: new Date() }).returning('*')
    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CANCEL', 'purchases', req.params.id, {}, req.ip)
    return successResponse(res, updated, 'Purchase cancelled')
  } catch (err) { await trx.rollback(); next(err) }
})

function parseExpiryToDate(expiry) {
  if (!expiry) return null
  try {
    const [mm, yy] = String(expiry).split('/')
    if (!mm || !yy) return null
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy)
    const month = Number(mm)
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null
    return `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`
  } catch { return null }
}

module.exports = router
