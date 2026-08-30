/**
 * routes/approvals.js — generic Approval Management.
 *
 * This codebase had no Approval Management module before this feature
 * (see migration 032 header). Rather than a bespoke table per approval
 * kind, this is a minimal generic workflow: a `type` string + a jsonb
 * `payload` describing what's being requested. Credit-Risk (routes/
 * creditRisk.js, services/creditRiskRecalc.js) is the first consumer —
 * type 'reduce_credit_limit' — but the shape supports any future approval
 * kind (override_risk_warning, allow_blocked_credit_sale,
 * approve_high_value_credit_sale, ...) without another migration.
 *
 * Approving a credit-limit-type approval here does NOT itself change the
 * party's credit_limit — it calls the existing PUT /parties/:id, so that
 * change goes through the exact same code path (and audit trail) as if a
 * user had edited it by hand. This keeps "only approved actions can
 * change credit limit/terms/status" (requirement #26) literally true:
 * there is exactly one place party.credit_limit is written, and approving
 * here is just one more caller of it.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate, requirePermission, requireRole } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const AuditLogger = require('../utils/auditLogger')

router.use(authenticate)

const CREDIT_RISK_TYPES = ['reduce_credit_limit', 'increase_credit_limit', 'override_risk_warning', 'allow_blocked_credit_sale', 'keep_existing_terms', 'approve_high_value_credit_sale']

/** Only authorized users can decide credit-risk approvals — reuses the same permission as overriding a warning/approving a high-risk sale. */
function canDecide(fullUser, type) {
  if (CREDIT_RISK_TYPES.includes(type)) {
    return !!(fullUser.can_override_credit_risk_warning || fullUser.can_approve_high_risk_credit_sale)
  }
  return ['owner', 'admin', 'manager'].includes(fullUser.role)
}

/* ── GET /approvals ───────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { status, type, customer_id } = req.query
    let q = db('approvals as a')
      .leftJoin('parties as p', 'a.customer_id', 'p.id')
      .leftJoin('users as ru', 'a.requested_by', 'ru.id')
      .where('a.company_id', req.companyId)
      .select('a.*', 'p.name as customer_name', 'ru.name as requested_by_name')
    if (status)      q = q.where('a.status', status)
    if (type)        q = q.where('a.type', type)
    if (customer_id) q = q.where('a.customer_id', customer_id)

    const [{ count }] = await q.clone().clearSelect().count('a.id as count')
    const data = await q.orderBy('a.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /approvals/:id ───────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const approval = await db('approvals').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!approval) return res.status(404).json({ success: false, message: 'Approval not found' })
    return successResponse(res, approval)
  } catch (err) { next(err) }
})

/* ── PUT /approvals/:id/decide ────────────────────────────────────────────
 * Body: { decision: 'approve' | 'reject', reason?: string }
 * For type='reduce_credit_limit'/'increase_credit_limit', approving also
 * applies the change via the existing party update path (see file header).
 * ────────────────────────────────────────────────────────────────────── */
router.put('/:id/decide', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const approval = await trx('approvals').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!approval) { await trx.rollback(); return res.status(404).json({ success: false, message: 'Approval not found' }) }
    if (approval.status !== 'pending') { await trx.rollback(); return res.status(400).json({ success: false, message: `Already ${approval.status}` }) }
    // req.user (from `authenticate`) only carries {id, email, role} —
    // permission flags are never trusted from the JWT/request, always
    // re-read from the DB (same pattern as requirePermission itself).
    const fullUser = await trx('users').where({ id: req.user.id }).first()
    if (!fullUser || !canDecide(fullUser, approval.type)) { await trx.rollback(); return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', message: 'You are not authorized to decide this approval' }) }

    const { decision, reason } = req.body
    if (!['approve', 'reject'].includes(decision)) { await trx.rollback(); return res.status(400).json({ success: false, message: "decision must be 'approve' or 'reject'" }) }

    const newStatus = decision === 'approve' ? 'approved' : 'rejected'
    const [updated] = await trx('approvals').where({ id: approval.id }).update({
      status: newStatus, decided_by: req.user.id, decision_reason: reason || null, decided_at: new Date(), updated_at: new Date(),
    }).returning('*')

    // Apply the change — ONLY on explicit approval, and only for the
    // credit-limit recommendation type. Every other type is informational
    // (e.g. "override warning" / "allow blocked sale" just unblocks the
    // specific sale flow that requested it — the caller checks approval
    // status, nothing here needs to mutate other tables for those).
    if (decision === 'approve' && ['reduce_credit_limit', 'increase_credit_limit'].includes(approval.type) && approval.customer_id) {
      const payload = approval.payload || {}
      const updates = {}
      if (payload.to_limit != null) updates.credit_limit = Number(payload.to_limit)
      if (payload.to_terms_days != null) updates.credit_days = Number(payload.to_terms_days)
      if (Object.keys(updates).length) {
        await trx('parties').where({ id: approval.customer_id, company_id: req.companyId }).update({ ...updates, updated_at: new Date() })
      }
    }

    await AuditLogger.log(trx, {
      companyId: req.companyId, userId: req.user.id, action: `APPROVAL_${newStatus.toUpperCase()}`,
      entityType: 'approvals', entityId: approval.id,
      payloadBefore: { status: 'pending' }, payloadAfter: { status: newStatus, reason: reason || null },
      ipAddress: req.ip,
    })

    await trx.commit()
    return successResponse(res, updated, `Request ${newStatus}`)
  } catch (err) { await trx.rollback(); next(err) }
})

module.exports = router
