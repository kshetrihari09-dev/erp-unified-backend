/**
 * stock.js — FIXED
 *
 * Original line → bug → fix:
 *
 * L16: db('stock_batches')                        → db('inventory_batches')
 * L18: .sum('qty_available as total_stock')       → .sum('qty_remaining as total_stock')
 * L19: .sum('qty_available * purchase_rate ...')  → .sum('qty_remaining * unit_cost ...')
 * L37: raw SQL 'stock_batches' (×2)               → 'inventory_batches' (×2)
 *      raw SQL 'qty_available' (×2)               → 'qty_remaining' (×2)
 *      raw SQL 'purchase_rate'                    → 'unit_cost'
 * L50: db('stock_batches as sb')                  → db('inventory_batches as sb')
 *      .andWhere('sb.qty_available', '>', 0)      → .andWhere('sb.qty_remaining', '>', 0)
 *      .select(... 'sb.qty_available' ...)        → aliased back as qty_available for frontend compat
 *      .select(... 'sb.purchase_rate' ...)        → 'sb.unit_cost as purchase_rate'
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')

router.use(authenticate)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /stock ────────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 50)
    const { search } = req.query

    // L16-19 FIX: stock_batches → inventory_batches,
    //             qty_available → qty_remaining, purchase_rate → unit_cost
    let q = db('products as p')
      .leftJoin(
        db(T)                                              // L16 FIX
          .where({ company_id: req.companyId })
          .groupBy('product_id')
          .select('product_id')
          .sum(`${QTY} as total_stock`)                   // L18 FIX
          .select(db.raw(`SUM(${QTY} * unit_cost) as stock_value`)) // L19 FIX
          .as('sb'),
        'p.id', 'sb.product_id'
      )
      .where('p.company_id', req.companyId)
      .andWhere('p.is_active', true)
      .select(
        'p.id', 'p.item_code', 'p.name', 'p.company_name',
        'p.unit', 'p.min_stock', 'p.purchase_rate', 'p.sales_rate', 'p.mrp',
        db.raw('COALESCE(sb.total_stock, 0) AS current_stock'),
        db.raw('COALESCE(sb.stock_value,  0) AS stock_value'),
        db.raw(`CASE WHEN COALESCE(sb.total_stock,0) < p.min_stock
                THEN true ELSE false END AS low_stock`)
      )

    if (search) q = q.where(b => b.whereILike('p.name', `%${search}%`).orWhereILike('p.item_code', `%${search}%`))

    const [{ count }] = await q.clone().clearSelect().count('p.id as count')
    const data        = await q.orderBy('p.name').limit(limit).offset(offset)

    // L37 FIX: raw SQL used stock_batches (×2), qty_available (×2), purchase_rate
    const aggResult = await db.raw(`
      SELECT
        COALESCE(SUM(ib.qty_remaining * ib.unit_cost), 0) AS total_value,
        COUNT(DISTINCT CASE
          WHEN COALESCE(sb2.stock, 0) < p.min_stock THEN p.id
        END) AS low_stock_count
      FROM products p
      LEFT JOIN inventory_batches ib
        ON ib.product_id = p.id AND ib.company_id = p.company_id
      LEFT JOIN (
        SELECT product_id, SUM(qty_remaining) AS stock
        FROM inventory_batches
        WHERE company_id = ?
        GROUP BY product_id
      ) sb2 ON sb2.product_id = p.id
      WHERE p.company_id = ? AND p.is_active = true
    `, [req.companyId, req.companyId])

    const agg = aggResult?.rows?.[0] ?? aggResult?.[0] ?? {}
    const summary = {
      total_value:     Number(agg.total_value)     || 0,
      low_stock_count: Number(agg.low_stock_count) || 0,
    }

    return paginatedResponse(res, { data, total: Number(count), page, limit, summary })
  } catch (err) { next(err) }
})

/* ── GET /stock/batches ────────────────────────────────────────────────────── */
router.get('/batches', async (req, res, next) => {
  try {
    const { expiring_in_days } = req.query

    // L50 FIX:
    //   db('stock_batches as sb')          → db('inventory_batches as sb')
    //   sb.qty_available > 0               → sb.qty_remaining > 0
    //   select 'sb.qty_available'          → sb.qty_remaining AS qty_available (alias)
    //   select 'sb.purchase_rate'          → sb.unit_cost AS purchase_rate (alias)
    let q = db(`${T} as sb`)
      .join('products as p', 'sb.product_id', 'p.id')
      .where('sb.company_id', req.companyId)
      .andWhere(`sb.${QTY}`, '>', 0)                    // L50 FIX: was 'sb.qty_available'
      .select(
        'p.name as product_name',
        'p.item_code',
        'sb.batch_no',
        'sb.expiry',
        'sb.expiry_date',
        `sb.${QTY} as qty_available`,                   // L50 FIX: alias for frontend compat
        `sb.${QTY} as qty_remaining`,
        'sb.unit_cost as purchase_rate',                 // L50 FIX: alias for frontend compat
        'p.sales_rate',
      )
      .orderBy('sb.expiry_date', 'asc')

    if (expiring_in_days) {
      const cutoff = new Date(Date.now() + Number(expiring_in_days) * 86400000)
        .toISOString().split('T')[0]
      q = q.where('sb.expiry_date', '<=', cutoff).whereNotNull('sb.expiry_date')
    }

    const data = await q
    return successResponse(res, data)
  } catch (err) { next(err) }
})

module.exports = router
