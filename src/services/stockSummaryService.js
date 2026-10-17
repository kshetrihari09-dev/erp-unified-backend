/**
 * stockSummaryService.js — Stock & Sales Summary (all products, one period).
 *
 * NO NEW STOCK RULES. Every figure comes from the same movement definition
 * the per-product Stock Register uses (stockRegisterService.movementsSQL):
 *
 *   PU  purchases           stock += qty + bonus   (cancelled purchases excluded)
 *   SL  sales               stock -= qty           (cancelled sales excluded; sale bonus is
 *                                                   shown as Free-Sale but never changes stock)
 *   RV  stock receipts      stock += qty (+ bonus)
 *   SRN sales returns       stock += qty
 *   PRN purchase returns    stock -= qty
 *   ADJ opening/adjustment  stock += qty
 *
 *   opening = net effect of every movement dated BEFORE `from`
 *   closing = net effect of every movement dated ON OR BEFORE `to`
 *           = opening + purchased + free(purchase) + receipts + sales returns
 *                     + adjustments − purchase returns − sold
 *
 * VALUES
 *   Sales Value      Σ sale_items.amount of active sales in the period — i.e. net of the line
 *                    discount and including CC, exactly as the invoice recorded it. With
 *                    include_discount = false it is the pre-discount value Σ qty × rate.
 *   Purchase Value   Σ purchase_items.amount of active purchases in the period.
 *   Latest Purchase Rate
 *                    rate of the most recent PU/RV line dated on or before `to` (falls back to the
 *                    latest ADJ/opening-stock rate). Evaluated AS OF `to`, never today's price.
 *   Stock Value      closing qty × Latest Purchase Rate as of `to`.
 *                    (The app keeps no historical per-batch cost snapshot, so a true historical
 *                    FIFO value cannot be reconstructed; the Stock page's live value uses
 *                    current batch cost and is only comparable when `to` is today.)
 *
 * Single stock pool per company (no store/branch table exists) — every query is scoped by
 * company_id taken from the authenticated session, never from the request.
 */
const db = require('../db/knex')
const { movementsSQL, batchExpiryFilter } = require('./stockRegisterService')
const { isValidUUID } = require('../utils/helpers')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000
const bad = (m) => Object.assign(new Error(m), { status: 400 })

const MAX_LIMIT = 200
const MAX_EXPORT_ROWS = 50000

/** Whitelist: request value → SQL expression over the `sel` CTE. Nothing user-typed reaches SQL. */
const SORTS = {
  name: 'name', code: 'item_code', opening: 'opening', purchased: 'purchased',
  sold: 'sold', closing: 'closing', rate: 'rate',
  stock_value: 'stock_value', sales_value: 'sales_value',
}
const STOCK_STATUS = ['all', 'in_stock', 'low', 'zero']
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())

/** Validates + normalizes raw query params. Throws status-400 errors. */
function validateFilters(q = {}) {
  const from = q.from || q.date_from, to = q.to || q.date_to
  if (!from || !to) throw bad('From and To dates are required')
  if (!DATE_RE.test(from) || Number.isNaN(Date.parse(from))) throw bad('from must be a valid YYYY-MM-DD date')
  if (!DATE_RE.test(to)   || Number.isNaN(Date.parse(to)))   throw bad('to must be a valid YYYY-MM-DD date')
  if (from > to) throw bad('From date cannot be after To date')

  const expiryFrom = q.expiry_from || undefined, expiryTo = q.expiry_to || undefined
  for (const [k, v] of [['expiry_from', expiryFrom], ['expiry_to', expiryTo]]) {
    if (v && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) throw bad(`${k} must be a valid YYYY-MM-DD date`)
  }
  if (expiryFrom && expiryTo && expiryFrom > expiryTo) throw bad('Expiry From cannot be after Expiry To')

  const stockStatus = q.stock_status || 'all'
  if (!STOCK_STATUS.includes(stockStatus)) throw bad(`stock_status must be one of ${STOCK_STATUS.join(', ')}`)

  const sortBy = q.sort_by || 'name'
  if (!SORTS[sortBy]) throw bad(`sort_by must be one of ${Object.keys(SORTS).join(', ')}`)
  const sortDir = String(q.sort_dir || 'asc').toLowerCase()
  if (!['asc', 'desc'].includes(sortDir)) throw bad('sort_dir must be asc or desc')

  const supplierId = q.supplier_id || undefined
  if (supplierId && !isValidUUID(String(supplierId))) throw bad('supplier_id is not valid')

  const all   = truthy(q.all)
  const page  = Math.max(1, parseInt(q.page, 10) || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit, 10) || 50))

  const clean = (v, max = 150) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : undefined }
  return {
    from, to, expiryFrom, expiryTo, stockStatus, sortBy, sortDir, supplierId, all, page, limit,
    company:  clean(q.company), category: clean(q.category),
    search:   clean(q.search),  batch: clean(q.batch, 100),
    includeInactive: truthy(q.include_inactive),
    includeDiscount: q.include_discount === undefined ? true : truthy(q.include_discount),
  }
}

/** Builds the shared CTE chain + binds. Exported so tests can assert filters reach the SQL. */
async function buildSummarySQL(companyId, f) {
  const mv = await movementsSQL(true, { allProducts: true })
  const be = batchExpiryFilter({ batch: f.batch, expiryFrom: f.expiryFrom, expiryTo: f.expiryTo })
  const hasMovementFilter = !!be.sql

  const bind = {
    cid: companyId, from: f.from, to: f.to, incdisc: !!f.includeDiscount, ...be.bind,
  }

  const pw = ['p.company_id = :cid']
  if (!f.includeInactive) pw.push('p.is_active = true')
  if (f.company)  { pw.push('LOWER(p.company_name) = LOWER(:f_company)'); bind.f_company = f.company }
  if (f.category) { pw.push('LOWER(p.category) = LOWER(:f_category)');    bind.f_category = f.category }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, m => '\\' + m)}%`
    pw.push('(p.name ILIKE :f_search OR p.item_code ILIKE :f_search OR p.barcode ILIKE :f_search)')
    bind.f_search = like
  }
  if (f.supplierId) {
    // Products that this supplier has supplied (non-cancelled purchases dated on/before `to`).
    pw.push(`EXISTS (SELECT 1 FROM purchase_items spi JOIN purchases spu ON spu.id = spi.purchase_id
                      WHERE spu.company_id = :cid AND spu.party_id = :f_supplier AND spu.status <> 'cancelled'
                        AND spi.product_id = p.id AND spu.date_ad <= CAST(:to AS date))`)
    bind.f_supplier = f.supplierId
  }
  // With a batch/expiry restriction only products that actually have matching movements are listed.
  if (hasMovementFilter) pw.push('a.product_id IS NOT NULL')

  const stockWhere = {
    all: 'true', in_stock: 'closing > 0', zero: 'closing <= 0', low: 'closing > 0 AND closing < min_stock',
  }[f.stockStatus]

  const cte = `
    WITH mv AS (${mv}),
    fm AS (
      SELECT * FROM mv
       WHERE dt <= CAST(:to AS date) ${be.sql}
    ),
    agg AS (
      SELECT product_id,
        SUM(CASE WHEN dt <  CAST(:from AS date) THEN qty_in - qty_out + qty_free * free_effect ELSE 0 END) AS opening,
        SUM(qty_in - qty_out + qty_free * free_effect)                                                     AS closing,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'PU'  THEN qty_in  ELSE 0 END) AS purchased,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'PU'  THEN qty_free ELSE 0 END) AS free_in,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'RV'  THEN qty_in + qty_free * free_effect ELSE 0 END) AS received,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'PRN' THEN qty_out - qty_free * free_effect ELSE 0 END) AS purchase_returns,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SL'  THEN qty_out ELSE 0 END) AS sold,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SL'  THEN qty_free ELSE 0 END) AS free_out,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SRN' THEN qty_in + qty_free * free_effect ELSE 0 END) AS sales_returns,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'ADJ' THEN qty_in - qty_out + qty_free * free_effect ELSE 0 END) AS adjustments,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'PU'  THEN line_value ELSE 0 END) AS purchase_value,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SL'  THEN line_value ELSE 0 END) AS sales_value_net,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SL'  THEN line_gross ELSE 0 END) AS sales_value_gross,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SL'  THEN line_disc  ELSE 0 END) AS sales_discount,
        SUM(CASE WHEN dt >= CAST(:from AS date) AND ty = 'SRN' THEN line_value ELSE 0 END) AS sales_return_value
      FROM fm GROUP BY product_id
    ),
    last_in AS (
      SELECT DISTINCT ON (product_id) product_id, rate FROM fm
       WHERE ty IN ('PU','RV') AND rate > 0
       ORDER BY product_id, dt DESC, ts DESC, rid DESC
    ),
    last_adj AS (
      SELECT DISTINCT ON (product_id) product_id, rate FROM fm
       WHERE ty = 'ADJ' AND rate > 0
       ORDER BY product_id, dt DESC, ts DESC, rid DESC
    ),
    base AS (
      SELECT p.id, p.item_code, p.name, p.unit, p.company_name, p.category,
             COALESCE(p.min_stock, 0)::numeric AS min_stock, p.is_active,
             COALESCE(a.opening, 0)           AS opening,
             COALESCE(a.purchased, 0)         AS purchased,
             COALESCE(a.received, 0)          AS received,
             COALESCE(a.free_in, 0)           AS free_in,
             COALESCE(a.purchase_returns, 0)  AS purchase_returns,
             COALESCE(a.sold, 0)              AS sold,
             COALESCE(a.free_out, 0)          AS free_out,
             COALESCE(a.sales_returns, 0)     AS sales_returns,
             COALESCE(a.adjustments, 0)       AS adjustments,
             COALESCE(a.closing, 0)           AS closing,
             COALESCE(li.rate, la.rate, 0)    AS rate,
             COALESCE(a.closing, 0) * COALESCE(li.rate, la.rate, 0) AS stock_value,
             COALESCE(a.purchase_value, 0)    AS purchase_value,
             CASE WHEN CAST(:incdisc AS boolean) THEN COALESCE(a.sales_value_net, 0)
                  ELSE COALESCE(a.sales_value_gross, 0) END AS sales_value,
             COALESCE(a.sales_discount, 0)    AS sales_discount,
             COALESCE(a.sales_return_value,0) AS sales_return_value
        FROM products p
        LEFT JOIN agg a      ON a.product_id  = p.id
        LEFT JOIN last_in li ON li.product_id = p.id
        LEFT JOIN last_adj la ON la.product_id = p.id
       WHERE ${pw.join(' AND ')}
    ),
    sel AS (SELECT * FROM base WHERE ${stockWhere})`
  return { cte, bind }
}

const NUM_FIELDS = [
  'opening', 'purchased', 'received', 'free_in', 'purchase_returns', 'sold', 'free_out',
  'sales_returns', 'adjustments', 'closing', 'rate', 'stock_value', 'purchase_value',
  'sales_value', 'sales_discount', 'sales_return_value', 'min_stock',
]
const rowsOf = (r) => r.rows ?? r

function shapeRow(r) {
  const o = { id: r.id, item_code: r.item_code || '', name: r.name, unit: r.unit || '',
              company_name: r.company_name || '', category: r.category || '', is_active: r.is_active }
  for (const k of NUM_FIELDS) o[k] = k === 'stock_value' || k.endsWith('_value') || k === 'rate' || k === 'sales_discount'
    ? round2(r[k]) : round4(r[k])
  o.status = o.closing <= 0 ? 'out' : (o.closing < o.min_stock ? 'low' : 'ok')
  return o
}

function shapeTotals(t = {}) {
  const n = (k) => Number(t[k]) || 0
  return {
    total_products: n('total_products'),
    opening: round4(n('opening')), purchased: round4(n('purchased')), received: round4(n('received')),
    free_in: round4(n('free_in')), purchase_returns: round4(n('purchase_returns')), sold: round4(n('sold')),
    free_out: round4(n('free_out')), sales_returns: round4(n('sales_returns')),
    adjustments: round4(n('adjustments')), closing: round4(n('closing')),
    stock_value: round2(n('stock_value')), purchase_value: round2(n('purchase_value')),
    sales_value: round2(n('sales_value')), sales_discount: round2(n('sales_discount')),
    sales_return_value: round2(n('sales_return_value')),
    net_sales_value: round2(n('sales_value') - n('sales_return_value')),
    low_stock_count: n('low_stock_count'), out_of_stock_count: n('out_of_stock_count'),
  }
}

/**
 * Paginated summary + totals over ALL filtered products (not just the page).
 * `filters` must already have been through validateFilters().
 */
async function getSummary(companyId, f) {
  const { cte, bind } = await buildSummarySQL(companyId, f)
  const orderExpr = SORTS[f.sortBy], dir = f.sortDir === 'desc' ? 'DESC' : 'ASC'
  const order = `ORDER BY ${orderExpr} ${dir} NULLS LAST, name ASC, id ASC`

  const totalsSQL = `${cte}
    SELECT COUNT(*) AS total_products,
      COALESCE(SUM(opening),0) opening, COALESCE(SUM(purchased),0) purchased, COALESCE(SUM(received),0) received,
      COALESCE(SUM(free_in),0) free_in, COALESCE(SUM(purchase_returns),0) purchase_returns,
      COALESCE(SUM(sold),0) sold, COALESCE(SUM(free_out),0) free_out, COALESCE(SUM(sales_returns),0) sales_returns,
      COALESCE(SUM(adjustments),0) adjustments, COALESCE(SUM(closing),0) closing,
      COALESCE(SUM(stock_value),0) stock_value, COALESCE(SUM(purchase_value),0) purchase_value,
      COALESCE(SUM(sales_value),0) sales_value, COALESCE(SUM(sales_discount),0) sales_discount,
      COALESCE(SUM(sales_return_value),0) sales_return_value,
      COUNT(*) FILTER (WHERE closing > 0 AND closing < min_stock) AS low_stock_count,
      COUNT(*) FILTER (WHERE closing <= 0)                         AS out_of_stock_count
    FROM sel`

  const paged = f.all
    ? { sql: `${cte} SELECT * FROM sel ${order} LIMIT ${MAX_EXPORT_ROWS}`, b: bind }
    : { sql: `${cte} SELECT * FROM sel ${order} LIMIT :lim OFFSET :off`, b: { ...bind, lim: f.limit, off: (f.page - 1) * f.limit } }

  const [tRes, rRes] = await Promise.all([db.raw(totalsSQL, bind), db.raw(paged.sql, paged.b)])
  const totals = shapeTotals(rowsOf(tRes)[0])
  const rows = rowsOf(rRes).map(shapeRow)
  return {
    filters: {
      from: f.from, to: f.to, company: f.company || null, category: f.category || null, search: f.search || null,
      supplier_id: f.supplierId || null, batch: f.batch || null, expiry_from: f.expiryFrom || null,
      expiry_to: f.expiryTo || null, include_inactive: f.includeInactive, stock_status: f.stockStatus,
      include_discount: f.includeDiscount,
    },
    rows, totals,
    pagination: f.all
      ? { page: 1, limit: rows.length, total: totals.total_products, pages: 1 }
      : { page: f.page, limit: f.limit, total: totals.total_products, pages: Math.max(1, Math.ceil(totals.total_products / f.limit)) },
  }
}

/** Distinct manufacturers/categories for the filter dropdowns (company-scoped). */
async function getFilterOptions(companyId) {
  const distinct = async (col) => (await db('products').where({ company_id: companyId })
    .whereNotNull(col).whereRaw(`TRIM(${col}) <> ''`).distinct(col).orderBy(col)).map(r => r[col])
  const [companies, categories] = await Promise.all([distinct('company_name'), distinct('category')])
  return { companies, categories }
}

/**
 * Batch-level view for one product: per batch opening / in / out / closing in the period.
 * Honors the same period + batch/expiry filters; scoped by company.
 */
async function getBatchBreakdown(companyId, { productId, from, to, batch, expiryFrom, expiryTo }) {
  if (!productId || !isValidUUID(String(productId))) throw bad('product_id is required')
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) throw bad('from and to must be YYYY-MM-DD')
  if (from > to) throw bad('From date cannot be after To date')
  const owned = await db('products').where({ id: productId, company_id: companyId }).first('id')
  if (!owned) throw Object.assign(new Error('Product not found'), { status: 404 })

  const mv = await movementsSQL(true)
  const be = batchExpiryFilter({ batch, expiryFrom, expiryTo })
  const res = await db.raw(`
    WITH mv AS (${mv}), fm AS (SELECT * FROM mv WHERE dt <= CAST(:to AS date) ${be.sql})
    SELECT COALESCE(NULLIF(batch,''), '(no batch)') AS batch_no, MAX(expiry_date) AS expiry_date, MAX(expiry) AS expiry,
      SUM(CASE WHEN dt <  CAST(:from AS date) THEN qty_in - qty_out + qty_free * free_effect ELSE 0 END) AS opening,
      SUM(CASE WHEN dt >= CAST(:from AS date) THEN qty_in + qty_free * free_effect ELSE 0 END) AS qty_in,
      SUM(CASE WHEN dt >= CAST(:from AS date) THEN qty_out ELSE 0 END) AS qty_out,
      SUM(qty_in - qty_out + qty_free * free_effect) AS closing
    FROM fm GROUP BY COALESCE(NULLIF(batch,''), '(no batch)')
    ORDER BY MAX(expiry_date) NULLS LAST, 1`,
  { cid: companyId, pid: productId, from, to, ...be.bind })
  return rowsOf(res).map(r => ({
    batch_no: r.batch_no,
    expiry: r.expiry || (r.expiry_date ? String(r.expiry_date instanceof Date ? r.expiry_date.toISOString() : r.expiry_date).slice(0, 7) : ''),
    opening: round4(r.opening), qty_in: round4(r.qty_in), qty_out: round4(r.qty_out), closing: round4(r.closing),
  }))
}

/** CSV — same figures/filters as the screen (UTF-8 BOM so Excel opens it cleanly). */
function toCSV(rep) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const f = rep.filters, t = rep.totals
  const L = []
  L.push(q('Stock & Sales Summary'))
  L.push(['Period', f.from, 'to', f.to].map(q).join(','))
  const applied = [
    f.company && `Company: ${f.company}`, f.category && `Category: ${f.category}`, f.search && `Search: ${f.search}`,
    f.batch && `Batch: ${f.batch}`, f.expiry_from && `Expiry from: ${f.expiry_from}`, f.expiry_to && `Expiry to: ${f.expiry_to}`,
    f.supplier_id && 'Supplier filter applied', f.stock_status !== 'all' && `Stock: ${f.stock_status}`,
    f.include_inactive && 'Inactive included', `Sales value ${f.include_discount ? 'net of discount' : 'before discount'}`,
  ].filter(Boolean)
  L.push(q(`Filters: ${applied.join(' | ')}`))
  L.push('')
  L.push(['Product Code', 'Product Name', 'Unit', 'Opening Stock', 'Purchased Qty', 'Stock Receipts', 'Free Qty (Purchase)',
    'Purchase Returns', 'Sales Qty', 'Free Qty (Sale)', 'Sales Returns', 'Adjustments', 'Closing Stock',
    'Latest Purchase Rate', 'Stock Value', 'Purchase Value', 'Sales Value'].map(q).join(','))
  for (const r of rep.rows) {
    L.push([r.item_code, r.name, r.unit, r.opening, r.purchased, r.received, r.free_in, r.purchase_returns, r.sold,
      r.free_out, r.sales_returns, r.adjustments, r.closing, r.rate, r.stock_value, r.purchase_value, r.sales_value].map(q).join(','))
  }
  L.push(['', `Total (${t.total_products} products)`, '', t.opening, t.purchased, t.received, t.free_in, t.purchase_returns,
    t.sold, t.free_out, t.sales_returns, t.adjustments, t.closing, '', t.stock_value, t.purchase_value, t.sales_value].map(q).join(','))
  return '\uFEFF' + L.join('\r\n') + '\r\n'
}

module.exports = { validateFilters, buildSummarySQL, getSummary, getFilterOptions, getBatchBreakdown, toCSV, SORTS, shapeRow, shapeTotals }
