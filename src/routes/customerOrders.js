/**
 * routes/customerOrders.js — Customer Product Ordering module.
 *
 * POST / (checkout) is the one place this whole module's core promise —
 * "the customer can never control price or quantity" — is actually
 * enforced end to end. The request body is trusted for exactly nothing
 * except which cart to check out and delivery/payment preferences; every
 * price and every quantity comes from re-reading the cart's product_ids
 * against live product/availability data inside this transaction.
 *
 * Design note on the price-changed / stock-changed UX (spec #51/#52):
 * this cart (routes/customerCart.js) never stores or returns a cached
 * price — every read recomputes it live. So there is no "old price" a
 * customer could be looking at when they check out; the amount shown on
 * the cart screen a second ago and the amount charged now are, by
 * construction, the same query. What CAN still change between viewing
 * the cart and pressing "Place Order" is availability (another customer
 * bought the last few units in between) — that's what checkout's
 * validation pass below actually guards against, and it fails the whole
 * order (no partial order — spec #27/#24) with a clear per-line message
 * rather than silently adjusting quantities.
 *
 * Known, disclosed limitation: two customers checking out the same
 * near-empty stock at the exact same moment could both pass this
 * validation (the "reserved" count is read-then-compared, not a taken
 * lock) and both get an accepted PENDING order. This is deliberate scope
 * for this phase, not an oversight: physical stock is never touched here
 * — it's only ever deducted later, when staff confirm an order into a
 * real Sale, through routes/sales.js's createSaleHandler, which DOES use
 * a real atomic conditional UPDATE (see that file). So the absolute
 * worst case is a rare double-accepted order where the second one to be
 * confirmed correctly fails at that point with a clear insufficient-
 * stock error — never an actual oversold physical unit.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { resolveCustomerOrGuest } = require('../middleware/customerAuth')
const { resolveMany, validateQuantity } = require('../services/customerCatalogService')
const { auditLog, todayBS, nextPartyCode } = require('../utils/helpers')

// POST / (checkout) must work for both a logged-in customer AND a guest
// (spec §14) — resolveCustomerOrGuest, not authenticateCustomer, sets
// req.customer to null rather than rejecting when there's no token.
// GET / and GET /:id (order history) stay customer-only below via this
// small local guard — a guest has no login and so no order list to look
// at; the receipt returned directly from POST / is what a guest sees.
router.use(resolveCustomerOrGuest)
function requireLoggedInCustomer(req, res, next) {
  if (!req.customer) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Please log in to view your orders.' })
  next()
}

async function nextOrderNo(trx, companyId) {
  const year = (todayBS() || '2081-04-01').split('-')[0]
  const like = `CO-${year}-%`
  const row = await trx('customer_orders')
    .where({ company_id: companyId })
    .andWhereLike('order_no', like)
    .orderBy('order_no', 'desc')
    .first()
  const last = row ? parseInt(row.order_no.split('-').pop()) || 0 : 0
  return `CO-${year}-${String(last + 1).padStart(3, '0')}`
}

/* ── POST /customer-orders (checkout) ─────────────────────────────────────
 * Works for both a logged-in customer (persisted cart) and a guest
 * (spec §14 — the guest's cart lives in the browser and its contents are
 * submitted directly as `items`). Whichever path, everything past this
 * point — re-validation, pricing, totals — is the exact same code
 * operating on the exact same `cartRows` shape; a guest checkout is not
 * a second, parallel implementation of "place an order". */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { fulfillment_type, delivery_address, delivery_phone, delivery_notes, payment_method, notes } = req.body || {}

    if (fulfillment_type && !['pickup', 'delivery'].includes(fulfillment_type)) {
      await trx.rollback(); return res.status(400).json({ success: false, message: 'Invalid fulfillment type.' })
    }
    if (fulfillment_type === 'delivery' && !delivery_address?.trim()) {
      await trx.rollback(); return res.status(400).json({ success: false, message: 'Delivery address is required for delivery orders.' })
    }
    if (payment_method && !['cash_on_delivery', 'pay_at_store'].includes(payment_method)) {
      await trx.rollback(); return res.status(400).json({ success: false, message: 'Invalid payment method.' })
    }

    let cartRows
    let guestName = null, guestPhone = null

    if (req.customer) {
      // ── Logged-in path — re-read the persisted cart fresh, inside the
      // transaction (unchanged from before guest checkout existed) ──────
      cartRows = await trx('customer_cart_items as ci')
        .join('products as p', 'p.id', 'ci.product_id')
        .where('ci.customer_account_id', req.customer.accountId)
        .select('ci.id as cart_item_id', 'ci.quantity as cart_qty', 'p.*')

      if (!cartRows.length) {
        await trx.rollback(); return res.status(400).json({ success: false, code: 'CART_EMPTY', message: 'Your cart is empty.' })
      }
    } else {
      // ── Guest path — the cart arrives as a plain items array, exactly
      // what customerCart.js's POST /preview also accepts (spec §14). ──
      guestName = req.body?.guest_name?.trim()
      guestPhone = req.body?.guest_phone?.trim()
      if (!guestName) { await trx.rollback(); return res.status(400).json({ success: false, message: 'Name is required.' }) }
      if (!guestPhone) { await trx.rollback(); return res.status(400).json({ success: false, message: 'Phone number is required.' }) }

      const items = Array.isArray(req.body?.items) ? req.body.items : []
      const qtyByProduct = new Map()
      for (const it of items.slice(0, 100)) {
        const pid = it?.product_id
        const qty = Number(it?.quantity)
        if (!pid || !Number.isFinite(qty) || qty <= 0) continue
        qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + qty)
      }
      if (!qtyByProduct.size) {
        await trx.rollback(); return res.status(400).json({ success: false, code: 'CART_EMPTY', message: 'Your cart is empty.' })
      }

      // Same company scoping as every other product lookup in this
      // module — a product_id outside req.companyId, or for a deleted
      // product, simply won't be in `products` below and surfaces as a
      // per-line "not found" problem, never a silent cross-company read.
      const products = await trx('products').where({ company_id: req.companyId }).whereIn('id', [...qtyByProduct.keys()])
      const foundIds = new Set(products.map(p => p.id))
      cartRows = products.map(p => ({ cart_item_id: null, cart_qty: qtyByProduct.get(p.id), ...p }))

      const missingProblems = [...qtyByProduct.keys()]
        .filter(pid => !foundIds.has(pid))
        .map(pid => ({ product_id: pid, name: null, message: 'Product not found or no longer available.' }))
      if (missingProblems.length) {
        await trx.rollback()
        return res.status(409).json({ success: false, code: 'CART_INVALID', message: 'Some items in your cart need attention.', problems: missingProblems })
      }
    }

    const products = cartRows.map(({ cart_item_id, cart_qty, ...p }) => p)
    const resolved = await resolveMany(req.companyId, products)

    // ── Full re-validation — every line, no partial order on any failure ──
    const problems = []
    resolved.forEach((r, i) => {
      const cartQty = Number(cartRows[i].cart_qty)
      if (!r.product.is_online || !r.product.is_active) {
        problems.push({ product_id: r.product.id, name: r.product.name, message: 'This product is no longer available online.' })
        return
      }
      const check = validateQuantity(r.resolved, cartQty)
      if (!check.ok) problems.push({ product_id: r.product.id, name: r.product.name, message: check.message })
    })

    if (problems.length) {
      await trx.rollback()
      return res.status(409).json({ success: false, code: 'CART_INVALID', message: 'Some items in your cart need attention.', problems })
    }

    // ── Server-computed totals — nothing from req.body ─────────────────────
    // See this file's docblock for why discount/tax are 0: no per-product
    // tax or rule-based discount exists anywhere in the existing Sales
    // module either (sale_items has no tax column, and discount there is
    // an ad-hoc cashier entry, not a business rule this module could
    // "reuse" — spec #24's own instruction is to only show fields backed
    // by a real existing rule).
    let subtotal = 0
    const orderItemRows = resolved.map((r, i) => {
      const qty = Number(cartRows[i].cart_qty)
      const lineSubtotal = Math.round(r.resolved.price * qty * 100) / 100
      subtotal += lineSubtotal
      return {
        product_id: r.product.id,
        product_name_snapshot: r.product.name,
        unit_snapshot: r.product.unit || null,
        unit_price: r.resolved.price,
        quantity: qty,
        subtotal: lineSubtotal,
      }
    })
    subtotal = Math.round(subtotal * 100) / 100
    const discount_amount = 0
    const tax_amount = 0
    const delivery_charge = 0 // no delivery-fee rule configured anywhere yet — see final report
    const grand_total = Math.round((subtotal - discount_amount + tax_amount + delivery_charge) * 100) / 100

    // ── Guest party: created only now, once the order is known to be
    // valid (still inside the same transaction, so a failure anywhere
    // above rolls this back too — no orphaned party from a rejected
    // order). A fresh party every guest order, deliberately never
    // reused/deduped by phone: matching an existing party by a
    // guest-typed phone number risks attaching a guest's order to a
    // real registered customer's ledger if the numbers happen to
    // coincide. See the final report for this trade-off.
    let partyId, customerAccountId, isGuest
    if (req.customer) {
      partyId = req.customer.partyId
      customerAccountId = req.customer.accountId
      isGuest = false
    } else {
      const code = await nextPartyCode(req.companyId, 'customer')
      const [guestParty] = await trx('parties').insert({
        company_id: req.companyId, code, type: 'customer', name: guestName, phone: guestPhone,
      }).returning('*')
      partyId = guestParty.id
      customerAccountId = null
      isGuest = true
    }

    const order_no = await nextOrderNo(trx, req.companyId)
    const [order] = await trx('customer_orders').insert({
      company_id: req.companyId,
      customer_account_id: customerAccountId,
      party_id: partyId,
      is_guest: isGuest,
      order_no,
      fulfillment_type: fulfillment_type || 'pickup',
      delivery_address: fulfillment_type === 'delivery' ? delivery_address.trim() : null,
      delivery_phone: fulfillment_type === 'delivery' ? (delivery_phone?.trim() || req.customer?.phone || guestPhone) : null,
      delivery_notes: notes?.trim() || delivery_notes?.trim() || null,
      payment_method: payment_method || 'pay_at_store',
      subtotal, discount_amount, tax_amount, delivery_charge, grand_total,
    }).returning('*')

    await trx('customer_order_items').insert(orderItemRows.map(it => ({ ...it, order_id: order.id })))
    if (req.customer) await trx('customer_cart_items').where({ customer_account_id: req.customer.accountId }).delete()

    await trx.commit()
    await auditLog(req.companyId, null, 'CREATE', 'customer_order', order.id, { order_no, grand_total, is_guest: isGuest }, req.ip)

    res.status(201).json({ success: true, data: { ...order, items: orderItemRows } })
  } catch (err) {
    await trx.rollback()
    next(err)
  }
})

/* ── GET /customer-orders (own history) ───────────────────────────────── */
router.get('/', requireLoggedInCustomer, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query
    const lim = Math.min(50, Number(limit) || 20)
    const offset = (Math.max(1, Number(page)) - 1) * lim

    let q = db('customer_orders').where({ customer_account_id: req.customer.accountId })
    const total = Number((await q.clone().count('id as c').first())?.c || 0)
    const orders = await q.clone().orderBy('created_at', 'desc').limit(lim).offset(offset)

    res.json({
      success: true, data: orders,
      pagination: { total, page: Number(page), limit: lim, totalPages: Math.ceil(total / lim) },
    })
  } catch (err) { next(err) }
})

/* ── GET /customer-orders/:id ──────────────────────────────────────────────
 * Ownership is enforced in the WHERE clause itself, not checked after the
 * fact — an order belonging to another customer simply doesn't match the
 * query and comes back 404, never confirming to a caller that a given
 * order id exists at all under someone else's account (spec #40's IDOR
 * requirement, applied the same way sales.js/reminders.js already do it
 * for their own ownership checks). */
router.get('/:id', requireLoggedInCustomer, async (req, res, next) => {
  try {
    const order = await db('customer_orders')
      .where({ id: req.params.id, customer_account_id: req.customer.accountId })
      .first()
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })

    const items = await db('customer_order_items').where({ order_id: order.id }).orderBy('created_at')
    res.json({ success: true, data: { ...order, items } })
  } catch (err) { next(err) }
})

module.exports = router
