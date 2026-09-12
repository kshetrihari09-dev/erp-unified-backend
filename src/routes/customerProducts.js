/**
 * routes/customerProducts.js — Customer Product Ordering module.
 *
 * `resolveCustomerOrGuest`-gated, not `authenticateCustomer` — spec §14:
 * "Do not force registration merely to browse." A logged-in customer and
 * an anonymous browser both land here; every response goes through
 * customerCatalogService's resolveMany/toCatalogCard either way — the
 * customer never receives a raw `products` row (no cost price, no
 * internal flags, nothing beyond what toCatalogCard/toProductDetail
 * expose), regardless of whether they're signed in.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { resolveCustomerOrGuest } = require('../middleware/customerAuth')
const { resolveMany, toCatalogCard, toProductDetail } = require('../services/customerCatalogService')

router.use(resolveCustomerOrGuest)

/* ── GET /customer-products ───────────────────────────────────────────────
 * ?search=&category=&page=&limit= — server-side search/pagination (spec
 * #19/#49), never the whole catalog loaded into the browser. */
router.get('/', async (req, res, next) => {
  try {
    const { search, category, page = 1, limit = 24 } = req.query
    const lim = Math.min(60, Math.max(1, Number(limit) || 24))
    const offset = (Math.max(1, Number(page)) - 1) * lim

    let q = db('products')
      .where({ company_id: req.companyId, is_online: true, is_active: true })

    if (category) q = q.where('category', category)
    if (search) {
      q = q.where(b => b
        .whereILike('name', `%${search}%`)
        .orWhereILike('item_code', `%${search}%`)
        .orWhereILike('barcode', `%${search}%`)
        .orWhereILike('generic_name', `%${search}%`))
    }

    const total = Number((await q.clone().count('id as c').first())?.c || 0)
    const products = await q.clone()
      .orderBy('display_order', 'asc').orderBy('name', 'asc')
      .limit(lim).offset(offset)

    const resolved = await resolveMany(req.companyId, products)
    res.json({
      success: true,
      data: resolved.map(toCatalogCard),
      pagination: { total, page: Number(page), limit: lim, totalPages: Math.ceil(total / lim) },
    })
  } catch (err) { next(err) }
})

/* ── GET /customer-products/categories ────────────────────────────────────
 * Reuses the existing plain-string category column — no separate
 * categories table exists in this codebase, so none is created here. */
router.get('/categories', async (req, res, next) => {
  try {
    const rows = await db('products')
      .where({ company_id: req.companyId, is_online: true, is_active: true })
      .whereNotNull('category')
      .distinct('category')
      .orderBy('category')
    res.json({ success: true, data: rows.map(r => r.category).filter(Boolean) })
  } catch (err) { next(err) }
})

/* ── GET /customer-products/:id ───────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const product = await db('products')
      .where({ id: req.params.id, company_id: req.companyId, is_online: true, is_active: true })
      .first()
    // Same 404 whether the id doesn't exist, belongs to another company,
    // or is simply hidden from the online store — never confirm a hidden
    // product's existence to a customer (spec #53's "must not appear",
    // applied to direct-id lookups too, not just the list).
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' })

    const [resolved] = await resolveMany(req.companyId, [product])
    res.json({ success: true, data: toProductDetail(resolved) })
  } catch (err) { next(err) }
})

module.exports = router
