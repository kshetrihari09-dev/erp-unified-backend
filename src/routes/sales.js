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
 *
 * Batch-selection fix (see migration 016):
 * POST /sales previously deducted stock via a FIFO sweep across every
 * batch of a product, ignoring which batch the Sale page's Batch
 * Selection popup told the user they were selling from — so a sale could
 * silently pull from a batch other than the one shown/selected. It now
 * deducts only from the exact batch (item.batch_id, falling back to a
 * batch_no match for older clients) and records that batch_id on the
 * sale_items row so cancellation restores stock to that same lot.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextInvoiceNo, adToBS, todayBS, auditLog, clampExpiry } = require('../utils/helpers')
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
      // discount_pct was previously accepted/stored per item but never
      // actually applied here — `amount` was computed straight from
      // qty*rate, silently ignoring any discount entered on the Sale
      // page. This now applies it using the same formula the frontend
      // already uses for its own live preview (see utils/calcRowAmount):
      // base = qty*rate*(1-discount_pct/100), amount = base+cc_amount.
      const discount_pct = Number(item.discount_pct) || 0
      const base    = qty * rate * (1 - discount_pct / 100)
      const amount  = Math.round((base + cc_amount) * 100) / 100
      subtotal += amount; cc_total += cc_amount
      return { product_id: item.product_id || null, product_name: item.product_name || '', batch_no: item.batch_no || null, batch_id: item.batch_id || null, expiry: clampExpiry(item.expiry), qty, bonus, rate, discount_pct, cc_pct, cc_amount, amount }
    })

    const unrounded_total = Math.round((subtotal) * 100) / 100

    // ── Round Off ─────────────────────────────────────────────────────────────
    // Applied last, after subtotal/discount/tax are all final. Rounds the
    // grand total to the nearest whole number and records the delta so it
    // can be displayed/printed and reproduced exactly on lookup. When the
    // total is already a whole number, round_off is 0 and net_total is
    // unchanged — Grand Total only moves when a round off is actually applied.
    const net_total = Math.round(unrounded_total)
    const round_off = Math.round((net_total - unrounded_total) * 100) / 100

    const paid_amount = payment_mode === 'credit' ? 0 : net_total
    const due_amount  = net_total - paid_amount

    const [sale] = await trx('sales').insert({
      company_id: req.companyId, party_id: party_id || null, created_by: req.user.id,
      invoice_no, date_ad: date, date_bs, payment_mode: payment_mode || 'cash',
      reference_no: reference_no || null, subtotal, cc_amount: cc_total,
      net_total, round_off, paid_amount, due_amount, status: 'active', notes: notes || null,
    }).returning('*')

    for (const item of saleItems) {
      // ── Batch-specific deduction ──────────────────────────────────────────
      // The Sale page's Batch Selection popup only ever offers batches that
      // belong to this exact product, so an item posted from Sale always
      // carries the id of the one lot the user picked. Stock must come out
      // of that exact inventory_batches row and nothing else — never a FIFO
      // sweep across every batch of the product, which could silently pull
      // from a different lot (including one the user never saw/selected).
      let resolvedBatchId = null
      if (item.product_id && item.qty > 0) {
        let batch = null

        if (item.batch_id) {
          batch = await trx(T)
            .where({ id: item.batch_id, product_id: item.product_id, company_id: req.companyId })
            .first()
          if (!batch) {
            await trx.rollback()
            return res.status(400).json({ success: false, message: `Selected batch for "${item.product_name}" no longer exists — please re-select a batch.` })
          }
        } else if (item.batch_no) {
          // Back-compat for older clients that only send batch_no: match the
          // exact lot by product + batch number rather than sweeping FIFO.
          batch = await trx(T)
            .where({ product_id: item.product_id, company_id: req.companyId, batch_no: item.batch_no })
            .where(QTY, '>', 0)
            .orderBy('created_at', 'asc')
            .first()
          if (!batch) {
            await trx.rollback()
            return res.status(400).json({ success: false, message: `Batch "${item.batch_no}" has no available stock for "${item.product_name}".` })
          }
        }

        if (batch) {
          if (Number(batch[QTY]) < item.qty) {
            await trx.rollback()
            return res.status(400).json({
              success: false,
              message: `Insufficient stock in batch "${batch.batch_no || '—'}" for "${item.product_name}" (available ${batch[QTY]}, requested ${item.qty}).`,
            })
          }
          await trx(T).where({ id: batch.id }).update({ [QTY]: Number(batch[QTY]) - item.qty })
          resolvedBatchId = batch.id
        } else {
          // No batch selected at all — legacy fallback for non-batch-tracked
          // callers/products only. The Sale page itself always resolves a
          // batch before a row can be posted (see BatchSelect.tsx/QtyGate.tsx).
          const batches = await trx(T)
            .where({ product_id: item.product_id, company_id: req.companyId })
            .where(QTY, '>', 0)
            .orderBy('expiry_date', 'asc')

          let remaining = item.qty
          for (const b of batches) {
            if (remaining <= 0) break
            const deduct = Math.min(remaining, Number(b[QTY]))
            await trx(T).where({ id: b.id }).update({ [QTY]: Number(b[QTY]) - deduct })
            remaining -= deduct
          }
        }
      }

      await trx('sale_items').insert({ sale_id: sale.id, ...item, batch_id: resolvedBatchId })
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

    // Reverse stock into the exact batch each item was deducted from —
    // never a different lot of the same product. Items posted after
    // migration 016 carry batch_id (the precise lot); older rows fall back
    // to matching by batch_no, and only as a last resort to "most recent
    // batch for this product" for legacy rows with no batch info at all.
    const items = await trx('sale_items').where({ sale_id: sale.id })
    for (const item of items) {
      if (item.product_id && item.qty > 0) {
        let batch = null
        if (item.batch_id) {
          batch = await trx(T).where({ id: item.batch_id, company_id: req.companyId }).first()
        }
        if (!batch && item.batch_no) {
          batch = await trx(T)
            .where({ product_id: item.product_id, company_id: req.companyId, batch_no: item.batch_no })
            .orderBy('created_at', 'asc').first()
        }
        if (!batch) {
          batch = await trx(T)
            .where({ product_id: item.product_id, company_id: req.companyId })
            .orderBy('created_at', 'desc').first()
        }
        if (batch) {
          await trx(T).where({ id: batch.id }).update({
            [QTY]: Number(batch[QTY]) + Number(item.qty),
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

/* ── PUT /sales/:id/payment-mode ───────────────────────────────────────────
 * UI-only addition to support editing Payment Mode from the Sales List
 * after a sale has been saved. Deliberately minimal and isolated:
 *   - Updates ONLY the `payment_mode` column (+ updated_at).
 *   - No transaction needed — nothing else is touched.
 *   - Does NOT recompute totals/round-off, touch inventory_batches,
 *     re-run AccountingIntegration/PostingEngine, or rebuild vouchers.
 *   - Same `authenticate` + company scoping as every other route on this
 *     router — no new permission model introduced.
 *   - Restricted to 'active' sales, matching the existing rule that only
 *     active invoices can be modified (see /:id/cancel above).
 */
const VALID_PAYMENT_MODES = ['cash', 'credit', 'bank', 'cheque', 'upi', 'card', 'online']

router.put('/:id/payment-mode', async (req, res, next) => {
  try {
    const { payment_mode } = req.body
    if (!VALID_PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ success: false, message: `Invalid payment mode: ${payment_mode}` })
    }

    const sale = await db('sales').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' })
    if (sale.status !== 'active') {
      return res.status(400).json({ success: false, message: `Cannot change payment mode on a ${sale.status} invoice.` })
    }

    // No-op guard — nothing to update or audit if the value is unchanged.
    if (sale.payment_mode === payment_mode) {
      return successResponse(res, sale, 'Payment mode unchanged')
    }

    const [updated] = await db('sales')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ payment_mode, updated_at: new Date() })
      .returning('*')

    auditLog(
      req.companyId, req.user.id, 'UPDATE', 'sales', req.params.id,
      { field: 'payment_mode', from: sale.payment_mode, to: payment_mode }, req.ip,
    )
    return successResponse(res, updated, 'Payment mode updated')
  } catch (err) { next(err) }
})

module.exports = router
