/**
 * companies.js — single-company profile management
 *
 * One user belongs to exactly one company (users.company_id, resolved
 * server-side by authenticate — see middleware/index.js). There is no
 * multi-company membership and no company switching: every route below
 * only ever operates on req.companyId, the caller's own company.
 *
 * Routes:
 *   GET    /companies/current            the caller's own company
 *   PUT    /companies/:id                edit the caller's own company (member-only, admin/manager)
 *   DELETE /companies/:id                deactivate ("delete") the caller's own company (owner-only, password-confirmed)
 *   POST   /companies/:id/restore        reactivate a previously deleted company (owner-only)
 */
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const db = require('../db/knex')
const { authenticate, requireRole } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { auditLog } = require('../utils/helpers')

class AppError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status }
}

router.use(authenticate)

/* ── GET /companies/current — the caller's own company ────────────────────
 * There is exactly one: the company req.companyId (itself resolved
 * server-side, from the authenticated user's own users.company_id) points
 * to. No list, no switching — nothing else to return. */
router.get('/current', async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first()
    if (!company) throw new AppError('Company not found', 404)
    return successResponse(res, company)
  } catch (err) { next(err) }
})

/* ── PUT /companies/:id — edit the caller's own company ────────────────────
 * :id must be the caller's own company — req.companyId is the only source
 * of truth for which company that is, never req.params.id itself. */
router.put('/:id', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    if (req.params.id !== req.companyId) throw new AppError('Company not found', 404)

    const allowed = [
      'name', 'address', 'phone', 'email', 'website', 'pan_no',
      'registration_no', 'logo_url', 'date_system', 'invoice_prefix',
      'currency', 'vat_percent',
    ]
    const updates = {}
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k] }

    const [updated] = await db('companies')
      .where({ id: req.companyId })
      .update({ ...updates, updated_at: new Date() })
      .returning('*')
    if (!updated) throw new AppError('Company not found', 404)

    await auditLog(req.companyId, req.user.id, 'UPDATE', 'company', req.companyId, updates, req.ip)
    return successResponse(res, updated, 'Company updated')
  } catch (err) { next(err) }
})

/* ── DELETE /companies/:id — "delete" (deactivate) the caller's own company
 * Companies are never hard-deleted. Dozens of tables (vouchers, journal
 * entries, ledger accounts, the users themselves) reference company_id,
 * and for an accounting system historical records must be retained
 * regardless of whether a company is still "open" — this mirrors standard
 * accounting-software practice (e.g. Tally/QuickBooks "delete company" is
 * really an archive). "Delete" here means: is_active = false. The company
 * and every record scoped to it are completely untouched.
 *
 * Guards, in order:
 *   - requester must be owner (requireRole('owner'))
 *   - :id must be the requester's own company
 *   - always requires password confirmation, regardless of the
 *     sensitiveActions settings toggle — deletion is destructive enough
 *     from the user's point of view to always ask, even though it's
 *     reversible. Uses the same `requiresPasswordConfirm` response shape
 *     as requireSensitiveConfirm() so the existing useSensitiveConfirm()
 *     frontend hook works here without any special-casing. */
router.delete('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    if (req.params.id !== req.companyId) throw new AppError('Company not found', 404)

    const company = await db('companies').where({ id: req.companyId }).first()
    if (!company) throw new AppError('Company not found', 404)
    if (company.is_active === false) throw new AppError('This company is already deleted', 400)

    const { confirmPassword } = req.body || {}
    if (!confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Password confirmation is required to delete a company',
        requiresPasswordConfirm: true,
      })
    }
    const user = await db('users').where({ id: req.user.id }).first()
    const passwordOk = user?.password_hash && await bcrypt.compare(confirmPassword, user.password_hash)
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Incorrect password', requiresPasswordConfirm: true })
    }

    await db('companies').where({ id: req.companyId }).update({ is_active: false, updated_at: new Date() })
    await auditLog(req.companyId, req.user.id, 'DELETE', 'company', req.companyId, { name: company.name }, req.ip)

    return successResponse(res, { id: req.companyId }, 'Company deleted')
  } catch (err) { next(err) }
})

/* ── POST /companies/:id/restore — undo a delete ───────────────────────────
 * Reactivates the caller's own company after the soft-delete above. Since
 * nothing was ever destroyed, this simply flips is_active back on. Not
 * password-confirmed since it's non-destructive. */
router.post('/:id/restore', requireRole('owner'), async (req, res, next) => {
  try {
    if (req.params.id !== req.companyId) throw new AppError('Company not found', 404)

    const existing = await db('companies').where({ id: req.companyId }).first()
    if (!existing) throw new AppError('Company not found', 404)
    if (existing.is_active !== false) throw new AppError('This company is not deleted', 400)

    const [company] = await db('companies')
      .where({ id: req.companyId })
      .update({ is_active: true, updated_at: new Date() })
      .returning('*')

    await auditLog(req.companyId, req.user.id, 'RESTORE', 'company', req.companyId, { name: company.name }, req.ip)

    return successResponse(res, company, 'Company restored')
  } catch (err) { next(err) }
})

module.exports = router
