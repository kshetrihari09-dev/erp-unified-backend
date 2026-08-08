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
 */
const jwt = require('jsonwebtoken')

const STEP_UP_TYPE = 'stepup'
const STEP_UP_TTL_SECONDS = Number(process.env.STEP_UP_TTL_SECONDS) || 10 * 60 // 10 minutes

function signStepUpToken({ userId, companyId }) {
  return jwt.sign(
    { type: STEP_UP_TYPE, userId, companyId },
    process.env.JWT_SECRET,
    { expiresIn: STEP_UP_TTL_SECONDS }
  )
}

/**
 * Verifies a step-up token belongs to THIS authenticated request's user
 * and company (both already established by the `authenticate`
 * middleware from the real session JWT — never from anything the
 * client claims). Returns true/false; never throws.
 */
function verifyStepUpToken(token, { userId, companyId }) {
  if (!token) return false
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    return (
      payload.type === STEP_UP_TYPE &&
      String(payload.userId) === String(userId) &&
      String(payload.companyId) === String(companyId)
    )
  } catch {
    return false // expired, malformed, wrong signature — all just "not verified"
  }
}

module.exports = { signStepUpToken, verifyStepUpToken, STEP_UP_TTL_SECONDS }
