/**
 * Unified middleware — combines pharma ERP auth + accounting engine auth
 */
const jwt    = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const db     = require('../db/knex')
const { withDefaults } = require('../utils/settingsDefaults')
const { verifyStepUpToken } = require('../utils/stepUp')

/* ── JWT Authentication ─────────────────────────────────────────────────── */
async function authenticate(req, res, next) {
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' })
    }
    const token   = auth.slice(7)
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user      = { id: payload.userId, email: payload.email, role: payload.role }
    req.companyId = payload.companyId

    // ── Multi-company membership check ─────────────────────────────────────
    // The JWT already carries the active companyId, but we re-verify on
    // every request (not just at switch time) that this user still has a
    // live membership to that company. This closes the gap where access to
    // a company is revoked mid-session but an existing token would
    // otherwise keep working until it expires — the exact scenario the
    // "company switching must not allow access to another company's data"
    // requirement guards against.
    const membership = await db('user_companies')
      .where({ user_id: req.user.id, company_id: req.companyId })
      .first('id')
    if (!membership) {
      return res.status(403).json({ success: false, message: 'You no longer have access to this company. Please switch companies or log in again.' })
    }

    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired' })
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ success: false, message: 'Invalid token' })
    next(err)
  }
}

/* ── Role Guard ─────────────────────────────────────────────────────────── */
function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role
    // owner and admin always pass — they have full access to everything
    if (userRole === 'owner' || userRole === 'admin') return next()
    if (!roles.includes(userRole)) {
      return res.status(403).json({ success: false, message: `Access denied. Required: ${roles.join(' or ')}` })
    }
    next()
  }
}

/* ── Accounting permission guard ────────────────────────────────────────── */
function requirePermission(permission) {
  const permMap = {
    post_vouchers:    u => u.can_post_vouchers,
    approve_vouchers: u => u.can_approve_vouchers,
    lock_periods:     u => u.can_lock_periods,
    reverse_entries:  u => u.can_reverse_entries,
    // Editing a POSTED voucher requires reversing + recalculating its journal
    // entry under the hood, so it demands the same trust level as reversing
    // one outright — reuse the existing can_reverse_entries flag.
    edit_posted_vouchers: u => u.can_reverse_entries,
  }
  return async (req, res, next) => {
    try {
      const user    = await db('users').where({ id: req.user.id }).first()
      const checker = permMap[permission]
      if (checker && !checker(user)) {
        return res.status(403).json({ success: false, message: `Permission denied: ${permission}` })
      }
      next()
    } catch (err) { next(err) }
  }
}

/* ── Sensitive-action step-up gate ──────────────────────────────────────────
 * Generalizes the "voucher edit password re-check" pattern (see
 * POST /auth/verify-password + VoucherEditPasswordDialog.tsx /
 * useSensitiveConfirm.tsx) to any action.
 *
 * Two exports, sharing one internal check:
 *
 *  - requireSensitiveConfirm(actionKey) — OPT-IN per company via
 *    companies.settings.sensitiveActions[actionKey] (Settings → Users &
 *    Permissions). If the toggle is OFF (default), this is a no-op —
 *    unchanged from before this feature existed.
 *
 *  - requireStepUp(actionKey) — ALWAYS enforced, no company toggle.
 *    For actions that must never be optional (e.g. editing an already-
 *    posted voucher) — closes the gap where a route only relied on the
 *    FRONTEND having called /auth/verify-password first, with nothing
 *    stopping a direct API call from skipping that step entirely.
 *
 * Both accept a request as verified if EITHER:
 *   1. A valid `X-Step-Up-Token` header is present (signed by
 *      POST /auth/verify-password or /auth/security-pin within the last
 *      ~10 minutes, for this exact user+company) — the preferred path,
 *      since it means the person doesn't get re-prompted for a PIN on
 *      every single sensitive click within that window.
 *   2. A legacy inline `confirmPassword` in the request body, checked
 *      against the ACTING user's own password_hash — kept for backward
 *      compatibility with any caller that hasn't adopted the step-up
 *      token flow yet.
 *
 * Neither ever trusts anything else the client sends — the user/company
 * being checked against always comes from `req.user`/`req.companyId`,
 * which `authenticate` already derived from the verified session JWT.
 */
async function stepUpSatisfied(req) {
  const headerToken = req.headers['x-step-up-token']
  if (headerToken && verifyStepUpToken(headerToken, { userId: req.user.id, companyId: req.companyId })) {
    return 'ok'
  }
  const { confirmPassword } = req.body || {}
  if (!confirmPassword) return 'no-credential'

  const user = await db('users').where({ id: req.user.id }).first()
  if (user?.password_hash && await bcrypt.compare(confirmPassword, user.password_hash)) return 'ok'
  return 'wrong-credential'
}

function requireSensitiveConfirm(actionKey) {
  return async (req, res, next) => {
    try {
      const company = await db('companies').where({ id: req.companyId }).first('settings')
      const settings = withDefaults(company?.settings || {})
      const required = !!settings.sensitiveActions?.[actionKey]
      if (!required) return next()

      const result = await stepUpSatisfied(req)
      if (result === 'ok') return next()
      if (result === 'wrong-credential') {
        return res.status(401).json({ success: false, message: 'Incorrect password', requiresPasswordConfirm: true })
      }
      return res.status(400).json({ success: false, message: 'Password confirmation is required for this action', requiresPasswordConfirm: true })
    } catch (err) { next(err) }
  }
}

function requireStepUp(actionKey) {
  return async (req, res, next) => {
    try {
      const result = await stepUpSatisfied(req)
      if (result === 'ok') return next()
      if (result === 'wrong-credential') {
        return res.status(401).json({ success: false, message: 'Incorrect password', requiresPasswordConfirm: true, action: actionKey })
      }
      return res.status(400).json({ success: false, message: 'Verification is required for this action', requiresPasswordConfirm: true, action: actionKey })
    } catch (err) { next(err) }
  }
}

/* ── Standard response helpers ──────────────────────────────────────────── */
function ok(res, data, message = 'Success', status = 200) {
  return res.status(status).json({ success: true, message, data })
}
function paginated(res, { data, total, page, limit }) {
  return res.json({ success: true, data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } })
}

/* ── Global error handler ───────────────────────────────────────────────── */
function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.message, err.status || 500)
  if (err.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate value: ' + (err.detail || '') })
  if (err.code === '23514') return res.status(400).json({ success: false, message: 'Constraint violated: ' + (err.constraint || err.detail || '') })
  if (err.code === '23503') return res.status(400).json({ success: false, message: 'Referenced record does not exist' })
  if (err.code === '23502') return res.status(400).json({ success: false, message: 'Required field missing' })
  if (err.code === 'P0001') return res.status(400).json({ success: false, message: err.message })
  const status  = err.status || err.statusCode || 500
  const message = err.message || 'Internal server error'
  res.status(status).json({ success: false, message })
}

module.exports = { authenticate, requireRole, requirePermission, requireSensitiveConfirm, requireStepUp, errorHandler, ok, paginated }
