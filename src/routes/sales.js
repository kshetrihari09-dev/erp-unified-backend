/**
 * sales.js — FIXED
 *
 * Original line → bug → fix:
 *
 * L42:  raw SQL: SUM(qty_available) FROM stock_batches   → inventory_batches + qty_remaining
 * L43:  raw SQL: qty_available * p.purchase_rate FROM stock_batches → qty_remaining * ib.unit_cost FROM inventory_batches
 * L44:  db('stock_batches').where('qty_available', '>')  → db('inventory_batches').where('qty_remaining', '>')
 * L123: trx('stock_batches')                             → trx('inventory_batches')
 * L125: .where('qty_available', '>', 0)                  → .where('qty_remaining', '>', 0)
 * L131: batch.qty_available                              → batch.qty_remaining
 * L132: trx('stock_batches').where()                     → trx('inventory_batches').where()
 * L133: qty_out: Number(batch.qty_out) + deduct          → removed (column does not exist)
 * L134: qty_available: Number(batch.qty_available)-deduct → qty_remaining: Number(batch.qty_remaining)-deduct
 * L143: trx('accounting_accounts')                       → trx('accounts')
 * L145: trx('accounting_entries').insert()               → REMOVED (ghost table; postingEngine handles this)
 * L177: trx('stock_batches')                             → trx('inventory_batches')
 * L181: trx('stock_batches').where()                     → trx('inventory_batches').where()
 * L182: qty_out: Math.max(0, Number(batch.qty_out)-item.qty) → removed
 * L183: qty_available: Number(batch.qty_available)+item.qty  → qty_remaining: Number(batch.qty_remaining)+item.qty
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextInvoiceNo, adToBS, todayBS, auditLog } = require('../utils/helpers')
const AccountingIntegration = require('../services/accountingIntegration')

router.use(authenticate)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /sales ────────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search, party_id, status, date_from, date_to } = req.query
    let q = db('sales as s').leftJoin('parties as p', 's.party_id', 'p.id').where('s.company_id', req.companyId).select('s.*', 'p.name as party_name', 'p.phone as party_phone')
    if (search)    q = q.where(b => b.whereILike('s.invoice_no', `%${search}%`).orWhereILike('p.name', `%${search}%`))
    if (party_id)  q = q.where('s.party_id', party_id)
    if (status)    q = q.where('s.status', status)
    if (date_from) q = q.where('s.date_ad', '>=', date_from)
    if (date_to)   q = q.where('s.date_ad', '<=', date_to)
    const [{ count }] = await q.clone().clearSelect().count('s.id as count')
    const data = await q.orderBy('s.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /sales/summary/stats ──────────────────────────────────────────────── */
router.get('/summary/stats', async (req, res, next) => {
  try {
    const today      = new Date().toISOString().split('T')[0]
    const monthStart = today.slice(0, 8) + '01'

    const [todayStats]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('date_ad', today).sum({ total: 'net_total' }).count({ count: 'id' })
    const [monthStats]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('date_ad', '>=', monthStart).sum({ revenue: 'net_total' })
    const [receivable]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('due_amount', '>', 0).sum({ total: 'due_amount' })

    // L42 FIX: was raw SQL with stock_batches + qty_available
    const lowStockResult = await db.raw(`
      SELECT COUNT(*) AS cnt
      FROM (
        SELECT p.id FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(qty_remaining) AS stock
          FROM inventory_batches WHERE company_id = ?
          GROUP BY product_id
        ) sb ON p.id = sb.product_id
        WHERE p.company_id = ? AND p.is_active = true
          AND COALESCE(sb.stock, 0) < p.min_stock
      ) t
    `, [req.companyId, req.companyId])

    // L43 FIX: was stock_batches + qty_available * purchase_rate
    const stockValResult = await db.raw(`
      SELECT COALESCE(SUM(ib.qty_remaining * ib.unit_cost), 0) AS val
      FROM inventory_batches ib WHERE ib.company_id = ?
    `, [req.companyId])

    // L44 FIX: was db('stock_batches').where('qty_available', '>')
    const [expiryAlerts] = await db(T)
      .where({ company_id: req.companyId })
      .where(QTY, '>', 0)
      .where('expiry_date', '<=', new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0])
      .whereNotNull('expiry_date')
      .count({ count: 'id' })

    const rawRow = (r) => r?.rows?.[0] ?? r?.[0] ?? r ?? {}
    return successResponse(res, {
      today:           { sales_total: Number(todayStats?.total) || 0, sales_count: Number(todayStats?.count) || 0 },
      this_month:      { revenue: Number(monthStats?.revenue) || 0 },
      receivable:      Number(receivable?.total) || 0,
      stock_value:     Number(rawRow(stockValResult).val)  || 0,
      low_stock_items: Number(rawRow(lowStockResult).cnt)  || 0,
      expiry_alerts:   Number(expiryAlerts?.count)         || 0,
    })
  } catch (err) { next(err) }
})

/* ── GET /sales/:id ────────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const sale = await db('sales as s').leftJoin('parties as p', 's.party_id', 'p.id')
      .where('s.id', req.params.id).andWhere('s.company_id', req.companyId)
      .select('s.*', 'p.name as party_name', 'p.phone as party_phone', 'p.address as party_address', 'p.pan_no as party_pan').first()
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' })
    const items = await db('sale_items').where({ sale_id: sale.id })
    return successResponse(res, { ...sale, items })
  } catch (err) { next(err) }
})

/* ── POST /sales ───────────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { party_id, date_ad, payment_mode, reference_no, items, notes, cc_charge_pct } = req.body
    if (!items?.length) { await trx.rollback(); return res.status(400).json({ success: false, message: 'At least one item is required' }) }

    // ── Date sequence validation ──────────────────────────────────────────────
    // New invoice date must be >= latest active sales invoice date for this company.
    // Same date is allowed. Future dates are allowed. Earlier dates are rejected.
    const date = date_ad || new Date().toISOString().split('T')[0]

    const latestSale = await trx('sales')
      .where({ company_id: req.companyId, status: 'active' })
      .whereNotNull('date_ad')
      .orderBy('date_ad', 'desc')
      .select('date_ad', 'invoice_no')
      .first()

    if (latestSale && date < latestSale.date_ad) {
      await trx.rollback()
      return res.status(400).json({
        success: false,
        message: `Sales entry date cannot be earlier than the previous sales invoice date.`,
        detail:  `Last invoice ${latestSale.invoice_no} is dated ${latestSale.date_ad}. New entry must be on or after this date.`,
        last_invoice_date: latestSale.date_ad,
        last_invoice_no:   latestSale.invoice_no,
      })
    }
    // ─────────────────────────────────────────────────────────────────────────

    const company    = await trx('companies').where({ id: req.companyId }).first()
    const invoice_no = await nextInvoiceNo(req.companyId, company?.invoice_prefix || 'INV')
    const date_bs    = adToBS(date) || todayBS()

    let subtotal = 0, cc_total = 0
    const saleItems = items.map(item => {
      const qty     = Number(item.qty)   || 0
      const rate    = Number(item.rate)  || 0
      const bonus   = Number(item.bonus) || 0
      const cc_pct  = Number(item.cc_pct) || Number(cc_charge_pct) || 0
      // cc_amount = bonus_qty × rate × (cc_pct / 100.0)
      const cc_amount = (bonus > 0 && cc_pct > 0)
        ? Math.round(bonus * rate * (cc_pct / 100) * 10000) / 10000
        : 0
      const amount  = Math.round((qty * rate + cc_amount) * 100) / 100
      subtotal += amount; cc_total += cc_amount
      return { product_id: item.product_id || null, product_name: item.product_name || '', batch_no: item.batch_no || null, expiry: item.expiry || null, qty, bonus, rate, discount_pct: Number(item.discount_pct) || 0, cc_pct, cc_amount, amount }
    })

    const net_total   = Math.round((subtotal) * 100) / 100
    const paid_amount = payment_mode === 'credit' ? 0 : net_total
    const due_amount  = net_total - paid_amount

    const [sale] = await trx('sales').insert({
      company_id: req.companyId, party_id: party_id || null, created_by: req.user.id,
      invoice_no, date_ad: date, date_bs, payment_mode: payment_mode || 'cash',
      reference_no: reference_no || null, subtotal, cc_amount: cc_total,
      net_total, paid_amount, due_amount, status: 'active', notes: notes || null,
    }).returning('*')

    for (const item of saleItems) {
      await trx('sale_items').insert({ sale_id: sale.id, ...item })

      // L123-134 FIX: FIFO deduction
      // stock_batches → inventory_batches, qty_available → qty_remaining, qty_out → removed
      if (item.product_id && item.qty > 0) {
        const batches = await trx(T)                           // L123 FIX
          .where({ product_id: item.product_id, company_id: req.companyId })
          .where(QTY, '>', 0)                                  // L125 FIX
          .orderBy('expiry_date', 'asc')

        let remaining = item.qty
        for (const batch of batches) {
          if (remaining <= 0) break
          const deduct = Math.min(remaining, Number(batch[QTY]))  // L131 FIX
          await trx(T).where({ id: batch.id }).update({            // L132 FIX
            // L133 FIX: qty_out removed — column does not exist
            [QTY]: Number(batch[QTY]) - deduct,                   // L134 FIX
          })
          remaining -= deduct
        }
      }
    }

    // ── Accounting Integration ─────────────────────────────────────────────────
    // Every sale is posted through AccountingIntegration → VoucherService → PostingEngine.
    // All within the same transaction — if posting fails, the entire sale rolls back.
    // If COA is not yet configured (missing account_defaults), warns and saves without journal.
    let accountingResult = null
    try {
      accountingResult = await AccountingIntegration.postSale({
        sale,
        items: saleItems,
        trx,
        companyId: req.companyId,
        userId:    req.user.id,
        ipAddress: req.ip,
      })
    } catch (acctErr) {
      if (acctErr.status === 422) {
        // COA not configured yet — backward-compatible: save sale, skip journal
        console.warn(`[ACCOUNTING] COA not configured — sale saved without journal. ${acctErr.message}`)
        accountingResult = { voucher: null, journal_entry: null, accountingError: acctErr.message }
      } else {
        await trx.rollback()
        return res.status(acctErr.status || 400).json({ success: false, message: acctErr.message })
      }
    }

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CREATE', 'sales', sale.id, { invoice_no, net_total }, req.ip)
    return successResponse(res, {
      ...sale,
      items: saleItems,
      accounting: accountingResult?.journal_entry
        ? { voucher_no: accountingResult.voucher?.voucher_no, journal_entry_id: accountingResult.journal_entry?.id }
        : { status: 'pending_coa', note: accountingResult?.accountingError || 'Chart of Accounts not configured' },
    }, 'Invoice created', 201)
  } catch (err) { await trx.rollback(); next(err) }
})

/* ── PUT /sales/:id/cancel ─────────────────────────────────────────────────── */
router.put('/:id/cancel', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const sale = await trx('sales').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!sale)                       { await trx.rollback(); return res.status(404).json({ success: false, message: 'Sale not found' }) }
    if (sale.status === 'cancelled') { await trx.rollback(); return res.status(400).json({ success: false, message: 'Already cancelled' }) }

    // L177-183 FIX: reverse FIFO — stock_batches → inventory_batches,
    //                qty_out → removed, qty_available → qty_remaining
    const items = await trx('sale_items').where({ sale_id: sale.id })
    for (const item of items) {
      if (item.product_id && item.qty > 0) {
        const batch = await trx(T)                               // L177 FIX
          .where({ product_id: item.product_id, company_id: req.companyId })
          .orderBy('created_at', 'desc').first()
        if (batch) {
          await trx(T).where({ id: batch.id }).update({          // L181 FIX
            // L182 FIX: qty_out removed
            [QTY]: Number(batch[QTY]) + Number(item.qty),        // L183 FIX
          })
        }
      }
    }

    const [updated] = await trx('sales').where({ id: req.params.id }).update({ status: 'cancelled', updated_at: new Date() }).returning('*')
    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CANCEL', 'sales', req.params.id, { reason: req.body.reason }, req.ip)
    return successResponse(res, updated, 'Invoice cancelled')
  } catch (err) { await trx.rollback(); next(err) }
})

module.exports = router
