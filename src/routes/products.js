/**
 * products.js — FIXED
 *
 * All 7 broken references corrected:
 *
 *  LINE 26 — db('stock_batches')           → db('inventory_batches')
 *  LINE 26 — .sum('qty_available …')       → .sum('qty_remaining …')
 *  LINE 49 — db('stock_batches')           → db('inventory_batches')
 *  LINE 49 — .where('qty_available', '>')  → .where('qty_remaining', '>')
 *  LINE 50 — b.qty_available               → b.qty_remaining
 *  LINE 58 — db('stock_batches')           → db('inventory_batches')
 *  LINE 61 — b.qty_available               → b.qty_remaining
 *  LINE 125 — db('stock_batches').del()    → db('inventory_batches').del()
 *  LINE 138 — db('stock_batches').insert() → db('inventory_batches').insert()
 *             with correct columns (qty_received, qty_remaining, unit_cost, total_cost)
 *             removed nonexistent columns: qty_in, qty_out, purchase_rate, date_ad
 */

const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextItemCode, auditLog } = require('../utils/helpers')

router.use(authenticate)

// ── Constant: real table name ─────────────────────────────────────────────────
// Use this everywhere instead of hard-coding the string,
// so a future rename only requires changing one line.
const BATCHES_TABLE = 'inventory_batches'
const QTY_COL       = 'qty_remaining'    // the real column in migration 002

/* ── GET /products ────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search, category, is_active } = req.query

    let q = db('products').where({ company_id: req.companyId })
    if (search)               q = q.where(b => b.whereILike('name', `%${search}%`).orWhereILike('item_code', `%${search}%`).orWhereILike('barcode', `%${search}%`).orWhereILike('generic_name', `%${search}%`).orWhereILike('company_name', `%${search}%`))
    if (category)             q = q.where({ category })
    if (is_active !== undefined) q = q.where({ is_active: is_active === 'true' })

    const [{ count }] = await q.clone().count('id as count')
    const data = await q.orderBy('name').limit(limit).offset(offset)

    // ── Attach current stock per product ──────────────────────────────────
    // FIX: was db('stock_batches') + .sum('qty_available as total_stock')
    //      → db('inventory_batches') + .sum('qty_remaining as total_stock')
    const ids = data.map(p => p.id)
    const stocks = ids.length
      ? await db(BATCHES_TABLE)
          .whereIn('product_id', ids)
          .where({ company_id: req.companyId })
          .groupBy('product_id')
          .select('product_id')
          .sum(`${QTY_COL} as total_stock`)
      : []

    const stockMap = Object.fromEntries(
      stocks.map(s => [s.product_id, Number(s.total_stock)])
    )
    const enriched = data.map(p => ({
      ...p,
      current_stock: stockMap[p.id] || 0,
      low_stock:     (stockMap[p.id] || 0) < (p.min_stock || 0),
    }))

    return paginatedResponse(res, { data: enriched, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /products/categories ─────────────────────────────────────────────── */
/* ── GET /products/search?q=par&limit=20 ─────────────────────────────────────
 *
 * TRUE PREFIX search — WHERE name ILIKE 'q%'
 * Searches product name only, from first character.
 * Returns max 20 results ordered by name.
 * Never does a contains scan (%q%).
 *
 * This route MUST be declared before /:id so Express matches /search
 * as a literal path, not as an id parameter.
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/search', async (req, res, next) => {
  try {
    const raw   = (req.query.q || '').toString().trim()
    const limit = Math.min(parseInt(req.query.limit) || 20, 50)

    // Empty query — return empty array immediately, no DB hit
    if (!raw) {
      return res.json({ success: true, data: [] })
    }

    // Sanitise: escape SQL wildcard characters in the user input so a query
    // like "50%" doesn't become a wildcard pattern accidentally.
    const escaped = raw.replace(/[\%_]/g, c => '\\' + c)
    const pattern = `${escaped}%`   // prefix: starts-with only

    const rows = await db('products')
      .where({ company_id: req.companyId, is_active: true })
      .whereRaw('name ILIKE ?', [pattern])   // prefix match, case-insensitive
      .orderBy('name', 'asc')
      .limit(limit)
      .select(
        'id', 'item_code', 'barcode', 'name', 'generic_name',
        'company_name', 'unit', 'sales_rate', 'mrp',
        'purchase_rate', 'min_stock', 'is_active',
        // alias the DB column name to the field name the frontend expects
        db.raw('tax_rate   as vat_percent'),
        db.raw('cc_percent as cc_pct')
      )

    return res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

router.get('/categories', async (req, res, next) => {
  try {
    const rows = await db('products')
      .where({ company_id: req.companyId })
      .whereNotNull('category')
      .distinct('category')
      .orderBy('category')
    return successResponse(res, rows.map(r => r.category))
  } catch (err) { next(err) }
})

/* ── GET /products/:id ────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const product = await db('products')
      .where({ id: req.params.id, company_id: req.companyId })
      .first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })

    // FIX: was db('stock_batches') + .where('qty_available', '>', 0)
    //           + b.qty_available
    const batches = await db(BATCHES_TABLE)
      .where({ product_id: product.id, company_id: req.companyId })
      .where(QTY_COL, '>', 0)
      .orderBy('expiry_date', 'asc')

    const current_stock = batches.reduce((s, b) => s + Number(b[QTY_COL]), 0)

    return successResponse(res, {
      ...product,
      current_stock,
      low_stock: current_stock < (product.min_stock || 0),
      batches: batches.map(b => ({
        ...b,
        qty_available: Number(b[QTY_COL]),  // expose as qty_available for frontend compat
      })),
    })
  } catch (err) { next(err) }
})

/* ── GET /products/:id/stock ──────────────────────────────────────────────── */
router.get('/:id/stock', async (req, res, next) => {
  try {
    // FIX: was db('stock_batches') + b.qty_available
    const batches = await db(BATCHES_TABLE)
      .where({ product_id: req.params.id, company_id: req.companyId })
      .orderBy('expiry_date', 'asc')

    const total = batches.reduce((s, b) => s + Number(b[QTY_COL]), 0)

    return successResponse(res, {
      batches: batches.map(b => ({
        ...b,
        qty_available: Number(b[QTY_COL]),
      })),
      total_stock: total,
    })
  } catch (err) { next(err) }
})

/* ── POST /products ───────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  try {
    const {
      name, generic_name, company_name, category, unit, barcode,
      purchase_rate, sales_rate, mrp, cc_percent, min_stock,
    } = req.body

    if (!name?.trim())
      return res.status(400).json({ success: false, message: 'Product name is required' })
    if (sales_rate == null || isNaN(Number(sales_rate)))
      return res.status(400).json({ success: false, message: 'Sales rate is required' })

    const cleanBarcode = barcode?.toString().trim() || null
    if (cleanBarcode) {
      const dupe = await db('products')
        .where({ company_id: req.companyId, barcode: cleanBarcode })
        .first('id')
      if (dupe)
        return res.status(400).json({ success: false, message: 'This barcode is already assigned to another product' })
    }

    const item_code = await nextItemCode(req.companyId)
    const [product] = await db('products').insert({
      company_id:   req.companyId,
      item_code,
      barcode:      cleanBarcode,
      name:         name.trim(),
      generic_name: generic_name?.trim() || null,
      company_name: company_name?.trim() || null,
      category:     category?.trim() || null,
      unit:         unit || 'Strip',
      purchase_rate:Number(purchase_rate) || 0,
      sales_rate:   Number(sales_rate),
      mrp:          Number(mrp) || 0,
      cc_percent:   Math.min(100, Math.max(0, Number(cc_percent) || 0)),
      min_stock:    Number(min_stock) || 50,
      is_active:    true,
    }).returning('*')

    await auditLog(req.companyId, req.user.id, 'CREATE', 'products', product.id, { name }, req.ip)
    return successResponse(res, product, 'Product created', 201)
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(400).json({ success: false, message: 'This barcode is already assigned to another product' })
    }
    next(err)
  }
})

/* ── PUT /products/:id ────────────────────────────────────────────────────── */
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await db('products')
      .where({ id: req.params.id, company_id: req.companyId })
      .first()
    if (!existing) return res.status(404).json({ success: false, message: 'Product not found' })

    const allowed = [
      'name', 'generic_name', 'company_name', 'category', 'unit', 'barcode',
      'purchase_rate', 'sales_rate', 'mrp', 'cc_percent', 'min_stock', 'is_active',
    ]
    const updates = {}
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (['purchase_rate', 'sales_rate', 'mrp', 'min_stock'].includes(k))
          updates[k] = Number(req.body[k])
        else if (k === 'cc_percent')
          updates[k] = Math.min(100, Math.max(0, Number(req.body[k]) || 0))
        else if (k === 'barcode')
          updates[k] = req.body[k]?.toString().trim() || null
        else
          updates[k] = req.body[k]
      }
    }

    if (updates.barcode) {
      const dupe = await db('products')
        .where({ company_id: req.companyId, barcode: updates.barcode })
        .whereNot({ id: req.params.id })
        .first('id')
      if (dupe)
        return res.status(400).json({ success: false, message: 'This barcode is already assigned to another product' })
    }

    const [updated] = await db('products')
      .where({ id: req.params.id })
      .update({ ...updates, updated_at: new Date() })
      .returning('*')

    await auditLog(req.companyId, req.user.id, 'UPDATE', 'products', req.params.id, updates, req.ip)
    return successResponse(res, updated)
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(400).json({ success: false, message: 'This barcode is already assigned to another product' })
    }
    next(err)
  }
})

/* ── DELETE /products/:id ─────────────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  try {
    const product = await db('products')
      .where({ id: req.params.id, company_id: req.companyId })
      .first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })

    const [{ count }] = await db('sale_items')
      .where({ product_id: req.params.id })
      .count('id as count')
    if (Number(count) > 0)
      return res.status(400).json({
        success: false,
        message: `Cannot delete — product has ${count} sale transaction(s). Deactivate instead.`,
      })

    // FIX: was db('stock_batches').del() — table does not exist
    await db(BATCHES_TABLE).where({ product_id: req.params.id }).del()
    await db('products').where({ id: req.params.id }).del()

    await auditLog(req.companyId, req.user.id, 'DELETE', 'products', req.params.id, { name: product.name }, req.ip)
    return successResponse(res, null, 'Product deleted')
  } catch (err) { next(err) }
})

/* ── POST /products/:id/adjust ────────────────────────────────────────────── */
router.post('/:id/adjust', async (req, res, next) => {
  try {
    const { qty, batch_no, expiry, purchase_rate, reason } = req.body
    if (!qty || isNaN(Number(qty)))
      return res.status(400).json({ success: false, message: 'Quantity is required' })

    const product = await db('products')
      .where({ id: req.params.id, company_id: req.companyId })
      .first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })

    const qtyNum  = Number(qty)
    const costNum = Number(purchase_rate) || Number(product.purchase_rate) || 0

    // FIX: was db('stock_batches').insert() with wrong columns
    //   - removed: qty_in, qty_out, purchase_rate, date_ad (none exist in migration 002)
    //   - added:   qty_received, qty_remaining, unit_cost, total_cost, receipt_date
    await db(BATCHES_TABLE).insert({
      company_id:   req.companyId,
      product_id:   req.params.id,
      batch_no:     batch_no || 'ADJ',
      expiry:       expiry   || null,
      expiry_date:  expiry   ? parseExpiryToDate(expiry) : null,
      receipt_date: new Date().toISOString().split('T')[0],
      qty_received: Math.abs(qtyNum),
      qty_remaining:Math.abs(qtyNum),   // real column name
      unit_cost:    costNum,
      total_cost:   Math.round(Math.abs(qtyNum) * costNum * 100) / 100,
    })

    await auditLog(req.companyId, req.user.id, 'ADJUST_STOCK', 'products', req.params.id, { qty, reason }, req.ip)
    return successResponse(res, null, 'Stock adjusted')
  } catch (err) { next(err) }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Parse an expiry string like "MM/YY" or "MM/YYYY" to a YYYY-MM-DD date
 * for the expiry_date (DATE) column. Returns null on invalid input.
 */
function parseExpiryToDate(expiry) {
  if (!expiry) return null
  try {
    const [mm, yy] = expiry.split('/')
    if (!mm || !yy) return null
    const year  = yy.length === 2 ? 2000 + Number(yy) : Number(yy)
    const month = Number(mm)
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null
    // Last day of the expiry month
    const lastDay = new Date(year, month, 0).getDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } catch {
    return null
  }
}

module.exports = router
