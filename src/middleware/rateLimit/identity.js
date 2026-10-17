/**
 * middleware/rateLimit/identity.js
 *
 * Resolves WHO a request belongs to, for rate-limit bucketing only.
 *
 * WHY THIS EXISTS
 * ---------------
 * `authenticate` (middleware/index.js) runs INSIDE each router, i.e. after the
 * global limiter. So at limiter time `req.user` does not exist yet, which is why
 * the old limiter could only ever key on req.ip - and every staff member behind
 * one shop router shared a single bucket.
 *
 * SECURITY MODEL
 * --------------
 * - Identity is taken ONLY from a Bearer JWT whose HMAC signature and expiry
 *   verify against JWT_SECRET (the same secret/rules `authenticate` uses).
 *   X-User-Id style headers, query strings and request bodies are NEVER read.
 * - A forged / expired / wrong-secret / malformed token yields NO identity, so
 *   the request falls back to the per-IP bucket for unauthenticated traffic.
 *   An attacker therefore cannot choose, rotate or inflate their bucket key.
 * - This is bucketing, not authorisation: `authenticate` still performs the
 *   database checks (account active, company membership) before any handler
 *   runs. A signature-valid token for a since-disabled user can only ever
 *   consume that user's own bucket, then gets 401/403 from `authenticate`.
 * - Tokens issued for the removed customer storefront (kind === 'customer') are
 *   never treated as staff identities.
 * - Pure CPU (one HMAC) - no database access on the hot path.
 */
'use strict'

const jwt = require('jsonwebtoken')

const IDENTITY_KEY = 'rateLimitIdentity'
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/   // uuid / numeric ids; blocks key-injection via weird claims

function safeId(v) {
  if (v === undefined || v === null) return null
  const s = String(v)
  return ID_PATTERN.test(s) ? s : null
}

/**
 * Pure helper (exported for tests): returns { userId, companyId } or null.
 */
function verifyIdentityFromAuthHeader(authorization, secret) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null
  if (!secret) return null
  const token = authorization.slice(7).trim()
  if (!token || token.length > 4096) return null
  let payload
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256', 'HS384', 'HS512'] })
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || payload.kind === 'customer') return null
  const userId = safeId(payload.userId)
  const companyId = safeId(payload.companyId)
  if (!userId || !companyId) return null
  return { userId, companyId }
}

/**
 * Express middleware. Resolves identity once per request and caches it on
 * `req.rateLimitIdentity` (null when unauthenticated). Never rejects a request.
 */
function resolveRateLimitIdentity(getSecret = () => process.env.JWT_SECRET) {
  return function rateLimitIdentity(req, _res, next) {
    if (!(IDENTITY_KEY in req)) {
      req[IDENTITY_KEY] = verifyIdentityFromAuthHeader(req.headers.authorization, getSecret())
    }
    next()
  }
}

/** Reads the cached identity (resolving lazily if the middleware did not run yet). */
function getIdentity(req, getSecret = () => process.env.JWT_SECRET) {
  if (!(IDENTITY_KEY in req)) {
    req[IDENTITY_KEY] = verifyIdentityFromAuthHeader(req.headers.authorization, getSecret())
  }
  return req[IDENTITY_KEY]
}

module.exports = { resolveRateLimitIdentity, verifyIdentityFromAuthHeader, getIdentity, IDENTITY_KEY }
