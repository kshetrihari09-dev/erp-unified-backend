/**
 * routes/customerCart.js — Customer Product Ordering module.
 *
 * customer_cart_items stores ONLY product_id + quantity (migration 035).
 * Every response here recomputes price/availability fresh via
 * customerCatalogService — the cart table is never a place a price could
 * be read back from, because no price is ever written into it.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { authenticateCustomer, resolveCustomerOrGuest } = require('../middleware/customerAuth')
const { resolveMany, validateQuantity, toCatalogCard } = require('../services/customerCatalogService')

/* ── Shared computation: rows → the {items, subtotal, has_issues, ...}
 * shape both the persisted cart (below) and the stateless guest preview
 * (POST /preview) return. `rows` is any array of
 * {cart_item_id, cart_qty, ...productFields} — cart_item_id is null for
 * the guest preview, which has no persisted row to point back at. */
async function computeCartResponse(companyId, rows) {
  const products = rows.map(r => {
    const { cart_item_id, cart_qty, ...product } = r
    return product
  })
  const resolved = await resolveMany(companyId, products)

  let subtotal = 0
  const items = resolved.map((r, i) => {
    const cartQty = Number(rows[i].cart_qty)
    const card = toCatalogCard(r)
    const lineSubtotal = Math.round(card.price * cartQty * 100) / 100
    subtotal += lineSubtotal

    // Surfaced so the frontend can show "price changed" / "only N left"
    // banners (spec #51/#52) without a separate endpoint — every cart
    // read already re-validates every line against current data.
    const check = validateQuantity(r.resolved, cartQty)

    return {
      cart_item_id: rows[i].cart_item_id,
      product_id: card.id,
      name: card.name,
      unit: card.unit,
      image_url: card.image_url,
      price: card.price,
      unit_label: card.unit_label,
      quantity: cartQty,
      subtotal: lineSubtotal,
      stock_label: card.stock_label,
      min_qty: card.min_qty, max_qty: card.max_qty, qty_step: card.qty_step,
      valid: check.ok,
      issue: check.ok ? null : check.message,
      still_online: !!(r.product.is_online && r.product.is_active),
    }
  })

  return {
    items,
    has_issues: items.some(i => !i.valid || !i.still_online),
    subtotal: Math.round(subtotal * 100) / 100,
    // See routes/customerOrders.js for why these are 0 rather than
    // invented: no product-level tax and no discount-by-rule exist
    // anywhere in the existing Sales module either — there is no
    // existing business rule to reuse here, so nothing is fabricated in
    // its place.
    discount_amount: 0,
    tax_amount: 0,
  }
}

async function buildCartResponse(companyId, customerAccountId) {
  const rows = await db('customer_cart_items as ci')
    .join('products as p', 'p.id', 'ci.product_id')
    .where('ci.customer_account_id', customerAccountId)
    .select('ci.id as cart_item_id', 'ci.quantity as cart_qty', 'p.*')
  return computeCartResponse(companyId, rows)
}

/* ── POST /customer-cart/preview ──────────────────────────────────────────
 * Guest checkout's equivalent of GET /customer-cart: there's no server-
 * side guest cart to persist to (a guest has no identity to key one on —
 * see routes/customerOrders.js's guest checkout branch for why that's a
 * deliberate scope choice, not an oversight), so the guest cart lives in
 * the browser and this endpoint just prices/validates whatever it's
 * holding — same live price/availability computation as the real cart,
 * nothing cached or persisted. `resolveCustomerOrGuest`-gated so a
 * logged-in customer could technically call this too (harmless — it's
 * pure/stateless), but its actual purpose is the guest cart page. */
router.post('/preview', resolveCustomerOrGuest, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!items.length) return res.json({ success: true, data: { items: [], has_issues: false, subtotal: 0, discount_amount: 0, tax_amount: 0 } })

    // Merge duplicate product_ids (defensive — a client bug sending the
    // same line twice shouldn't double-count) and cap the line count so
    // an anonymous caller can't force an unbounded query.
    const qtyByProduct = new Map()
    for (const it of items.slice(0, 100)) {
      const pid = it?.product_id
      const qty = Number(it?.quantity)
      if (!pid || !Number.isFinite(qty) || qty <= 0) continue
      qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + qty)
    }
    const productIds = [...qtyByProduct.keys()]
    if (!productIds.length) return res.json({ success: true, data: { items: [], has_issues: false, subtotal: 0, discount_amount: 0, tax_amount: 0 } })

    const products = await db('products').where({ company_id: req.companyId }).whereIn('id', productIds)
    // Rows for a product_id that doesn't resolve (deleted, wrong company,
    // never existed) are simply omitted here rather than erroring the
    // whole preview — routes/customerOrders.js's checkout does the same
    // "the client's list is a request, never a guarantee" re-validation
    // one more time anyway, so a stale line in a guest's browser-held
    // cart fails at the point that actually matters.
    const rows = products.map(p => ({ cart_item_id: null, cart_qty: qtyByProduct.get(p.id), ...p }))

    res.json({ success: true, data: await computeCartResponse(req.companyId, rows) })
  } catch (err) { next(err) }
})

router.use(authenticateCustomer)

/* ── GET /customer-cart ───────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await buildCartResponse(req.companyId, req.customer.accountId) })
  } catch (err) { next(err) }
})

/* ── POST /customer-cart ──────────────────────────────────────────────────
 * Adds to cart, or — if this product is already in the cart — increases
 * it (spec #22: "Add" on an existing line grows the quantity, it doesn't
 * create a duplicate row; migration 035's unique constraint enforces this
 * at the DB level too). */
router.post('/', async (req, res, next) => {
  try {
    const { product_id, quantity } = req.body || {}
    if (!product_id || !quantity) return res.status(400).json({ success: false, message: 'product_id and quantity are required.' })

    const product = await db('products').where({ id: product_id, company_id: req.companyId, is_online: true, is_active: true }).first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found or not available online.' })

    const existing = await db('customer_cart_items').where({ customer_account_id: req.customer.accountId, product_id }).first()
    const newQty = Number(existing?.quantity || 0) + Number(quantity)

    const [resolved] = await resolveMany(req.companyId, [product])
    const check = validateQuantity(resolved.resolved, newQty)
    if (!check.ok) return res.status(400).json({ success: false, code: 'QUANTITY_INVALID', message: check.message })

    if (existing) {
      await db('customer_cart_items').where({ id: existing.id }).update({ quantity: newQty, updated_at: new Date() })
    } else {
      await db('customer_cart_items').insert({ customer_account_id: req.customer.accountId, product_id, quantity: newQty })
    }

    res.status(201).json({ success: true, data: await buildCartResponse(req.companyId, req.customer.accountId) })
  } catch (err) { next(err) }
})

/* ── PATCH /customer-cart/:itemId ─────────────────────────────────────────
 * Sets the ABSOLUTE quantity (not a delta) — the [-] / [+] steppers and a
 * typed quantity both just PATCH to the resulting number. */
router.patch('/:itemId', async (req, res, next) => {
  try {
    const { quantity } = req.body || {}
    if (!quantity || Number(quantity) <= 0) return res.status(400).json({ success: false, message: 'Quantity must be greater than 0 — use DELETE to remove this item.' })

    const item = await db('customer_cart_items').where({ id: req.params.itemId, customer_account_id: req.customer.accountId }).first()
    if (!item) return res.status(404).json({ success: false, message: 'Cart item not found.' })

    const product = await db('products').where({ id: item.product_id, company_id: req.companyId }).first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' })

    const [resolved] = await resolveMany(req.companyId, [product])
    const check = validateQuantity(resolved.resolved, quantity)
    if (!check.ok) return res.status(400).json({ success: false, code: 'QUANTITY_INVALID', message: check.message })

    await db('customer_cart_items').where({ id: item.id }).update({ quantity: Number(quantity), updated_at: new Date() })
    res.json({ success: true, data: await buildCartResponse(req.companyId, req.customer.accountId) })
  } catch (err) { next(err) }
})

/* ── DELETE /customer-cart/:itemId ────────────────────────────────────── */
router.delete('/:itemId', async (req, res, next) => {
  try {
    const deleted = await db('customer_cart_items')
      .where({ id: req.params.itemId, customer_account_id: req.customer.accountId })
      .delete()
    if (!deleted) return res.status(404).json({ success: false, message: 'Cart item not found.' })
    res.json({ success: true, data: await buildCartResponse(req.companyId, req.customer.accountId) })
  } catch (err) { next(err) }
})

/* ── DELETE /customer-cart ────────────────────────────────────────────────
 * Clear the whole cart (spec #22). Own route rather than overloading
 * DELETE /:itemId with a magic "all" id. */
router.delete('/', async (req, res, next) => {
  try {
    await db('customer_cart_items').where({ customer_account_id: req.customer.accountId }).delete()
    res.json({ success: true, data: await buildCartResponse(req.companyId, req.customer.accountId) })
  } catch (err) { next(err) }
})

module.exports = router
