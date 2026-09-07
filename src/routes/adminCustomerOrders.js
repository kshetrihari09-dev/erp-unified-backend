/**
 * routes/adminCustomerOrders.js — Customer Product Ordering module.
 *
 * Staff-facing. Uses the existing `authenticate` middleware (never
 * authenticateCustomer) — same access level as the rest of the admin
 * app today (no new can_manage_* flag introduced here; say the word if
 * you want order confirmation restricted to a subset of roles).
 *
 * The important piece is confirmOrder() below: converting a PENDING
 * order into CONFIRMED calls routes/sales.js's exported createSaleHandler
 * directly — the exact same function `POST /sales` itself calls — by
 * constructing a synthetic req/res pair, rather than re-implementing
 * "create a sale" a second time. That function already owns: the
 * idempotency check, the date-sequence validation, the batched atomic
 * stock deduction (the one and only place physical stock is ever
 * touched for a customer order — migration 034's docblock), sale_items
 * insert, and accounting posting. Nothing about that logic is duplicated
 * or reimplemented here.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { createSaleHandler } = require('./sales')
const { auditLog } = require('../utils/helpers')

router.use(authenticate)

const STATUS_FLOW = ['pending', 'confirmed', 'processing', 'ready', 'completed']

/** Calls createSaleHandler exactly as Express would, but in-process — no
 *  network hop, no second auth check (we already know who the staff user
 *  is), and its response is captured instead of sent to a real client. */
function callCreateSaleHandler({ companyId, userId, ip, body }) {
  return new Promise((resolve, reject) => {
    const req = { companyId, user: { id: userId }, ip, body, deviceId: null }
    const res = {
      _status: 200,
      status(code) { this._status = code; return this },
      json(payload) { resolve({ status: this._status, body: payload }) },
    }
    Promise.resolve(createSaleHandler(req, res, reject)).catch(reject)
  })
}

/* ── GET /admin/customer-orders ───────────────────────────────────────────
 * ?status=&search=&page=&limit= */
router.get('/', async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query
    const lim = Math.min(100, Number(limit) || 20)
    const offset = (Math.max(1, Number(page)) - 1) * lim

    let q = db('customer_orders as co')
      .join('parties as p', 'p.id', 'co.party_id')
      .where('co.company_id', req.companyId)

    if (status) q = q.where('co.status', status)
    if (search) {
      q = q.where(b => b.whereILike('co.order_no', `%${search}%`).orWhereILike('p.name', `%${search}%`).orWhereILike('p.phone', `%${search}%`))
    }

    const total = Number((await q.clone().count('co.id as c').first())?.c || 0)
    const orders = await q.clone()
      .orderBy('co.created_at', 'desc').limit(lim).offset(offset)
      .select('co.*', 'p.name as customer_name', 'p.phone as customer_phone')

    res.json({ success: true, data: orders, pagination: { total, page: Number(page), limit: lim, totalPages: Math.ceil(total / lim) } })
  } catch (err) { next(err) }
})

/* ── GET /admin/customer-orders/:id ───────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const order = await db('customer_orders as co')
      .join('parties as p', 'p.id', 'co.party_id')
      .where({ 'co.id': req.params.id, 'co.company_id': req.companyId })
      .select('co.*', 'p.name as customer_name', 'p.phone as customer_phone', 'p.email as customer_email')
      .first()
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })

    const items = await db('customer_order_items').where({ order_id: order.id }).orderBy('created_at')
    res.json({ success: true, data: { ...order, items } })
  } catch (err) { next(err) }
})

/* ── PATCH /admin/customer-orders/:id/status ──────────────────────────── */
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, cancel_reason } = req.body || {}
    const validStatuses = [...STATUS_FLOW, 'cancelled']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${validStatuses.join(', ')}` })
    }

    const order = await db('customer_orders').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })
    if (order.status === 'completed' || order.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `This order is already ${order.status} and cannot be changed.` })
    }

    // ── Cancel ──────────────────────────────────────────────────────────
    if (status === 'cancelled') {
      await db('customer_orders').where({ id: order.id }).update({
        status: 'cancelled', cancelled_at: new Date(), cancel_reason: cancel_reason || null, updated_at: new Date(),
      })
      await auditLog(req.companyId, req.user.id, 'CANCEL', 'customer_order', order.id, { cancel_reason }, req.ip)
      return res.json({ success: true, data: await db('customer_orders').where({ id: order.id }).first() })
    }

    // ── Forward progression only (no skipping backward, no skipping steps
    //    except the confirm step itself which does real work below) ──────
    const currentIdx = STATUS_FLOW.indexOf(order.status)
    const targetIdx  = STATUS_FLOW.indexOf(status)
    if (targetIdx <= currentIdx) {
      return res.status(400).json({ success: false, message: `Cannot move from ${order.status} back to ${status}.` })
    }

    // ── Confirm: this is where a real Sale gets created ──────────────────
    if (status === 'confirmed') {
      const items = await db('customer_order_items').where({ order_id: order.id })
      const saleResult = await callCreateSaleHandler({
        companyId: req.companyId,
        userId: req.user.id,
        ip: req.ip,
        body: {
          party_id: order.party_id,
          date_ad: new Date().toISOString().slice(0, 10),
          // No online payment gateway exists (spec #26) — both
          // cash_on_delivery and pay_at_store are collected in person,
          // so both map to a normal cash sale. Staff can correct this
          // afterward with the existing PUT /sales/:id/payment-mode
          // endpoint if a given order should actually be on credit.
          payment_mode: 'cash',
          reference_no: order.order_no,
          notes: `Online order ${order.order_no}`,
          items: items.map(it => ({
            product_id: it.product_id,
            product_name: it.product_name_snapshot,
            qty: Number(it.quantity),
            rate: Number(it.unit_price),
            batch_id: null, // no batch is exposed to the online catalog — the
            batch_no: null, // existing FIFO fallback in sales.js selects one
          })),
        },
      })

      if (saleResult.status >= 400) {
        // The sale genuinely could not be created (most likely: stock was
        // taken by something else between order-acceptance and this
        // confirmation — see this file's docblock on the disclosed race
        // window). The order stays PENDING, unmodified, so staff can
        // retry once stock is sorted out rather than the order silently
        // vanishing into a broken confirmed-but-no-sale state.
        return res.status(saleResult.status).json(saleResult.body)
      }

      const sale = saleResult.body?.data
      await db('customer_orders').where({ id: order.id }).update({
        status: 'confirmed', sale_id: sale?.id || null, confirmed_by: req.user.id, confirmed_at: new Date(), updated_at: new Date(),
      })
      await auditLog(req.companyId, req.user.id, 'CONFIRM', 'customer_order', order.id, { sale_id: sale?.id, invoice_no: sale?.invoice_no }, req.ip)
      return res.json({ success: true, data: await db('customer_orders').where({ id: order.id }).first() })
    }

    // ── Everything else (processing/ready/completed) is a plain status move —
    //    stock was already deducted at confirmation; nothing further to do. ──
    await db('customer_orders').where({ id: order.id }).update({ status, updated_at: new Date() })
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'customer_order', order.id, { status }, req.ip)
    res.json({ success: true, data: await db('customer_orders').where({ id: order.id }).first() })
  } catch (err) { next(err) }
})

module.exports = router
