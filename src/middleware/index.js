/**
 * Unified middleware — combines pharma ERP auth + accounting engine auth
 */
const jwt    = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/knex')
const { withDefaults } = require('../utils/settingsDefaults')
const { verifyStepUpToken } = require('../utils/stepUp')

/* ── JWT Authentication ─────────────────────────────────────────────────── */
async function authenticate(req, res, next) {
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'No token provided' })
    }
    const token   = auth.slice(7)
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.companyId = payload.companyId

    // ── Current user / role — ALWAYS from the database ─────────────────────
    // The JWT is only used to prove who the caller authenticated as
    // (userId) — never trusted for authorization data. A JWT can be up to
    // JWT_EXPIRES_IN old (default 8h), and in that window an owner/admin
    // could have deactivated the account, demoted the role, or revoked
    // company access. Re-resolving from the DB on every request is what
    // makes that change take effect immediately instead of only at next
    // login/refresh — this is also what makes explicit "session
    // invalidation" after a role change unnecessary: there is no cached
    // privilege left anywhere for a revoked JWT to smuggle in.
    const currentUser = await db('users').where({ id: payload.userId }).first('id', 'email', 'role', 'is_active')
    if (!currentUser) {
      return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: 'Account not found.' })
    }
    if (!currentUser.is_active) {
      return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account has been disabled.' })
    }
    req.user = { id: currentUser.id, email: currentUser.email, role: currentUser.role }

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
      return res.status(403).json({ success: false, code: 'COMPANY_ACCESS_REVOKED', message: 'You no longer have access to this company. Please switch companies or log in again.' })
    }

    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', message: 'Token expired' })
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ success: false, code: 'INVALID_TOKEN', message: 'Invalid token' })
    next(err)
  }
}

/* ── Device identity (LAN/offline sync) ───────────────────────────────────
 * Optional, non-blocking: reads the `X-Device-Id` header the frontend now
 * attaches to every request (see services/http.ts) and, if it matches a
 * still-active device registered to this company, attaches req.deviceId
 * for routes that want to record which device created something (e.g.
 * sales.js/purchases.js stamping the `device_id` column added in
 * migration 025).
 *
 * Deliberately does NOT reject the request when the header is missing,
 * unknown, or revoked — the browser/older-client case (no device
 * registered at all) must keep working exactly as before. Routes that
 * genuinely require an authorized device (the sync endpoints themselves)
 * use requireActiveDevice below instead.
 */
async function identifyDevice(req, res, next) {
  try {
    const deviceId = req.headers['x-device-id']
    if (deviceId && req.companyId) {
      const device = await db('devices')
        .where({ id: deviceId, company_id: req.companyId, status: 'active' })
        .first('id')
      if (device) {
        req.deviceId = deviceId
        // Best-effort — never blocks the request on this write. Also
        // keeps user_id current (see migration 026 — "most recently
        // seen with", not a fixed owner) for a device shared by staff.
        db('devices').where({ id: deviceId }).update({ last_seen_at: new Date(), user_id: req.user?.id }).catch(() => {})
      }
    }
    next()
  } catch (err) { next() } // identity is optional — never fail the request over it
}

/* ── Device identity (required) ───────────────────────────────────────────
 * For routes that must only accept calls from a currently-authorized,
 * non-revoked device — used by the sync/device endpoints themselves
 * (requirement #22: "Never trust ... another device's local database" /
 * revoked devices must be rejected).
 */
async function requireActiveDevice(req, res, next) {
  try {
    const deviceId = req.headers['x-device-id']
    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'X-Device-Id header is required' })
    }
    const device = await db('devices')
      .where({ id: deviceId, company_id: req.companyId })
      .first()
    if (!device) {
      return res.status(403).json({ success: false, message: 'Device is not registered', code: 'DEVICE_NOT_REGISTERED' })
    }
    if (device.status === 'revoked') {
      return res.status(403).json({ success: false, message: 'This device has been revoked. Contact an admin to re-authorize it.', code: 'DEVICE_REVOKED' })
    }
    req.deviceId = deviceId
    req.device   = device
    next()
  } catch (err) { next(err) }
}

/* ── Role Guard ─────────────────────────────────────────────────────────── */
function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role
    // 'owner' is the one true superuser role and always passes. 'admin'
    // does NOT get a blanket bypass — it must be explicitly listed by the
    // route, same as every other role. (Previously 'admin' silently
    // bypassed every requireRole() check, including requireRole('owner')
    // routes like company deletion/restore and period unlock — that
    // defeated the owner-only protection those routes were written to
    // have, per their own comments. Every existing route that intends for
    // admins to have access already lists 'admin' explicitly, so this
    // does not remove any intentionally-granted access.)
    if (userRole === 'owner') return next()
    if (!roles.includes(userRole)) {
      return res.status(403).json({ success: false, code: 'ROLE_FORBIDDEN', message: `Access denied. Required: ${roles.join(' or ')}` })
    }
    next()
  }
}

/* ── Accounting permission guard ─────────────────────────────────────────
 * Fails CLOSED: an unrecognized `permission` key is a bug in the calling
 * route (a typo, or a capability that was never wired into permMap), and
 * must never be treated as "no restriction" / silently allowed. */
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
      const checker = permMap[permission]
      if (!checker) {
        console.error('[requirePermission] unknown permission key:', permission)
        return res.status(500).json({ success: false, code: 'AUTHORIZATION_CONFIG_ERROR', message: 'Authorization configuration error.' })
      }
      const user = await db('users').where({ id: req.user.id }).first()
      if (!user || !checker(user)) {
        return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', message: `Permission denied: ${permission}` })
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
async function stepUpSatisfied(req, { strictAction } = {}) {
  const headerToken = req.headers['x-step-up-token']
  if (headerToken && verifyStepUpToken(headerToken, { userId: req.user.id, companyId: req.companyId, strictAction })) {
    return 'ok'
  }
  // An inline confirmPassword/PIN is a live credential re-check performed
  // at the exact moment of THIS action, so it's inherently action-bound —
  // no scope concept needed for it.
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

      // Optional, per-company-toggle action — any valid, correctly-scoped
      // step-up token satisfies it (general-purpose or action-specific
      // alike). This preserves the existing "verify once, reuse for the
      // rest of the window" UX for these lower-stakes, admin-togglable
      // actions.
      const result = await stepUpSatisfied(req)
      if (result === 'ok') return next()
      if (result === 'wrong-credential') {
        return res.status(401).json({ success: false, code: 'STEP_UP_INVALID', message: 'Incorrect password', requiresPasswordConfirm: true })
      }
      return res.status(400).json({ success: false, code: 'STEP_UP_REQUIRED', message: 'Password confirmation is required for this action', requiresPasswordConfirm: true })
    } catch (err) { next(err) }
  }
}

function requireStepUp(actionKey) {
  return async (req, res, next) => {
    try {
      // Mandatory, non-toggleable action — a token minted for some OTHER
      // action (or a general-purpose token from setting a PIN, etc.) must
      // NOT satisfy this. Only a token issued specifically for actionKey,
      // or a fresh inline credential entered for this exact request, do.
      const result = await stepUpSatisfied(req, { strictAction: actionKey })
      if (result === 'ok') return next()
      if (result === 'wrong-credential') {
        return res.status(401).json({ success: false, code: 'STEP_UP_INVALID', message: 'Incorrect password', requiresPasswordConfirm: true, action: actionKey })
      }
      return res.status(400).json({ success: false, code: 'STEP_UP_REQUIRED', message: 'Verification is required for this action', requiresPasswordConfirm: true, action: actionKey })
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
/* Never forwards raw DB errors (message, detail, constraint name, stack) to
 * the client — those can leak schema/column/table names and internal
 * implementation details. Everything is logged server-side with a
 * requestId the client is given, for support/debugging purposes, but the
 * client only ever sees a safe, generic code+message. `err.status` /
 * `err.statusCode` (thrown deliberately by route code via AppError, e.g.
 * "Invalid email or password") are the one exception — those messages are
 * already written to be user-facing. */
function errorHandler(err, req, res, next) {
  const requestId = req.id || req.headers['x-request-id'] || uuidv4()
  console.error('[ERROR]', requestId, err.code || '', err.message, err.stack)

  // Known Postgres error codes → safe, generic application-facing codes.
  // The real detail/constraint/message is logged above, never returned.
  const PG_ERROR_MAP = {
    '23505': { status: 409, code: 'DUPLICATE_RESOURCE', message: 'A record with this value already exists.' },
    '23514': { status: 400, code: 'INVALID_REQUEST', message: 'The request violates a data constraint.' },
    '23503': { status: 400, code: 'INVALID_REQUEST', message: 'Referenced record does not exist.' },
    '23502': { status: 400, code: 'INVALID_REQUEST', message: 'A required field is missing.' },
    '22P02': { status: 400, code: 'INVALID_REQUEST', message: 'Invalid value provided.' },
  }
  if (PG_ERROR_MAP[err.code]) {
    const mapped = PG_ERROR_MAP[err.code]
    return res.status(mapped.status).json({ success: false, code: mapped.code, message: mapped.message, requestId })
  }
  if (err.code === 'P0001') {
    // Custom RAISE EXCEPTION from a trigger/function — these are written
    // by us to already be user-safe (e.g. voucher balance checks).
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: err.message, requestId })
  }

  // Any error explicitly thrown by route code (AppError, etc.) with a
  // 4xx status was authored to be shown to the user. Anything else
  // (unexpected 5xx, unhandled exceptions, raw driver/library errors)
  // gets a fully generic message — the specifics stay in the server log.
  const status = err.status || err.statusCode || 500
  if (status >= 400 && status < 500 && err.message) {
    return res.status(status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message, requestId })
  }
  res.status(status >= 500 ? status : 500).json({ success: false, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId })
}

module.exports = { authenticate, identifyDevice, requireActiveDevice, requireRole, requirePermission, requireSensitiveConfirm, requireStepUp, errorHandler, ok, paginated }
