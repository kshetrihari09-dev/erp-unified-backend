/**
 * purchaseSuggestionsEngine.js — Smart Low-Stock Purchase Suggestion engine.
 *
 * Single entry point (getSuggestions) that:
 *   1. Resolves the effective settings (company defaults + optional
 *      product-specific overrides).
 *   2. Runs a small, fixed number of aggregate SQL queries (no per-product
 *      loop, no N+1) to gather sales, stock, and incoming-PO quantities.
 *   3. Combines everything in memory to classify each product and compute
 *      its recommended purchase quantity.
 *
 * Data-source notes (read before changing the queries below):
 *
 *   - "Completed sales" = sales.status = 'active' (cancelled/voided sales
 *     are excluded by definition — see migration 002's `status` enum).
 *   - Returns: this codebase has no per-line sales-return ledger table.
 *     A sales return (routes/returns.js POST /sales) re-adds stock by
 *     inserting a row into inventory_batches with batch_no = 'RETURN'
 *     (unless the caller supplied its own batch_no). We treat those rows,
 *     dated within the selected period, as the returned-quantity signal
 *     and net them out of gross sold quantity. This is a pragmatic best
 *     effort given the existing schema, not a perfectly attributed
 *     return-per-invoice figure.
 *   - "Reserved stock" has no backing concept in this system (no sales
 *     order / hold module) — it is always 0. The considerReservedStock
 *     setting is kept for forward compatibility if such a module is added.
 *   - "Incoming stock" = purchase_order_items.qty_ordered - qty_received
 *     for purchase_orders with status in ('pending','approved',
 *     'partially_received') — see migration 031.
 *   - Multi-warehouse: this system has a single stock pool per company
 *     (no warehouse/location table exists). All stock queries are already
 *     company-scoped; there is nothing further to filter by location.
 */
const db = require('../db/knex')
const { withDefaults } = require('../utils/settingsDefaults')

const OPEN_PO_STATUSES = ['pending', 'approved', 'partially_received']

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

function addDaysISO(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

function daysBetweenInclusive(fromISO, toISO) {
  const ms = new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')
  return Math.max(1, Math.round(ms / 86400000) + 1)
}

/** Resolve { dateFrom, dateTo, days } from period/custom-range query params. */
function resolveDateRange({ period, date_from, date_to }, defaultPeriodDays) {
  if (date_from && date_to) {
    return { dateFrom: date_from, dateTo: date_to, days: daysBetweenInclusive(date_from, date_to) }
  }
  const days = [7, 30, 60, 90].includes(Number(period)) ? Number(period) : defaultPeriodDays
  const dateTo   = todayISO()
  const dateFrom = addDaysISO(dateTo, -(days - 1))
  return { dateFrom, dateTo, days }
}

/**
 * Classify a product's suggestion status.
 * Order matters: Critical/Low/Reorder Recommended/Healthy are about days
 * remaining and reorder point; No Sales Data overrides all of them when
 * there genuinely was no sales activity to base a recommendation on.
 */
function classifyStatus({ avgDailySales, daysRemaining, availableStock, reorderPoint, thresholds }) {
  if (avgDailySales <= 0) return 'no_sales_data'
  if (daysRemaining !== null && daysRemaining <= thresholds.criticalStockDays) return 'critical'
  if (daysRemaining !== null && daysRemaining <= thresholds.lowStockDays) return 'low_stock'
  if (availableStock <= reorderPoint) return 'reorder_recommended'
  return 'healthy'
}

const STATUS_LABELS = {
  critical:             'Critical',
  low_stock:            'Low Stock',
  reorder_recommended:  'Reorder Recommended',
  healthy:              'Healthy',
  no_sales_data:        'No Sales Data',
}

/**
 * Core calculation — returns the full, unpaginated, unfiltered list of
 * suggestion rows for a company plus the settings used to compute them.
 * Callers (the route) apply search/status/supplier/category filters and
 * pagination on top of this.
 */
async function computeAll(companyId, queryParams = {}) {
  const company = await db('companies').where({ id: companyId }).first('settings')
  const settings = withDefaults(company?.settings || {}).purchaseSuggestions

  const { dateFrom, dateTo, days } = resolveDateRange(queryParams, settings.defaultPeriodDays)

  // ── 1. Active products (optionally filtered by supplier/category) ──────
  let productsQ = db('products as p')
    .leftJoin('parties as sup', 'p.preferred_supplier_id', 'sup.id')
    .where('p.company_id', companyId)
    .andWhere('p.is_active', true)
    .andWhere('p.exclude_from_suggestions', false)
    .select(
      'p.id', 'p.item_code', 'p.name', 'p.category', 'p.unit', 'p.min_stock',
      'p.purchase_rate', 'p.preferred_supplier_id',
      'sup.name as preferred_supplier_name',
      'p.supplier_lead_time_days', 'p.safety_stock_days', 'p.safety_stock_qty',
      'p.reorder_point_override',
    )
  if (queryParams.supplier_id) productsQ = productsQ.andWhere('p.preferred_supplier_id', queryParams.supplier_id)
  if (queryParams.category_id) productsQ = productsQ.andWhere('p.category', queryParams.category_id)
  const products = await productsQ
  if (!products.length) return { rows: [], summary: emptySummary(), dateFrom, dateTo, days, settings }

  const productIds = products.map(p => p.id)

  // ── 2. Gross sold qty per product in period (completed sales only) ─────
  const soldRows = await db('sale_items as si')
    .join('sales as s', 'si.sale_id', 's.id')
    .where('s.company_id', companyId)
    .andWhere('s.status', 'active')
    .andWhereBetween('s.date_ad', [dateFrom, dateTo])
    .whereIn('si.product_id', productIds)
    .groupBy('si.product_id')
    .select('si.product_id')
    .sum('si.qty as gross_qty')

  // ── 3. Returned qty per product in period (see file header note) ───────
  const returnedRows = await db('inventory_batches')
    .where({ company_id: companyId, batch_no: 'RETURN' })
    .andWhereBetween('receipt_date', [dateFrom, dateTo])
    .whereIn('product_id', productIds)
    .groupBy('product_id')
    .select('product_id')
    .sum('qty_received as returned_qty')

  // ── 4. Current stock per product (company-wide; single stock pool) ─────
  const stockRows = await db('inventory_batches')
    .where({ company_id: companyId })
    .whereIn('product_id', productIds)
    .groupBy('product_id')
    .select('product_id')
    .sum('qty_remaining as current_stock')

  // ── 5. Incoming stock per product (open purchase orders) ───────────────
  const incomingRows = settings.considerIncomingPurchaseOrders
    ? await db('purchase_order_items as poi')
        .join('purchase_orders as po', 'poi.purchase_order_id', 'po.id')
        .where('po.company_id', companyId)
        .whereIn('po.status', OPEN_PO_STATUSES)
        .whereIn('poi.product_id', productIds)
        .groupBy('poi.product_id')
        .select('poi.product_id')
        .sum(db.raw('(poi.qty_ordered - poi.qty_received) as incoming_qty'))
    : []

  // ── 6. Latest purchase rate per product (fallback price source) ────────
  const latestRateRows = await db('purchase_items as pi')
    .join('purchases as pu', 'pi.purchase_id', 'pu.id')
    .where('pu.company_id', companyId)
    .andWhere('pu.status', 'active')
    .whereIn('pi.product_id', productIds)
    .distinctOn('pi.product_id')
    .orderBy('pi.product_id')
    .orderBy('pu.date_ad', 'desc')
    .select('pi.product_id', 'pi.rate as latest_rate')

  const soldMap     = mapBy(soldRows, 'product_id', 'gross_qty')
  const returnedMap = mapBy(returnedRows, 'product_id', 'returned_qty')
  const stockMap    = mapBy(stockRows, 'product_id', 'current_stock')
  const incomingMap = mapBy(incomingRows, 'product_id', 'incoming_qty')
  const rateMap     = mapBy(latestRateRows, 'product_id', 'latest_rate')

  const rows = products.map((p) => {
    const grossSold    = Number(soldMap[p.id] || 0)
    const returnedQty  = Number(returnedMap[p.id] || 0)
    const netSold      = Math.max(0, grossSold - returnedQty)
    const avgDailySales = netSold / days

    const currentStock   = Number(stockMap[p.id] || 0)
    const reservedStock  = settings.considerReservedStock ? 0 : 0 // no reservation module exists; see file header
    const availableStock = currentStock - reservedStock

    const incomingStock = Number(incomingMap[p.id] || 0)

    const useProductOverrides = settings.useProductSpecificSettings
    const leadTimeDays = (useProductOverrides && p.supplier_lead_time_days != null)
      ? Number(p.supplier_lead_time_days)
      : settings.defaultLeadTimeDays

    const leadTimeDemand = avgDailySales * leadTimeDays

    let safetyStock
    if (useProductOverrides && p.safety_stock_qty != null) {
      safetyStock = Number(p.safety_stock_qty) // manual override wins outright
    } else {
      const safetyStockDays = (useProductOverrides && p.safety_stock_days != null)
        ? Number(p.safety_stock_days)
        : settings.safetyStockDays
      safetyStock = avgDailySales * safetyStockDays
    }

    const reorderPoint = (useProductOverrides && p.reorder_point_override != null)
      ? Number(p.reorder_point_override)
      : (leadTimeDemand + safetyStock)

    const netRequired = reorderPoint - availableStock - incomingStock
    const suggestedQty = Math.max(0, Math.round(netRequired * 100) / 100)

    const daysRemaining = avgDailySales > 0 ? Math.round((availableStock / avgDailySales) * 10) / 10 : null

    const status = classifyStatus({
      avgDailySales, daysRemaining, availableStock, reorderPoint,
      thresholds: { criticalStockDays: settings.criticalStockDays, lowStockDays: settings.lowStockDays },
    })

    const latestPurchasePrice = rateMap[p.id] != null ? Number(rateMap[p.id]) : (Number(p.purchase_rate) || null)
    const estimatedValue = latestPurchasePrice != null ? Math.round(suggestedQty * latestPurchasePrice * 100) / 100 : null

    return {
      product_id:          p.id,
      item_code:           p.item_code,
      name:                p.name,
      category:            p.category,
      unit:                p.unit,
      current_stock:       currentStock,
      available_stock:     availableStock,
      reserved_stock:      reservedStock,
      avg_daily_sales:     Math.round(avgDailySales * 100) / 100,
      total_sold:          netSold,
      returned_qty:        returnedQty,
      lead_time_days:      leadTimeDays,
      lead_time_demand:    Math.round(leadTimeDemand * 100) / 100,
      safety_stock:        Math.round(safetyStock * 100) / 100,
      reorder_point:       Math.round(reorderPoint * 100) / 100,
      incoming_stock:      incomingStock,
      suggested_qty:       suggestedQty,
      days_remaining:      daysRemaining, // null → render as "No recent sales"
      status,
      status_label:        STATUS_LABELS[status],
      preferred_supplier_id:   p.preferred_supplier_id || null,
      preferred_supplier_name: p.preferred_supplier_name || null,
      latest_purchase_price:   latestPurchasePrice,
      estimated_value:         estimatedValue, // null → render as "Price unavailable"
    }
  })

  return { rows, dateFrom, dateTo, days, settings }
}

function mapBy(rows, keyField, valField) {
  const map = {}
  for (const r of rows) map[r[keyField]] = r[valField]
  return map
}

function emptySummary() {
  return { products_to_purchase: 0, critical_products: 0, total_suggested_qty: 0, total_estimated_value: 0 }
}

function summarize(rows) {
  const actionable = rows.filter(r => r.suggested_qty > 0)
  return {
    products_to_purchase:  actionable.length,
    critical_products:     rows.filter(r => r.status === 'critical').length,
    total_suggested_qty:   actionable.reduce((s, r) => s + r.suggested_qty, 0),
    total_estimated_value: actionable.reduce((s, r) => s + (r.estimated_value || 0), 0),
  }
}

/**
 * getSuggestions — applies search/status filters and pagination on top of
 * computeAll(), and returns { data, total, summary, meta }.
 * By default (no `status` param, no includeZeroSalesProducts override) it
 * only returns products that require action, per requirement #10/#11.
 */
async function getSuggestions(companyId, queryParams = {}) {
  const { rows: allRows, dateFrom, dateTo, days, settings } = await computeAll(companyId, queryParams)

  const showAll = queryParams.status === 'all'
  let rows = allRows
  if (queryParams.status && queryParams.status !== 'all') {
    rows = rows.filter(r => r.status === queryParams.status)
  } else if (!showAll) {
    // Default view (no status filter given): only products requiring
    // action. "No Sales Data" products are excluded unless the company
    // has opted in via includeZeroSalesProducts.
    rows = rows.filter(r => r.status !== 'healthy' && (r.status !== 'no_sales_data' || settings.includeZeroSalesProducts))
  }

  if (queryParams.search) {
    const s = String(queryParams.search).toLowerCase()
    rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.item_code || '').toLowerCase().includes(s))
  }

  // Summary is computed over the full (unpaginated, but post status/search
  // filter within the "requires action" view) result set the user is
  // looking at conceptually — matches the header cards on the page.
  const summary = summarize(showAll || queryParams.status ? rows : allRows.filter(r => r.status !== 'healthy'))

  const total = rows.length
  const page  = Math.max(1, parseInt(queryParams.page) || 1)
  const limit = Math.min(200, parseInt(queryParams.limit) || 50)
  const data  = rows.slice((page - 1) * limit, (page - 1) * limit + limit)

  return { data, total, page, limit, summary, meta: { dateFrom, dateTo, days } }
}

module.exports = { getSuggestions, computeAll, classifyStatus, resolveDateRange }
