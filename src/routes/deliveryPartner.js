/**
 * routes/deliveryPartner.js — the rider-facing API. Mounted at
 * /api/v1/delivery (see server.js).
 *
 * Uses the existing staff `authenticate` middleware: a delivery partner
 * is a `users` row with role='delivery_partner' (migration 038), so
 * company scoping, token handling, and deactivation all work exactly as
 * they already do for a cashier. No second auth realm was introduced.
 *
 * ── The two rules this file exists to enforce ──────────────────────────
 *
 *  1. A rider never sees the code. Nothing in any response from any
 *     endpoint here contains delivery_otp_secret, delivery_otp_hash, or
 *     a decrypted code — the select lists below are explicit allow-lists
 *     precisely so a future column can't leak in through a `select('*')`
 *     (spec §15). The rider learns the code from the customer's mouth,
 *     which is the entire point of the mechanism: if the app could show
 *     it to them, it would prove nothing about whether they actually
 *     reached the customer.
 *
 *  2. A rider can only ever act on their own assigned order. Every
 *     query below filters on assigned_delivery_partner_id = req.user.id
 *     in the WHERE clause itself rather than fetching and then checking,
 *     so another rider's order is indistinguishable from a nonexistent
 *     one (404, never 403) — the same IDOR shape customerOrders.js
 *     already uses for customer order access (spec §10).
 *
 * Neither rule trusts anything from the request body. Order status,
 * assignment, and OTP validity are all re-read from the database inside
 * the transaction that acts on them.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { auditLog } = require('../utils/helpers')
const otp = require('../services/deliveryOtpService')
const notifier = require('../services/deliveryOtpNotifier')

router.use(authenticate)

/** Riders only. Owner passes requireRole by design (middleware/index.js),
 *  which is harmless here — every query is scoped to the caller's own
 *  assignments, so an owner hitting these endpoints simply sees the
 *  orders assigned to them, i.e. usually none. */
function requireDeliveryPartner(req, res, next) {
  if (req.user?.role === 'delivery_partner' || req.user?.role === 'owner') return next()
  return res.status(403).json({
    success: false,
    code: 'ROLE_FORBIDDEN',
    message: 'This area is for delivery partners.',
  })
}
router.use(requireDeliveryPartner)

/* ── What a rider is allowed to know about an order ───────────────────────
 * Customer name and delivery address/phone: yes, they cannot deliver
 * without them. Customer email, internal party code, order costs beyond
 * the collectable total, and every OTP column: no (spec §24). */
const RIDER_ORDER_FIELDS = [
  'co.id', 'co.order_no', 'co.status', 'co.fulfillment_type',
  'co.delivery_address', 'co.delivery_phone', 'co.delivery_notes',
  'co.payment_method', 'co.payment_status', 'co.grand_total',
  'co.delivery_assigned_at', 'co.delivery_arrived_at', 'co.delivered_at',
  'co.created_at',
]

/** Strip the row down to what goes on the wire, and attach the OTP
 *  *state* (never the code). One place, so no endpoint can forget. */
function riderView(order) {
  const { customer_name, ...rest } = order
  return {
    ...rest,
    customer_name,
    ...otp.publicOtpState(order),
  }
}

/** Load one order the caller is actually assigned to, or null. */
function findMyOrder(qb, { orderId, companyId, userId }) {
  return qb('customer_orders as co')
    .join('parties as p', 'p.id', 'co.party_id')
    .where({
      'co.id': orderId,
      'co.company_id': companyId,
      'co.assigned_delivery_partner_id': userId,
    })
    .select(...RIDER_ORDER_FIELDS, 'p.name as customer_name')
    .first()
}

/** Same ownership filter as findMyOrder, but a locked full-row read on
 *  `customer_orders` only, for the two endpoints that mutate delivery
 *  state. Returns the raw row (OTP columns included) — callers must pass
 *  it through riderView()/publicOtpState() before responding. */
function lockMyOrder(trx, { orderId, companyId, userId }) {
  return trx('customer_orders')
    .where({ id: orderId, company_id: companyId, assigned_delivery_partner_id: userId })
    .forUpdate()
    .first()
}

/* ── GET /delivery/orders ─────────────────────────────────────────────────
 * The rider's job list. Defaults to work in progress; ?history=true for
 * what they have already completed. */
router.get('/orders', async (req, res, next) => {
  try {
    const history = req.query.history === 'true'
    const statuses = history ? ['delivered'] : ['ready', 'out_for_delivery']

    const rows = await db('customer_orders as co')
      .join('parties as p', 'p.id', 'co.party_id')
      .where('co.company_id', req.companyId)
      .where('co.assigned_delivery_partner_id', req.user.id)
      .whereIn('co.status', statuses)
      .select(...RIDER_ORDER_FIELDS, 'p.name as customer_name')
      .orderBy(history ? 'co.delivered_at' : 'co.delivery_assigned_at', 'desc')
      .limit(history ? 50 : 100)

    res.json({ success: true, data: rows.map(riderView) })
  } catch (err) { next(err) }
})

/* ── GET /delivery/orders/:id ─────────────────────────────────────────── */
router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await findMyOrder(db, { orderId: req.params.id, companyId: req.companyId, userId: req.user.id })
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })

    const items = await db('customer_order_items')
      .where({ order_id: order.id })
      .select('id', 'product_name_snapshot', 'unit_snapshot', 'quantity')
      .orderBy('created_at')

    res.json({ success: true, data: { ...riderView(order), items } })
  } catch (err) { next(err) }
})

/* ── POST /delivery/orders/:id/arrived ────────────────────────────────────
 * Purely a UI milestone — it reveals the OTP keypad on the rider's phone
 * and timestamps the arrival for the store. It grants nothing: the
 * verify endpoint below does not care whether this was ever called. */
router.post('/orders/:id/arrived', async (req, res, next) => {
  try {
    const order = await findMyOrder(db, { orderId: req.params.id, companyId: req.companyId, userId: req.user.id })
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })
    if (order.status !== 'out_for_delivery') {
      return res.status(409).json({
        success: false,
        code: 'ORDER_NOT_OUT_FOR_DELIVERY',
        message: 'This order is not out for delivery.',
      })
    }

    // Idempotent: arriving twice keeps the first timestamp.
    if (!order.delivery_arrived_at) {
      await db('customer_orders')
        .where({ id: order.id })
        .update({ delivery_arrived_at: new Date(), updated_at: new Date() })
    }

    const fresh = await findMyOrder(db, { orderId: order.id, companyId: req.companyId, userId: req.user.id })
    res.json({ success: true, data: riderView(fresh) })
  } catch (err) { next(err) }
})

/* ── POST /delivery/orders/:id/verify-otp ─────────────────────────────────
 * The only route in the entire application that can move an order to
 * DELIVERED through normal operation (the other is the owner/admin
 * override in adminCustomerOrders.js, which is audited as such).
 *
 * Everything happens inside one transaction that begins by taking a row
 * lock on the order (`forUpdate`). That lock is what makes the double-tap
 * case (spec §27) safe: a second concurrent request blocks until the
 * first commits, then re-reads a row that already says
 * delivery_otp_verified_at, and returns the existing delivered state
 * instead of a second delivery event. Attempt counting is inside the
 * same lock, so two parallel wrong guesses can't both read attempts=4
 * and both write 5.
 */
router.post('/orders/:id/verify-otp', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    // Locked read of customer_orders ALONE — no join. `SELECT ... FOR
    // UPDATE` with a join would also try to lock the joined `parties`
    // row, which this operation has no business locking (and which would
    // needlessly serialize unrelated work on that customer). The party's
    // name isn't needed to decide anything here anyway.
    const order = await lockMyOrder(trx, {
      orderId: req.params.id, companyId: req.companyId, userId: req.user.id,
    })

    if (!order) {
      await trx.rollback()
      return res.status(404).json({ success: false, message: 'Order not found.' })
    }

    if (order.fulfillment_type !== 'delivery') {
      await trx.rollback()
      return res.status(409).json({
        success: false,
        code: 'NOT_A_DELIVERY_ORDER',
        message: 'This is a pickup order and does not need delivery verification.',
      })
    }

    const result = await otp.evaluateVerification(order, req.body?.otp)

    // ── Already delivered — idempotent success (spec §27) ────────────────
    if (result.outcome === 'already_verified') {
      await trx.commit()
      const fresh = await findMyOrder(db, { orderId: order.id, companyId: req.companyId, userId: req.user.id })
      return res.json({
        success: true,
        already_delivered: true,
        message: 'This order has already been delivered.',
        data: riderView(fresh),
      })
    }

    // ── Any failure: persist the attempt/lock patch, then report ─────────
    if (result.outcome !== 'verified') {
      if (result.patch) await trx('customer_orders').where({ id: order.id }).update(result.patch)
      await trx.commit()

      // Audited without the submitted value — logging guesses would put
      // near-miss codes in the audit trail (spec §18).
      if (result.outcome === 'incorrect' || result.outcome === 'locked_now') {
        await auditLog(
          req.companyId, req.user.id,
          result.outcome === 'locked_now' ? 'DELIVERY_OTP_LOCKED' : 'DELIVERY_OTP_FAILED',
          'customer_order', order.id,
          { order_no: order.order_no, attempts: result.patch?.delivery_otp_attempts },
          req.ip,
        )
      } else if (result.outcome === 'expired') {
        await auditLog(req.companyId, req.user.id, 'DELIVERY_OTP_EXPIRED', 'customer_order', order.id, { order_no: order.order_no }, req.ip)
      }

      const fresh = await db('customer_orders').where({ id: order.id }).first()
      return res.status(result.outcome === 'invalid_format' ? 400 : 422).json({
        success: false,
        code: result.code,
        message: result.message,
        data: otp.publicOtpState(fresh),
      })
    }

    // ── Verified. Mark delivered in the same transaction ─────────────────
    // "OTP verified" and "order delivered" are one write. There is no
    // window in which the code is spent but the order is not delivered,
    // and no separate "mark delivered" endpoint that could be called
    // without passing through here (spec §16).
    const now = new Date()
    await trx('customer_orders').where({ id: order.id }).update({
      ...result.patch,
      status: 'delivered',
      delivered_at: now,
      delivered_by: req.user.id,
      delivery_verification_method: 'otp',
    })
    await trx.commit()

    await auditLog(
      req.companyId, req.user.id, 'DELIVERY_OTP_VERIFIED', 'customer_order', order.id,
      { order_no: order.order_no, verified_by_delivery_partner_id: req.user.id, delivered_at: now },
      req.ip,
    )

    const fresh = await findMyOrder(db, { orderId: order.id, companyId: req.companyId, userId: req.user.id })
    res.json({
      success: true,
      message: 'Delivery verified.',
      data: riderView(fresh),
    })
  } catch (err) {
    await trx.rollback().catch(() => {})
    next(err)
  }
})

/* ── POST /delivery/orders/:id/resend-otp ─────────────────────────────────
 * Issues a NEW code and invalidates the old one in the same write — the
 * order row holds exactly one code, so there is no state in which both
 * are live (spec §13). Attempts and any lock reset with it, which is the
 * intended escape hatch from a five-failed-attempts lockout.
 *
 * The rider triggers this but still never sees the result: the new code
 * goes to the customer's phone and tracking page, same as the first one. */
router.post('/orders/:id/resend-otp', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const order = await lockMyOrder(trx, {
      orderId: req.params.id, companyId: req.companyId, userId: req.user.id,
    })

    if (!order) {
      await trx.rollback()
      return res.status(404).json({ success: false, message: 'Order not found.' })
    }
    if (order.status !== 'out_for_delivery') {
      await trx.rollback()
      return res.status(409).json({
        success: false,
        code: 'ORDER_NOT_OUT_FOR_DELIVERY',
        message: 'This order is not out for delivery.',
      })
    }
    if (order.delivery_otp_verified_at) {
      await trx.rollback()
      return res.status(409).json({ success: false, code: 'ALREADY_DELIVERED', message: 'This order has already been delivered.' })
    }

    const wait = otp.secondsUntilResendAllowed(order)
    if (wait > 0) {
      await trx.rollback()
      return res.status(429).json({
        success: false,
        code: 'OTP_RESEND_COOLDOWN',
        message: `Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting a new code.`,
        retry_after_seconds: wait,
      })
    }

    const { code, patch } = await otp.buildIssuePatch()
    await trx('customer_orders').where({ id: order.id }).update({
      ...patch,
      delivery_otp_resend_count: Number(order.delivery_otp_resend_count || 0) + 1,
    })
    await trx.commit()

    // Sent after commit: a gateway timeout must not roll back a code the
    // customer can already read on their tracking page.
    await notifier.sendDeliveryOtp({
      phone: await notifier.resolveCustomerPhone(db, order),
      orderNo: order.order_no,
      code,
    })

    await auditLog(req.companyId, req.user.id, 'DELIVERY_OTP_RESENT', 'customer_order', order.id, { order_no: order.order_no }, req.ip)

    const fresh = await db('customer_orders').where({ id: order.id }).first()
    res.json({
      success: true,
      message: 'A new code has been sent to the customer.',
      data: otp.publicOtpState(fresh),
    })
  } catch (err) {
    await trx.rollback().catch(() => {})
    next(err)
  }
})

module.exports = router
