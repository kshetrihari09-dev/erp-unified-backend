/**
 * routes/adminCustomerRegistrations.js — Customer Product Ordering module
 * (staff side): the approval workflow migration 037 exists for.
 *
 * Mirrors routes/adminCustomerOrders.js's shape deliberately (list +
 * detail + a PATCH action, `authenticate` + req.companyId scoping) — same
 * "staff reviews something a customer submitted" pattern, not a new one.
 *
 * requireRole('admin') on every route below (owner always passes
 * requireRole — see middleware/index.js) is the one addition beyond that
 * pattern: customer ORDER confirmation is open to any staff role today,
 * but the spec for THIS feature is explicit — "Only authorized OWNER/ADMIN
 * users can view/approve/reject registrations" — so this file is
 * deliberately more restrictive than its sibling, not copy-pasted loose.
 *
 * Every query below is scoped to `req.companyId` (from the requesting
 * admin's own authenticated session — never from anything the client
 * sends), so a Store B admin's token simply cannot select a Store A
 * registration: the WHERE clause excludes it before an authorization
 * *decision* would even be needed. That's the "never trust a company/
 * store ID supplied by the frontend" requirement — there is no
 * frontend-supplied company/store id anywhere in this file to trust.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { authenticate, requireRole } = require('../middleware/index')
const { auditLog } = require('../utils/helpers')

router.use(authenticate)
router.use(requireRole('admin'))

const SELECT_LIST = [
  'ca.id', 'ca.status', 'ca.created_at', 'ca.reviewed_at',
  'p.name as customer_name', 'p.phone as customer_phone', 'p.email as customer_email',
]
const SELECT_DETAIL = [
  ...SELECT_LIST, 'ca.rejection_reason', 'ca.reviewed_by',
  'p.address as customer_address', 'u.name as reviewed_by_name',
]

/* ── GET /admin/customer-registrations ────────────────────────────────────
 * ?status=&search=&page=&limit= — status omitted = all. The sidebar badge
 * (AppLayout.tsx) calls this with status=pending&limit=1 and reads
 * pagination.total, the exact same mechanic pendingCustomerOrders already
 * uses — no separate "count" endpoint needed. */
router.get('/', async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query
    const lim = Math.min(100, Number(limit) || 20)
    const offset = (Math.max(1, Number(page)) - 1) * lim

    let q = db('customer_accounts as ca')
      .join('parties as p', 'p.id', 'ca.party_id')
      .where('ca.company_id', req.companyId)

    if (status) q = q.where('ca.status', status)
    if (search) {
      q = q.where(b => b.whereILike('p.name', `%${search}%`).orWhereILike('p.phone', `%${search}%`).orWhereILike('p.email', `%${search}%`))
    }

    const total = Number((await q.clone().count('ca.id as c').first())?.c || 0)
    const registrations = await q.clone()
      .orderBy('ca.created_at', 'desc').limit(lim).offset(offset)
      .select(SELECT_LIST)

    res.json({ success: true, data: registrations, pagination: { total, page: Number(page), limit: lim, totalPages: Math.ceil(total / lim) } })
  } catch (err) { next(err) }
})

/* ── GET /admin/customer-registrations/:id ────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const reg = await db('customer_accounts as ca')
      .join('parties as p', 'p.id', 'ca.party_id')
      .leftJoin('users as u', 'u.id', 'ca.reviewed_by')
      .where({ 'ca.id': req.params.id, 'ca.company_id': req.companyId })
      .select(SELECT_DETAIL)
      .first()
    if (!reg) return res.status(404).json({ success: false, message: 'Registration not found.' })
    res.json({ success: true, data: reg })
  } catch (err) { next(err) }
})

/* ── PATCH /admin/customer-registrations/:id/approve ──────────────────── */
router.patch('/:id/approve', async (req, res, next) => {
  try {
    const reg = await db('customer_accounts').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!reg) return res.status(404).json({ success: false, message: 'Registration not found.' })
    // Idempotency (spec: "prevent accidental double approval") — approving
    // an already-approved registration is a no-op success, not an error;
    // approving a REJECTED one is refused outright, since un-rejecting is
    // a deliberate reconsideration this endpoint doesn't model — reject the
    // and have the customer submit a fresh registration instead.
    if (reg.status === 'rejected') {
      return res.status(400).json({ success: false, message: 'This registration was already rejected and cannot be approved directly.' })
    }
    if (reg.status !== 'approved') {
      await db('customer_accounts').where({ id: reg.id }).update({
        status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date(), rejection_reason: null, updated_at: new Date(),
      })
      await auditLog(req.companyId, req.user.id, 'APPROVE', 'customer_account', reg.id, {}, req.ip)
    }
    const updated = await db('customer_accounts as ca')
      .join('parties as p', 'p.id', 'ca.party_id')
      .where('ca.id', reg.id).select(SELECT_LIST).first()
    res.json({ success: true, message: 'Customer approved successfully.', data: updated })
  } catch (err) { next(err) }
})

/* ── PATCH /admin/customer-registrations/:id/reject ───────────────────── */
router.patch('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body || {}
    const reg = await db('customer_accounts').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!reg) return res.status(404).json({ success: false, message: 'Registration not found.' })
    if (reg.status === 'approved') {
      return res.status(400).json({ success: false, message: 'This registration was already approved and cannot be rejected directly.' })
    }
    if (reg.status !== 'rejected') {
      await db('customer_accounts').where({ id: reg.id }).update({
        status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date(),
        rejection_reason: reason?.trim() || null, updated_at: new Date(),
      })
      await auditLog(req.companyId, req.user.id, 'REJECT', 'customer_account', reg.id, { reason: reason?.trim() || null }, req.ip)
    }
    const updated = await db('customer_accounts as ca')
      .join('parties as p', 'p.id', 'ca.party_id')
      .where('ca.id', reg.id).select(SELECT_LIST).first()
    res.json({ success: true, message: 'Registration rejected.', data: updated })
  } catch (err) { next(err) }
})

module.exports = router
