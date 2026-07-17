/**
 * reports.js — Combined pharma ERP + accounting reports
 *
 * FIXES applied over original:
 *  1. /dashboard added as alias for /summary (was 404)
 *  2. /party-balance added (was 404)
 *  3. /stock subquery: .sum(db.raw('...')) → .select(db.raw('SUM(...) as ...'))
 *     to avoid SUM(expr as alias) syntax error
 *  4. /summary raw result unpacking uses safe rawRow() helper
 *  5. /low-stock route added
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const ReportingEngine   = require('../engines/reportingEngine')

router.use(authenticate)

// Safe raw-result row extractor — handles both pg8 {rows:[]} and plain {}
const rawRow = (r) => r?.rows?.[0] ?? r?.[0] ?? r ?? {}

/* ── GET /reports/profit-loss ──────────────────────────────────────────────── */
router.get('/profit-loss', async (req, res, next) => {
  try {
    const result = await ReportingEngine.profitAndLoss(req.companyId, {
      dateFrom: req.query.date_from, dateTo: req.query.date_to,
      compareFrom: req.query.compare_from, compareTo: req.query.compare_to,
    })
    return successResponse(res, result)
  } catch (err) { next(err) }
})

/* ── GET /reports/balance-sheet ────────────────────────────────────────────── */
router.get('/balance-sheet', async (req, res, next) => {
  try {
    const result = await ReportingEngine.balanceSheet(req.companyId, { asOfDate: req.query.as_of_date })
    return successResponse(res, result)
  } catch (err) { next(err) }
})

/* ── GET /reports/trial-balance ────────────────────────────────────────────── */
router.get('/trial-balance', async (req, res, next) => {
  try {
    const result = await ReportingEngine.trialBalance(req.companyId, {
      asOfDate: req.query.as_of_date, dateFrom: req.query.date_from,
    })
    return successResponse(res, result)
  } catch (err) { next(err) }
})

/* ── GET /reports/sales ─────────────────────────────────────────────────────── */
router.get('/sales', async (req, res, next) => {
  try {
    const from = req.query.date_from || new Date(Date.now() - 30*86400000).toISOString().split('T')[0]
    const to   = req.query.date_to   || new Date().toISOString().split('T')[0]
    const data = await db('sales as s').leftJoin('parties as p', 's.party_id', 'p.id')
      .where('s.company_id', req.companyId).andWhere('s.status', 'active')
      .whereBetween('s.date_ad', [from, to])
      .select('s.id','s.invoice_no','s.date_ad','s.date_bs','s.payment_mode','s.net_total','s.paid_amount','s.due_amount','s.status','p.name as party_name')
      .orderBy('s.date_ad', 'desc')
    const [totals] = await db('sales').where({ company_id: req.companyId, status: 'active' })
      .whereBetween('date_ad', [from, to]).sum({ total:'net_total', due:'due_amount' }).count({ count:'id' })
    return successResponse(res, {
      date_from: from, date_to: to, data,
      total:     Number(totals?.total) || 0,
      total_due: Number(totals?.due)   || 0,
      count:     Number(totals?.count) || 0,
    })
  } catch (err) { next(err) }
})

/* ── GET /reports/purchases ─────────────────────────────────────────────────── */
router.get('/purchases', async (req, res, next) => {
  try {
    const from = req.query.date_from || new Date(Date.now() - 30*86400000).toISOString().split('T')[0]
    const to   = req.query.date_to   || new Date().toISOString().split('T')[0]
    const data = await db('purchases as pu').leftJoin('parties as p', 'pu.party_id', 'p.id')
      .where('pu.company_id', req.companyId).andWhere('pu.status', 'active')
      .whereBetween('pu.date_ad', [from, to])
      .select('pu.id','pu.bill_no','pu.date_ad','pu.date_bs','pu.payment_mode','pu.net_total','pu.paid_amount','pu.due_amount','pu.status','p.name as party_name')
      .orderBy('pu.date_ad', 'desc')
    const [totals] = await db('purchases').where({ company_id: req.companyId, status: 'active' })
      .whereBetween('date_ad', [from, to]).sum({ total:'net_total', due:'due_amount' }).count({ count:'id' })
    return successResponse(res, {
      date_from: from, date_to: to, data,
      total:     Number(totals?.total) || 0,
      total_due: Number(totals?.due)   || 0,
      count:     Number(totals?.count) || 0,
    })
  } catch (err) { next(err) }
})

/* ── GET /reports/stock ─────────────────────────────────────────────────────── */
router.get('/stock', async (req, res, next) => {
  try {
    const { search } = req.query

    // FIX: use .select(db.raw('SUM(...) as alias')) NOT .sum(db.raw('expr as alias'))
    // .sum() wraps in SUM() again → SUM(expr as alias) = syntax error
    let q = db('products as p')
      .leftJoin(
        db('inventory_batches')
          .where({ company_id: req.companyId })
          .groupBy('product_id')
          .select('product_id')
          .sum('qty_remaining as total_stock')
          .select(db.raw('SUM(qty_remaining * unit_cost) as stock_value'))
          .as('sb'),
        'p.id', 'sb.product_id'
      )
      .where('p.company_id', req.companyId)
      .andWhere('p.is_active', true)
      .select(
        'p.id', 'p.item_code', 'p.name', 'p.unit',
        'p.min_stock', 'p.sales_rate', 'p.purchase_rate',
        db.raw('COALESCE(sb.total_stock, 0) as current_stock'),
        db.raw('COALESCE(sb.stock_value,  0) as stock_value'),
        db.raw(`CASE WHEN COALESCE(sb.total_stock,0) < p.min_stock THEN true ELSE false END as low_stock`)
      )

    if (search) q = q.whereILike('p.name', `%${search}%`)
    const data = await q.orderBy('p.name')

    const totalValResult = await db.raw(
      `SELECT COALESCE(SUM(ib.qty_remaining * ib.unit_cost),0) as total_value
       FROM inventory_batches ib WHERE ib.company_id = ?`,
      [req.companyId]
    )
    return successResponse(res, {
      data,
      total_value: Number(rawRow(totalValResult).total_value) || 0,
    })
  } catch (err) { next(err) }
})

/* ── GET /reports/expiry ─────────────────────────────────────────────────────── */
router.get('/expiry', async (req, res, next) => {
  try {
    const { days = 30 } = req.query
    const cutoff = new Date(Date.now() + Number(days) * 86400000).toISOString().split('T')[0]
    const data = await db('inventory_batches as ib')
      .join('products as p', 'ib.product_id', 'p.id')
      .where('ib.company_id', req.companyId)
      .andWhere('ib.qty_remaining', '>', 0)
      .andWhere('ib.expiry_date', '<=', cutoff)
      .whereNotNull('ib.expiry_date')
      .select('p.name as product_name', 'p.item_code', 'ib.batch_no', 'ib.expiry', 'ib.expiry_date', 'ib.qty_remaining', 'p.sales_rate')
      .orderBy('ib.expiry_date')
    return successResponse(res, { data, total: data.length })
  } catch (err) { next(err) }
})

/* ── GET /reports/low-stock ─────────────────────────────────────────────────── */
router.get('/low-stock', async (req, res, next) => {
  try {
    const result = await db.raw(`
      SELECT p.id, p.item_code, p.name, p.unit, p.min_stock, p.purchase_rate, p.sales_rate,
             COALESCE(sb.stock, 0) AS current_stock
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(qty_remaining) AS stock
        FROM inventory_batches WHERE company_id = ?
        GROUP BY product_id
      ) sb ON p.id = sb.product_id
      WHERE p.company_id = ? AND p.is_active = true
        AND COALESCE(sb.stock, 0) < p.min_stock
      ORDER BY (p.min_stock - COALESCE(sb.stock, 0)) DESC
    `, [req.companyId, req.companyId])
    const rows = result?.rows ?? result ?? []
    return successResponse(res, { data: rows, total: rows.length })
  } catch (err) { next(err) }
})

/* ── GET /reports/party-balance ─────────────────────────────────────────────── */
//
// SOURCE OF TRUTH: same as the working Ledger page (parties/:id/ledger).
//
// The Ledger joins journal_entries → vouchers and uses vouchers.party_id.
// journal_lines.party_id is unreliable — it is set on some lines but not all.
//
// This route mirrors the Ledger balance logic exactly:
//
//   Customer balance:
//     +  sales.net_total (invoiced)
//     -  sales.paid_amount for cash sales (immediate payment)
//     -  RECEIPT vouchers posted via PostingEngine (standalone payments)
//     +  opening_balance
//
//   Supplier balance:
//     +  purchases.net_total (billed)
//     -  purchases.paid_amount for cash purchases
//     -  PAYMENT vouchers posted via PostingEngine
//     +  opening_balance
//
router.get('/party-balance', async (req, res, next) => {
  try {
    const { type, date_from, date_to } = req.query

    // ── 1. Load parties ───────────────────────────────────────────────────────
    let q = db('parties as p').where({ 'p.company_id': req.companyId, 'p.is_active': true })
    if (type === 'customer' || type === 'supplier') q = q.where('p.type', type)
    const parties = await q
      .select('p.id','p.code','p.name','p.type','p.phone','p.pan_no',
              'p.opening_balance','p.credit_limit','p.credit_days')
      .orderBy('p.name')

    if (!parties.length) {
      return successResponse(res, { data: [], total: 0, total_balance: 0, total_due: 0, type: type || 'all' })
    }

    const ids = parties.map(p => p.id)

    // ── 2. Sales totals (customers) ───────────────────────────────────────────
    let salesQ = db('sales')
      .whereIn('party_id', ids)
      .where({ company_id: req.companyId, status: 'active' })
    if (date_from) salesQ = salesQ.where('date_ad', '>=', date_from)
    if (date_to)   salesQ = salesQ.where('date_ad', '<=', date_to)
    const salesRows = await salesQ
      .groupBy('party_id')
      .select('party_id')
      .sum({ total_invoiced: 'net_total', total_cash_paid: 'paid_amount', total_due: 'due_amount' })

    // ── 3. Purchase totals (suppliers) ────────────────────────────────────────
    let purchQ = db('purchases')
      .whereIn('party_id', ids)
      .where({ company_id: req.companyId, status: 'active' })
    if (date_from) purchQ = purchQ.where('date_ad', '>=', date_from)
    if (date_to)   purchQ = purchQ.where('date_ad', '<=', date_to)
    const purchRows = await purchQ
      .groupBy('party_id')
      .select('party_id')
      .sum({ total_invoiced: 'net_total', total_cash_paid: 'paid_amount', total_due: 'due_amount' })

    const salesMap = Object.fromEntries(salesRows.map(r => [r.party_id, r]))
    const purchMap = Object.fromEntries(purchRows.map(r => [r.party_id, r]))

    // ── 4. Voucher totals via PostingEngine (uses vouchers.party_id) ──────────
    // Mirror the Ledger: join journal_entries → vouchers, filter by party_id.
    // Only count RECEIPT / PAYMENT / DEBIT_NOTE / CREDIT_NOTE — the additive
    // voucher types that adjust the balance beyond the invoice amount.
    // SALES and PURCHASE vouchers are already covered by steps 2 & 3.
    let receiptMap  = {}  // party_id → total receipts (reduce customer balance)
    let paymentMap  = {}  // party_id → total payments (reduce supplier balance)
    let dnMap       = {}  // debit notes  (increase customer balance)
    let cnMap       = {}  // credit notes (reduce customer balance further)

    try {
      const hasJE = await db.schema.hasTable('journal_entries')
      if (hasJE) {
        const buildVoucherSum = async (voucherTypes, sumCol) => {
          let vq = db('journal_entries as je')
            .join('vouchers as v', 'je.voucher_id', 'v.id')
            .where('v.company_id', req.companyId)
            .whereIn('v.party_id', ids)
            .whereIn('v.voucher_type', voucherTypes)
            .where('v.status', 'POSTED')
          if (date_from) vq = vq.where('je.entry_date', '>=', date_from)
          if (date_to)   vq = vq.where('je.entry_date', '<=', date_to)
          const rows = await vq
            .groupBy('v.party_id')
            .select('v.party_id')
            .sum({ total: sumCol })
          return Object.fromEntries(rows.map(r => [r.party_id, Number(r.total) || 0]))
        }

        // RECEIPT: total_credit reduces customer receivable
        // PAYMENT: total_debit  reduces supplier payable
        // DEBIT_NOTE / CREDIT_NOTE: adjust respective balances
        ;[receiptMap, paymentMap, dnMap, cnMap] = await Promise.all([
          buildVoucherSum(['RECEIPT'],     'je.total_credit'),
          buildVoucherSum(['PAYMENT'],     'je.total_debit'),
          buildVoucherSum(['DEBIT_NOTE'],  'je.total_debit'),
          buildVoucherSum(['CREDIT_NOTE'], 'je.total_credit'),
        ])
      }
    } catch (e) {
      console.warn('[party-balance] journal query failed (non-fatal):', e.message)
    }

    // ── 5. Build response ─────────────────────────────────────────────────────
    const round2 = n => Math.round(n * 100) / 100

    const data = parties.map(p => {
      const opening = Number(p.opening_balance) || 0

      if (p.type === 'customer') {
        const s             = salesMap[p.id]
        const invoiced      = Number(s?.total_invoiced)  || 0
        const cashPaid      = Number(s?.total_cash_paid) || 0  // cash sales immediate payment
        const voucherPaid   = (receiptMap[p.id]  || 0)         // standalone RECEIPT vouchers
        const debitNotes    = (dnMap[p.id]        || 0)
        const creditNotes   = (cnMap[p.id]        || 0)
        const totalPaid     = cashPaid + voucherPaid + creditNotes
        const balance       = round2(opening + invoiced + debitNotes - totalPaid)
        return {
          ...p,
          data_source:    voucherPaid > 0 ? 'journal' : 'operational',
          total_invoiced: round2(invoiced),
          total_paid:     round2(totalPaid),
          total_due:      round2(invoiced + debitNotes - totalPaid),
          balance,
          debit:  balance > 0 ? balance : 0,
          credit: balance < 0 ? Math.abs(balance) : 0,
        }
      } else {
        const pu            = purchMap[p.id]
        const invoiced      = Number(pu?.total_invoiced)  || 0
        const cashPaid      = Number(pu?.total_cash_paid) || 0
        const voucherPaid   = (paymentMap[p.id] || 0)          // standalone PAYMENT vouchers
        const debitNotes    = (dnMap[p.id]       || 0)
        const creditNotes   = (cnMap[p.id]       || 0)
        const totalPaid     = cashPaid + voucherPaid + debitNotes
        const balance       = round2(opening + invoiced + creditNotes - totalPaid)
        return {
          ...p,
          data_source:    voucherPaid > 0 ? 'journal' : 'operational',
          total_invoiced: round2(invoiced),
          total_paid:     round2(totalPaid),
          total_due:      round2(invoiced + creditNotes - totalPaid),
          balance,
          debit:  balance < 0 ? Math.abs(balance) : 0,
          credit: balance > 0 ? balance : 0,
        }
      }
    })

    return successResponse(res, {
      data,
      total:         data.length,
      total_balance: round2(data.reduce((s, p) => s + p.balance,    0)),
      total_due:     round2(data.reduce((s, p) => s + p.total_due,  0)),
      type:          type || 'all',
      date_from:     date_from || null,
      date_to:       date_to   || null,
    })
  } catch (err) { next(err) }
})

/* ── GET /reports/dashboard + /reports/summary ─────────────────────────────── */
// Shared handler — both routes serve the same dashboard stats
async function dashboardHandler(req, res, next) {
  try {
    const today      = new Date().toISOString().split('T')[0]
    const monthStart = today.slice(0, 8) + '01'

    const [todayStats]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('date_ad', today).sum({ total: 'net_total' }).count({ count: 'id' })
    const [monthStats]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('date_ad', '>=', monthStart).sum({ revenue: 'net_total' })
    const [receivable]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('due_amount', '>', 0).sum({ total: 'due_amount' })

    const stockValResult = await db.raw(
      `SELECT COALESCE(SUM(ib.qty_remaining * ib.unit_cost),0) as val FROM inventory_batches ib WHERE ib.company_id = ?`,
      [req.companyId]
    )
    const lowStockResult = await db.raw(
      `SELECT COUNT(*) as cnt FROM (
         SELECT p.id FROM products p
         LEFT JOIN (SELECT product_id, SUM(qty_remaining) as stock FROM inventory_batches WHERE company_id=? GROUP BY product_id) sb ON p.id=sb.product_id
         WHERE p.company_id=? AND p.is_active=true AND COALESCE(sb.stock,0)<p.min_stock
       ) t`,
      [req.companyId, req.companyId]
    )
    const [expiryAlerts] = await db('inventory_batches')
      .where({ company_id: req.companyId })
      .where('qty_remaining', '>', 0)
      .where('expiry_date', '<=', new Date(Date.now() + 30*86400000).toISOString().split('T')[0])
      .whereNotNull('expiry_date')
      .count({ count: 'id' })

    // Payment-mode breakdown for today's sales (drives the dashboard donut chart)
    const paymentModeRows = await db('sales')
      .where({ company_id: req.companyId, status: 'active' })
      .where('date_ad', today)
      .groupBy('payment_mode')
      .select('payment_mode')
      .sum({ total: 'net_total' })
      .count({ count: 'id' })

    const pmTotalSum = paymentModeRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
    const payment_modes = paymentModeRows
      .filter(r => Number(r.total) > 0)
      .map(r => ({
        name:    r.payment_mode || 'cash',
        total:   Number(r.total) || 0,
        count:   Number(r.count) || 0,
        percent: pmTotalSum > 0 ? Math.round((Number(r.total) / pmTotalSum) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total)

    return successResponse(res, {
      today:           { sales_total: Number(todayStats?.total) || 0, sales_count: Number(todayStats?.count) || 0 },
      this_month:      { revenue: Number(monthStats?.revenue) || 0 },
      receivable:      Number(receivable?.total) || 0,
      stock_value:     Number(rawRow(stockValResult).val)  || 0,
      low_stock_items: Number(rawRow(lowStockResult).cnt)  || 0,
      expiry_alerts:   Number(expiryAlerts?.count)         || 0,
      payment_modes,
    })
  } catch (err) { next(err) }
}

router.get('/dashboard', dashboardHandler)  // FIX: was 404
router.get('/summary',   dashboardHandler)  // alias

module.exports = router
