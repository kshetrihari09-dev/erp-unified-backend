/**
 * refreshTokens.js — server-side refresh-token session lifecycle.
 *
 * Refresh tokens are opaque random bearer strings (NOT JWTs) — the server
 * is the only place that can tell a valid one from garbage, which is what
 * makes revocation possible at all. Only a SHA-256 hash of the token is
 * ever stored (see migrations/029_refresh_tokens.js); the raw value exists
 * only in the HTTP response and the client's storage.
 *
 * Rotation: every successful /auth/refresh call revokes the presented
 * token and issues a brand-new one in the same `family_id`. A client is
 * therefore expected to always be holding the MOST RECENT token in its
 * family — presenting an older, already-rotated one is a reuse signal
 * (see rotateRefreshToken below).
 */
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db = require('../db/knex')

function parseDurationMs(str, fallbackMs) {
  const m = String(str || '').match(/^(\d+)\s*(d|h|m|s)$/i)
  if (!m) return fallbackMs
  const mult = { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[1] ? m[2].toLowerCase() : '']
  return Number(m[1]) * mult
}
const REFRESH_TTL_MS = parseDurationMs(process.env.JWT_REFRESH_EXPIRES_IN, 7 * 86400000)

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** Mints a brand-new refresh token + session row. Starts a new family
 *  unless `familyId` is passed (used internally by rotation). */
async function issueRefreshToken({ userId, familyId, ip, userAgent }) {
  const raw = crypto.randomBytes(48).toString('base64url')
  const [row] = await db('refresh_tokens').insert({
    user_id: userId,
    token_hash: hashToken(raw),
    family_id: familyId || uuidv4(),
    expires_at: new Date(Date.now() + REFRESH_TTL_MS),
    ip: ip || null,
    user_agent: (userAgent || '').slice(0, 255) || null,
    last_used_at: new Date(),
  }).returning(['id', 'family_id'])
  return { raw, id: row.id, familyId: row.family_id }
}

/**
 * Validates + rotates a presented refresh token.
 * Returns one of:
 *   { ok: true, userId, raw, familyId }
 *   { ok: false, code: 'INVALID' | 'EXPIRED' }
 *   { ok: false, code: 'REUSE_DETECTED', userId }  — family has been revoked; caller must force a full re-login
 */
async function rotateRefreshToken({ token, ip, userAgent }) {
  const hash = hashToken(token)
  const row = await db('refresh_tokens').where({ token_hash: hash }).first()
  if (!row) return { ok: false, code: 'INVALID' }

  if (row.revoked_at) {
    // This exact token was already rotated (or otherwise revoked) once
    // before — being presented again means either a client retried a
    // stale copy, or it leaked and someone else is using it. Either way,
    // the safe response is the same: kill every token in the family so
    // whichever party still holds a live session has to log in again.
    await db('refresh_tokens')
      .where({ family_id: row.family_id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), revoked_reason: 'reuse_detected', updated_at: new Date() })
    return { ok: false, code: 'REUSE_DETECTED', userId: row.user_id }
  }
  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, code: 'EXPIRED' }
  }

  const next = await issueRefreshToken({ userId: row.user_id, familyId: row.family_id, ip, userAgent })
  await db('refresh_tokens').where({ id: row.id }).update({
    revoked_at: new Date(), revoked_reason: 'rotated', replaced_by: next.id, updated_at: new Date(),
  })
  return { ok: true, userId: row.user_id, raw: next.raw, familyId: row.family_id }
}

/** Logout — revokes just the one presented token. Never throws; a token
 *  that's already gone/invalid is treated as already logged out. */
async function revokeToken(token, reason = 'logout') {
  if (!token) return
  await db('refresh_tokens')
    .where({ token_hash: hashToken(token) })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date(), revoked_reason: reason, updated_at: new Date() })
}

/** Revoke-all-sessions — used for the explicit user-facing action, and
 *  internally after a password/PIN change or account deactivation. */
async function revokeAllForUser(userId, reason) {
  await db('refresh_tokens')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date(), revoked_reason: reason, updated_at: new Date() })
}

module.exports = { issueRefreshToken, rotateRefreshToken, revokeToken, revokeAllForUser, REFRESH_TTL_MS }
