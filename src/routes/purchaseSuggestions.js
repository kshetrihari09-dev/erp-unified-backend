/**
 * routes/purchaseSuggestions.js — Smart Low-Stock Purchase Suggestion API
 *
 *   GET  /purchase-suggestions              — list (filters + pagination)
 *   GET  /purchase-suggestions/summary      — header summary cards
 *   GET  /purchase-suggestions/settings     — effective settings (company + docs on product overrides)
 *   PUT  /purchase-suggestions/settings     — update company-level settings
 *   POST /purchase-suggestions/create-purchase-orders
 *
 * Permissions (see migration 031 + middleware/index.js requirePermission):
 *   view_purchase_suggestions            — GET routes
 *   manage_purchase_suggestions          — (reserved for future bulk actions)
 *   configure_purchase_suggestion_settings — PUT settings
 *   create_po_from_suggestions           — POST create-purchase-orders
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { v4: uuid } = require('uuid')
const { authenticate, requirePermission } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { withDefaults, mergeSettings } = require('../utils/settingsDefaults')
const { getSuggestions } = require('../services/purchaseSuggestionsEngine')
const { auditLog, nextOrderNo } = require('../utils/helpers')

router.use(authenticate)

/* ── GET /purchase-suggestions ────────────────────────────────────────────── */
router.get('/', requirePermission('view_purchase_suggestions'), async (req, res, next) => {
  try {
    const result = await getSuggestions(req.companyId, req.query)
    return res.json({
      success: true,
      data: result.data,
      pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: Math.ceil(result.total / result.limit) },
      summary: result.summary,
      meta: result.meta,
    })
  } catch (err) { next(err) }
})

/* ── GET /purchase-suggestions/summary ───────────────────────────────────── */
router.get('/summary', requirePermission('view_purchase_suggestions'), async (req, res, next) => {
  try {
    // Reuse the same engine with a large limit so the summary reflects the
    // full actionable set, not just the caller's current page.
    const result = await getSuggestions(req.companyId, { ...req.query, page: 1, limit: 1 })
    return successResponse(res, { ...result.summary, ...result.meta })
  } catch (err) { next(err) }
})

/* ── GET /purchase-suggestions/settings ──────────────────────────────────── */
router.get('/settings', requirePermission('view_purchase_suggestions'), async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first('settings')
    return successResponse(res, withDefaults(company?.settings || {}).purchaseSuggestions)
  } catch (err) { next(err) }
})

/* ── PUT /purchase-suggestions/settings ──────────────────────────────────── */
router.put('/settings', requirePermission('configure_purchase_suggestion_settings'), async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first('settings')
    const merged  = mergeSettings(company?.settings || {}, { purchaseSuggestions: req.body || {} })
    await db('companies').where({ id: req.companyId }).update({ settings: JSON.stringify(merged), updated_at: new Date() })
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'purchase_suggestion_settings', req.companyId, Object.keys(req.body || {}), req.ip)
    return successResponse(res, merged.purchaseSuggestions, 'Purchase suggestion settings saved')
  } catch (err) { next(err) }
})

/* ── POST /purchase-suggestions/create-purchase-orders ───────────────────
 * Body: { items: [{ product_id, qty, rate? }], supplier_id? }
 * Groups selected products by preferred supplier (or the explicit
 * supplier_id override, if every item shares one) and creates one
 * purchase_orders row + purchase_order_items per supplier group, in
 * 'pending' status. Never auto-approves or auto-receives — the user
 * reviews/edits before this call (frontend), and an admin/manager still
 * has to approve + eventually record the real bill via POST /purchases
 * (with purchase_order_id) to receive stock, exactly like a manually
 * created purchase order would.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/create-purchase-orders', requirePermission('create_po_from_suggestions'), async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { items } = req.body
    if (!Array.isArray(items) || !items.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'At least one item is required' })
    }

    const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))]
    const products = await trx('products')
      .where({ company_id: req.companyId })
      .whereIn('id', productIds)
      .select('id', 'name', 'purchase_rate', 'preferred_supplier_id')
    const productMap = Object.fromEntries(products.map(p => [p.id, p]))

    // ── Group by supplier: explicit item.supplier_id > product's preferred
    // supplier > "unassigned" bucket (still creates a PO, just without a
    // linked supplier, so nothing silently gets dropped).
    const groups = new Map() // supplierId|'unassigned' -> items[]
    for (const item of items) {
      const product = productMap[item.product_id]
      if (!product) continue
      const qty = Number(item.qty)
      if (!(qty > 0)) continue
      const supplierId = item.supplier_id || product.preferred_supplier_id || 'unassigned'
      if (!groups.has(supplierId)) groups.set(supplierId, [])
      groups.get(supplierId).push({
        product_id:   product.id,
        product_name: product.name,
        qty_ordered:  qty,
        rate:         Number(item.rate) || Number(product.purchase_rate) || 0,
      })
    }

    if (!groups.size) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'No valid items to order' })
    }

    const createdOrders = []
    for (const [supplierId, groupItems] of groups.entries()) {
      const orderNo = await nextOrderNo(trx, req.companyId)
      const estimatedTotal = groupItems.reduce((s, i) => s + (i.qty_ordered * i.rate), 0)

      const [order] = await trx('purchase_orders').insert({
        id:               uuid(),
        company_id:       req.companyId,
        supplier_id:      supplierId === 'unassigned' ? null : supplierId,
        created_by:       req.user.id,
        order_no:         orderNo,
        order_date:       new Date().toISOString().split('T')[0],
        source:           'suggestion',
        status:           'pending',
        estimated_total:  Math.round(estimatedTotal * 100) / 100,
      }).returning('*')

      const orderItems = groupItems.map(i => ({
        id: uuid(),
        purchase_order_id: order.id,
        product_id:   i.product_id,
        product_name: i.product_name,
        qty_ordered:  i.qty_ordered,
        rate:         i.rate,
        amount:       Math.round(i.qty_ordered * i.rate * 100) / 100,
      }))
      await trx('purchase_order_items').insert(orderItems)

      createdOrders.push({ ...order, items: orderItems })
    }

    await auditLog(req.companyId, req.user.id, 'CREATE', 'purchase_orders',
      createdOrders.map(o => o.id).join(','), { count: createdOrders.length, source: 'suggestion' }, req.ip)

    await trx.commit()
    return successResponse(res, createdOrders, `${createdOrders.length} purchase order(s) created`, 201)
  } catch (err) { await trx.rollback(); next(err) }
})

module.exports = router
