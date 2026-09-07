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
const { authenticateCustomer } = require('../middleware/customerAuth')
const { resolveMany, validateQuantity } = require('../services/customerCatalogService')
const { auditLog, todayBS } = require('../utils/helpers')

router.use(authenticateCustomer)

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

/* ── POST /customer-orders (checkout) ─────────────────────────────────── */
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

    // ── Re-read the cart fresh, inside the transaction ────────────────────
    const cartRows = await trx('customer_cart_items as ci')
      .join('products as p', 'p.id', 'ci.product_id')
      .where('ci.customer_account_id', req.customer.accountId)
      .select('ci.id as cart_item_id', 'ci.quantity as cart_qty', 'p.*')

    if (!cartRows.length) {
      await trx.rollback(); return res.status(400).json({ success: false, code: 'CART_EMPTY', message: 'Your cart is empty.' })
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

    const order_no = await nextOrderNo(trx, req.companyId)
    const [order] = await trx('customer_orders').insert({
      company_id: req.companyId,
      customer_account_id: req.customer.accountId,
      party_id: req.customer.partyId,
      order_no,
      fulfillment_type: fulfillment_type || 'pickup',
      delivery_address: fulfillment_type === 'delivery' ? delivery_address.trim() : null,
      delivery_phone: fulfillment_type === 'delivery' ? (delivery_phone?.trim() || req.customer.phone) : null,
      delivery_notes: notes?.trim() || delivery_notes?.trim() || null,
      payment_method: payment_method || 'pay_at_store',
      subtotal, discount_amount, tax_amount, delivery_charge, grand_total,
    }).returning('*')

    await trx('customer_order_items').insert(orderItemRows.map(it => ({ ...it, order_id: order.id })))
    await trx('customer_cart_items').where({ customer_account_id: req.customer.accountId }).delete()

    await trx.commit()
    await auditLog(req.companyId, null, 'CREATE', 'customer_order', order.id, { order_no, grand_total }, req.ip)

    res.status(201).json({ success: true, data: { ...order, items: orderItemRows } })
  } catch (err) {
    await trx.rollback()
    next(err)
  }
})

/* ── GET /customer-orders (own history) ───────────────────────────────── */
router.get('/', async (req, res, next) => {
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
router.get('/:id', async (req, res, next) => {
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
