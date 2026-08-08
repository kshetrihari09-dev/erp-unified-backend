/**
 * pinAuth.js — verifies a step-up credential (PIN or password re-entry)
 * against the acting user's own account, with per-account lockout.
 *
 * This is deliberately its own small module (not stuffed into
 * routes/auth.js) so both the HTTP route AND any future direct callers
 * share exactly one lockout implementation — no risk of the counter
 * logic drifting between two copies.
 */
const bcrypt = require('bcryptjs')
const db     = require('../db/knex')
const AuditLogger = require('./auditLogger')

const MAX_ATTEMPTS   = 5
const LOCKOUT_MINUTES = 15

/**
 * @returns {{ ok: true, user }} on success
 *          {{ ok: false, status, message }} on failure — status is the
 *          HTTP status the caller should respond with.
 */
async function verifyStepUpCredential({ userId, companyId, pin, password, ip }) {
  const user = await db('users').where({ id: userId }).first()
  if (!user) return { ok: false, status: 404, message: 'User not found' }

  // ── Locked out? ──────────────────────────────────────────────────────
  if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
    const minsLeft = Math.ceil((new Date(user.pin_locked_until) - new Date()) / 60000)
    await AuditLogger.log(db, {
      companyId, userId, action: 'STEP_UP_LOCKED', entityType: 'auth', entityId: userId, ipAddress: ip,
    })
    return {
      ok: false, status: 429,
      message: `Too many failed attempts. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}.`,
    }
  }

  // ── Check whichever credential was supplied ──────────────────────────
  let valid = false
  let method = null
  if (pin) {
    method = 'pin'
    if (!user.pin_hash) {
      return { ok: false, status: 400, message: 'No security PIN is set on this account yet.', needsPinSetup: true }
    }
    valid = await bcrypt.compare(String(pin), user.pin_hash)
  } else if (password) {
    method = 'password'
    if (!user.password_hash) {
      return { ok: false, status: 400, message: 'No password is set on this account, so this action cannot be confirmed.' }
    }
    valid = await bcrypt.compare(password, user.password_hash)
  } else {
    return { ok: false, status: 400, message: 'PIN or password is required.' }
  }

  if (!valid) {
    const attempts = (user.pin_failed_attempts || 0) + 1
    const update = { pin_failed_attempts: attempts }
    if (attempts >= MAX_ATTEMPTS) {
      update.pin_locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60000)
    }
    await db('users').where({ id: userId }).update(update)
    await AuditLogger.log(db, {
      companyId, userId, action: 'STEP_UP_FAILED', entityType: 'auth', entityId: userId, ipAddress: ip,
      payloadAfter: { method, attempts },
    })
    return { ok: false, status: 401, message: method === 'pin' ? 'Incorrect PIN' : 'Incorrect password' }
  }

  // ── Success — clear the failure counter ──────────────────────────────
  await db('users').where({ id: userId }).update({ pin_failed_attempts: 0, pin_locked_until: null })
  await AuditLogger.log(db, {
    companyId, userId, action: 'STEP_UP_SUCCESS', entityType: 'auth', entityId: userId, ipAddress: ip,
    payloadAfter: { method },
  })
  return { ok: true, user }
}

module.exports = { verifyStepUpCredential, MAX_ATTEMPTS, LOCKOUT_MINUTES }
