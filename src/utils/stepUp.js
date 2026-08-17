/**
 * stepUp.js — short-lived "I just re-verified" token.
 *
 * Separate from the main session JWT (see routes/auth.js signToken):
 * this token proves nothing about identity or session validity on its
 * own — it's only ever checked ALONGSIDE the normal `authenticate`
 * middleware, which has already verified who the user is. All this
 * token adds is "and this same user completed step-up verification
 * recently enough that it's still valid" — a temporary, self-expiring
 * fact, deliberately not a permanent flag (per the step-up spec: no
 * permanent "verified" state).
 *
 * Stateless by design (a signed JWT, not a DB row) so it costs nothing
 * to check on every sensitive request and needs no cleanup job — it
 * simply stops verifying once `exp` passes.
 *
 * ── Tiered scope ──────────────────────────────────────────────────────
 * Two kinds of token, both userId+companyId+expiration bound as before:
 *
 *   - GENERAL token (`scope: 'general'`) — issued when the caller isn't
 *     verifying for one specific action (e.g. /auth/security-pin, or
 *     /auth/verify-password with no `action` given). Satisfies any
 *     OPTIONAL, per-company-toggle sensitive action
 *     (requireSensitiveConfirm) — this is what keeps the existing
 *     "verify once via the PIN modal, then every toggleable sensitive
 *     action for ~10 minutes just works" UX unchanged.
 *
 *   - ACTION-SCOPED token (`scope: '<actionKey>'`) — issued when the
 *     caller passes `action` (e.g. the voucher-edit dialog verifying
 *     specifically to unlock a posted voucher). Only satisfies a STRICT
 *     check (requireStepUp) for that exact action — a token scoped to
 *     'voucherEdit' does not authorize a 'reverseEntry' (or any other)
 *     strict action, closing the gap where completing step-up for one
 *     mandatory action silently unlocked every other one for the rest
 *     of the window. It still satisfies general/optional checks (it's a
 *     strictly stronger proof of "recently re-verified" than a general
 *     token, so there's no reason to reject it there).
 */
const jwt = require('jsonwebtoken')

const STEP_UP_TYPE = 'stepup'
const STEP_UP_TTL_SECONDS = Number(process.env.STEP_UP_TTL_SECONDS) || 10 * 60 // 10 minutes
const GENERAL_SCOPE = 'general'

function signStepUpToken({ userId, companyId, action }) {
  return jwt.sign(
    { type: STEP_UP_TYPE, userId, companyId, scope: action || GENERAL_SCOPE },
    process.env.JWT_SECRET,
    { expiresIn: STEP_UP_TTL_SECONDS }
  )
}

/**
 * Verifies a step-up token belongs to THIS authenticated request's user
 * and company (both already established by the `authenticate`
 * middleware from the real session JWT — never from anything the
 * client claims).
 *
 * `strictAction` — when provided, the token must have been issued
 * specifically for this action (scope must match exactly). When
 * omitted, any valid, correctly-scoped-to-this-user/company token
 * passes, general or action-scoped alike.
 *
 * Returns true/false; never throws.
 */
function verifyStepUpToken(token, { userId, companyId, strictAction } = {}) {
  if (!token) return false
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    if (payload.type !== STEP_UP_TYPE) return false
    if (String(payload.userId) !== String(userId)) return false
    if (String(payload.companyId) !== String(companyId)) return false
    if (strictAction) return payload.scope === strictAction
    return true
  } catch {
    return false // expired, malformed, wrong signature — all just "not verified"
  }
}

module.exports = { signStepUpToken, verifyStepUpToken, STEP_UP_TTL_SECONDS, GENERAL_SCOPE }
