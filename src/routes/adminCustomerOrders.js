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
const { authenticate, requireRole } = require('../middleware/index')
const { createSaleHandler } = require('./sales')
const { auditLog } = require('../utils/helpers')
const otp = require('../services/deliveryOtpService')
const notifier = require('../services/deliveryOtpNotifier')

router.use(authenticate)

/* ── Status flow (migration 038) ──────────────────────────────────────────
 * Two branches that share a common trunk, chosen by fulfillment_type:
 *
 *   pending → confirmed → processing → ready → completed          (pickup)
 *   pending → confirmed → processing → ready → out_for_delivery
 *                                            → delivered          (delivery)
 *
 * `delivered` is the delivery branch's terminal state — the peer of
 * `completed`, not a step before it. Pickup orders are completely
 * unaffected by this feature: PICKUP_FLOW below is byte-for-byte the
 * STATUS_FLOW this file had before.
 *
 * STATUS_FLOW is retained under its old name and value so that any other
 * caller or test importing it keeps working.
 */
const STATUS_FLOW   = ['pending', 'confirmed', 'processing', 'ready', 'completed']
const PICKUP_FLOW   = STATUS_FLOW
const DELIVERY_FLOW = ['pending', 'confirmed', 'processing', 'ready', 'out_for_delivery', 'delivered']

const flowFor = (order) => (order.fulfillment_type === 'delivery' ? DELIVERY_FLOW : PICKUP_FLOW)
const TERMINAL_STATUSES = ['completed', 'delivered', 'cancelled']

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

/* ── What staff see of the OTP ────────────────────────────────────────────
 * Status only — issued / pending verification / verified / locked, plus
 * timestamps and who verified it. Never the code (spec §19): store staff
 * have no operational need for it, and a code readable from the back
 * office is a code that can be phoned to a rider who never reached the
 * customer, which defeats the whole mechanism.
 *
 * The two raw columns are stripped explicitly here rather than relying on
 * the select list, because GET /:id above selects `co.*` — so a new
 * column added to the table later cannot leak through this endpoint.
 */
function staffView(order) {
  const { delivery_otp_hash, delivery_otp_secret, ...safe } = order
  return { ...safe, ...otp.publicOtpState(order) }
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
      .leftJoin('users as dp', 'dp.id', 'co.assigned_delivery_partner_id')
      .where('co.company_id', req.companyId)

    if (status) q = q.where('co.status', status)
    if (search) {
      q = q.where(b => b.whereILike('co.order_no', `%${search}%`).orWhereILike('p.name', `%${search}%`).orWhereILike('p.phone', `%${search}%`))
    }

    const total = Number((await q.clone().count('co.id as c').first())?.c || 0)
    const orders = await q.clone()
      .orderBy('co.created_at', 'desc').limit(lim).offset(offset)
      .select('co.*', 'p.name as customer_name', 'p.phone as customer_phone', 'dp.name as delivery_partner_name')

    res.json({
      success: true,
      data: orders.map(staffView),
      pagination: { total, page: Number(page), limit: lim, totalPages: Math.ceil(total / lim) },
    })
  } catch (err) { next(err) }
})

/* ── GET /admin/customer-orders/:id ───────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const order = await db('customer_orders as co')
      .join('parties as p', 'p.id', 'co.party_id')
      .leftJoin('users as dp', 'dp.id', 'co.assigned_delivery_partner_id')
      .where({ 'co.id': req.params.id, 'co.company_id': req.companyId })
      .select(
        'co.*',
        'p.name as customer_name', 'p.phone as customer_phone', 'p.email as customer_email',
        'dp.name as delivery_partner_name', 'dp.phone as delivery_partner_phone',
      )
      .first()
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })

    const items = await db('customer_order_items').where({ order_id: order.id }).orderBy('created_at')
    res.json({ success: true, data: { ...staffView(order), items } })
  } catch (err) { next(err) }
})

/* ── PATCH /admin/customer-orders/:id/status ──────────────────────────── */
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, cancel_reason } = req.body || {}
    const validStatuses = [...new Set([...PICKUP_FLOW, ...DELIVERY_FLOW, 'cancelled'])]
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${validStatuses.join(', ')}` })
    }

    const order = await db('customer_orders').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })
    if (TERMINAL_STATUSES.includes(order.status)) {
      return res.status(400).json({ success: false, message: `This order is already ${order.status} and cannot be changed.` })
    }

    // ── DELIVERED is not reachable from here, ever ───────────────────────
    // Only two things may mark an order delivered: a rider passing OTP
    // verification (routes/deliveryPartner.js) or the explicitly audited
    // owner/admin override below. Leaving `delivered` as an ordinary
    // status move would hand every staff account a silent one-click
    // bypass of the entire feature (spec §16/§20/§23).
    if (status === 'delivered') {
      return res.status(403).json({
        success: false,
        code: 'OTP_VERIFICATION_REQUIRED',
        message: 'An order can only be marked delivered by OTP verification, or through an authorized delivery override.',
      })
    }

    // A pickup order has no delivery stage to enter.
    if (status === 'out_for_delivery' && order.fulfillment_type !== 'delivery') {
      return res.status(400).json({
        success: false,
        code: 'NOT_A_DELIVERY_ORDER',
        message: 'This is a pickup order. Mark it Ready for the customer to collect.',
      })
    }

    // Symmetrically, a delivery order must not shortcut to `completed`:
    // `completed` is the pickup branch's terminal state, so allowing it
    // here would be the same bypass as `delivered` under another name.
    if (status === 'completed' && order.fulfillment_type === 'delivery') {
      return res.status(400).json({
        success: false,
        code: 'DELIVERY_REQUIRES_VERIFICATION',
        message: 'Delivery orders are completed by verifying the customer\'s delivery code, not by marking them completed.',
      })
    }

    // ── Cancel ──────────────────────────────────────────────────────────
    if (status === 'cancelled') {
      await db('customer_orders').where({ id: order.id }).update({
        status: 'cancelled', cancelled_at: new Date(), cancel_reason: cancel_reason || null, updated_at: new Date(),
      })
      await auditLog(req.companyId, req.user.id, 'CANCEL', 'customer_order', order.id, { cancel_reason }, req.ip)
      return res.json({ success: true, data: staffView(await db('customer_orders').where({ id: order.id }).first()) })
    }

    // ── Forward progression only (no skipping backward, no skipping steps
    //    except the confirm step itself which does real work below) ──────
    const flow = flowFor(order)
    const currentIdx = flow.indexOf(order.status)
    const targetIdx  = flow.indexOf(status)
    if (targetIdx === -1) {
      return res.status(400).json({
        success: false,
        message: `${status} is not a valid status for a ${order.fulfillment_type} order.`,
      })
    }
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
      return res.json({ success: true, data: staffView(await db('customer_orders').where({ id: order.id }).first()) })
    }

    // ── Out for delivery: the moment the delivery OTP comes into being ──
    if (status === 'out_for_delivery') {
      if (!order.assigned_delivery_partner_id) {
        return res.status(400).json({
          success: false,
          code: 'NO_DELIVERY_PARTNER',
          message: 'Assign a delivery partner before marking this order out for delivery.',
        })
      }

      // Generated here and only here — not when the order page is opened,
      // not on every read (spec §3). An order that is already out for
      // delivery cannot re-enter this branch at all, because the
      // forward-progression check above rejects out_for_delivery →
      // out_for_delivery, so there is no path that silently replaces a
      // live code. Replacing one is always an explicit resend.
      const { code, patch } = await otp.buildIssuePatch()

      const updated = await db.transaction(async (trx) => {
        // Re-assert the starting status inside the transaction. If two
        // staff dispatch the same order simultaneously, exactly one
        // UPDATE matches and issues a code; the other affects zero rows
        // and is told to refresh, rather than overwriting a code the
        // customer may already have been sent.
        const affected = await trx('customer_orders')
          .where({ id: order.id, company_id: req.companyId, status: order.status })
          .update({ ...patch, status: 'out_for_delivery' })
        if (!affected) return null
        return trx('customer_orders').where({ id: order.id }).first()
      })

      if (!updated) {
        return res.status(409).json({
          success: false,
          code: 'ORDER_CHANGED',
          message: 'This order was updated by someone else. Please refresh and try again.',
        })
      }

      // Sent after the transaction commits. If the gateway is down the
      // order is still correctly out for delivery and the customer can
      // still read the code on their tracking page — the opposite
      // ordering would let an SMS failure roll back a dispatch.
      const notified = await notifier.sendDeliveryOtp({
        phone: await notifier.resolveCustomerPhone(db, updated),
        orderNo: updated.order_no,
        code,
      })

      // Audited by event, never by value (spec §18): which channel it
      // went out on is useful for support; the code itself is not, and
      // audit_log is queryable by staff.
      await auditLog(
        req.companyId, req.user.id, 'DELIVERY_OTP_GENERATED', 'customer_order', order.id,
        { order_no: updated.order_no, channel: notified.channel, notified: notified.sent },
        req.ip,
      )

      return res.json({
        success: true,
        data: staffView(updated),
        notification: { sent: notified.sent, channel: notified.channel },
      })
    }

    // ── Everything else (processing/ready/completed) is a plain status move —
    //    stock was already deducted at confirmation; nothing further to do. ──
    await db('customer_orders').where({ id: order.id }).update({ status, updated_at: new Date() })
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'customer_order', order.id, { status }, req.ip)
    res.json({ success: true, data: staffView(await db('customer_orders').where({ id: order.id }).first()) })
  } catch (err) { next(err) }
})

/* ── GET /admin/customer-orders/meta/delivery-partners ────────────────────
 * Riders available to assign. Ordinary `users` rows with the new role,
 * scoped to this company exactly like GET /settings/users — there is no
 * separate partner directory to keep in sync, and deactivating a rider
 * in Settings removes them from here automatically.
 *
 * Path is under /meta/ so it can never be mistaken for an order id by
 * the GET /:id route above.
 *
 * Only the fields the assigner needs. Nothing a rider would consider
 * private (earnings, internal flags) exists on this select list. */
router.get('/meta/delivery-partners', async (req, res, next) => {
  try {
    const partners = await db('users')
      .where({ company_id: req.companyId, role: 'delivery_partner', is_active: true })
      .select('id', 'name', 'phone')
      .orderBy('name')
    res.json({ success: true, data: partners })
  } catch (err) { next(err) }
})

/* ── PATCH /admin/customer-orders/:id/delivery-partner ────────────────────
 * Assign (or reassign) the rider. Separate from the status endpoint on
 * purpose: assignment is reversible bookkeeping, while dispatching is
 * the irreversible act that issues a code.
 *
 * Reassignment is allowed right up until the order is delivered, and
 * deliberately does NOT reissue the OTP. The code belongs to the
 * customer, not the rider; whoever turns up gets told the same code.
 * Reissuing on reassignment would invalidate a code the customer is
 * already holding, for no security gain. */
router.patch('/:id/delivery-partner', async (req, res, next) => {
  try {
    const { delivery_partner_id } = req.body || {}

    const order = await db('customer_orders').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' })
    if (order.fulfillment_type !== 'delivery') {
      return res.status(400).json({ success: false, code: 'NOT_A_DELIVERY_ORDER', message: 'This is a pickup order.' })
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      return res.status(400).json({ success: false, message: `This order is already ${order.status}.` })
    }

    // Unassign
    if (delivery_partner_id === null || delivery_partner_id === '') {
      if (order.status === 'out_for_delivery') {
        return res.status(400).json({
          success: false,
          code: 'ALREADY_DISPATCHED',
          message: 'This order is already out for delivery. Assign a different partner instead of removing them.',
        })
      }
      await db('customer_orders').where({ id: order.id }).update({
        assigned_delivery_partner_id: null, delivery_assigned_by: null, delivery_assigned_at: null, updated_at: new Date(),
      })
      await auditLog(req.companyId, req.user.id, 'DELIVERY_PARTNER_UNASSIGNED', 'customer_order', order.id, { order_no: order.order_no }, req.ip)
      return res.json({ success: true, data: staffView(await db('customer_orders').where({ id: order.id }).first()) })
    }

    // The role+company check is the authorization boundary for the rider
    // endpoints: routes/deliveryPartner.js trusts that anything sitting
    // in assigned_delivery_partner_id is a real rider in this company,
    // so an arbitrary user id must never be writable into that column.
    const partner = await db('users')
      .where({ id: delivery_partner_id, company_id: req.companyId, role: 'delivery_partner', is_active: true })
      .first()
    if (!partner) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_DELIVERY_PARTNER',
        message: 'That delivery partner was not found in this store.',
      })
    }

    await db('customer_orders').where({ id: order.id }).update({
      assigned_delivery_partner_id: partner.id,
      delivery_assigned_by: req.user.id,
      delivery_assigned_at: new Date(),
      updated_at: new Date(),
    })
    await auditLog(
      req.companyId, req.user.id, 'DELIVERY_PARTNER_ASSIGNED', 'customer_order', order.id,
      { order_no: order.order_no, delivery_partner_id: partner.id, delivery_partner_name: partner.name },
      req.ip,
    )

    res.json({ success: true, data: staffView(await db('customer_orders').where({ id: order.id }).first()) })
  } catch (err) { next(err) }
})

/* ── POST /admin/customer-orders/:id/delivery-override ────────────────────
 * The emergency exit (spec §20): customer cannot produce the code, phone
 * is dead, rider's app is broken. Completes the delivery WITHOUT OTP
 * verification.
 *
 * Three things make this safe to have at all, and all three are enforced
 * here rather than in the UI:
 *   - requireRole('admin') — owner passes too (middleware/index.js), but
 *     a cashier, an auditor, and every delivery partner do not. A rider
 *     can never override their own delivery, which is the abuse case
 *     this whole feature exists to prevent.
 *   - a reason is mandatory and stored on the order.
 *   - an audit row is written marked is_suspicious, so overrides surface
 *     on their own rather than having to be hunted for.
 *
 * The order is recorded as delivery_verification_method='override', so
 * "delivered" and "verified" never become indistinguishable after the
 * fact — an overridden order is permanently legible as one.
 */
router.post('/:id/delivery-override', requireRole('admin'), async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const reason = String(req.body?.reason || '').trim()
    if (reason.length < 5) {
      await trx.rollback()
      return res.status(400).json({
        success: false,
        code: 'REASON_REQUIRED',
        message: 'Please give a reason for overriding delivery verification.',
      })
    }

    const order = await trx('customer_orders')
      .where({ id: req.params.id, company_id: req.companyId })
      .forUpdate()
      .first()

    if (!order) {
      await trx.rollback()
      return res.status(404).json({ success: false, message: 'Order not found.' })
    }
    if (order.status === 'delivered') {
      // Idempotent, same as the rider's verify endpoint.
      await trx.rollback()
      return res.json({
        success: true,
        already_delivered: true,
        message: 'This order has already been delivered.',
        data: staffView(await db('customer_orders').where({ id: order.id }).first()),
      })
    }
    if (order.fulfillment_type !== 'delivery') {
      await trx.rollback()
      return res.status(400).json({ success: false, code: 'NOT_A_DELIVERY_ORDER', message: 'This is a pickup order.' })
    }
    if (order.status !== 'out_for_delivery') {
      await trx.rollback()
      return res.status(400).json({
        success: false,
        code: 'ORDER_NOT_OUT_FOR_DELIVERY',
        message: 'Only an order that is out for delivery can be completed by override.',
      })
    }

    const now = new Date()
    await trx('customer_orders').where({ id: order.id }).update({
      status: 'delivered',
      delivered_at: now,
      delivered_by: req.user.id,
      delivery_verification_method: 'override',
      delivery_override_reason: reason.slice(0, 500),
      // The code is retired along with the order — it must not remain
      // usable, or readable, once delivery is closed out by other means.
      delivery_otp_secret: null,
      delivery_otp_locked_until: null,
      updated_at: now,
    })
    await trx.commit()

    const AuditLogger = require('../utils/auditLogger')
    await AuditLogger.log(db, {
      companyId: req.companyId,
      userId: req.user.id,
      action: 'DELIVERY_OTP_OVERRIDDEN',
      entityType: 'customer_order',
      entityId: order.id,
      payloadAfter: {
        order_no: order.order_no,
        reason: reason.slice(0, 500),
        assigned_delivery_partner_id: order.assigned_delivery_partner_id,
      },
      ipAddress: req.ip,
      // Not an accusation — a flag so overrides are trivially findable
      // when someone asks "which deliveries skipped verification?"
      isSuspicious: true,
    })

    res.json({
      success: true,
      message: 'Delivery completed by override.',
      data: staffView(await db('customer_orders').where({ id: order.id }).first()),
    })
  } catch (err) {
    await trx.rollback().catch(() => {})
    next(err)
  }
})

module.exports = router
