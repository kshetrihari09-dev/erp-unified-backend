/**
 * src/config/rateLimitConfig.js
 *
 * Pure loader + validator for every rate-limit / proxy-trust setting.
 *
 *   loadRateLimitConfig(env, { isProd, isDev }) -> frozen config object
 *
 * Throws RateLimitConfigError (never process.exit) so it is unit-testable;
 * config/index.js turns that into a fail-fast boot error.
 *
 * DESIGN NOTES
 * ------------
 * 1. Variable names are NEW on purpose (RATE_LIMIT_USER_MAX, ...). The previous
 *    names (RATE_LIMIT_MAX=100 per 15 min per IP, AUTH_RATE_LIMIT_MAX=10, ...)
 *    are frequently still set on the hosting dashboard / in .env.production.
 *    Re-using them would silently keep the old, far-too-small budget alive
 *    after deploying this change. Legacy names are therefore IGNORED and
 *    reported in `legacyVarsIgnored` so the server can log a warning.
 * 2. Invalid values (non-numeric, <= 0, absurdly large) fail the boot instead
 *    of silently falling back - a typo must not become "unlimited" or "1".
 * 3. `TRUST_PROXY=true` is rejected in production: it makes Express believe the
 *    LEFT-most X-Forwarded-For entry, which any client can forge to dodge
 *    every per-IP limit.
 */
'use strict'

class RateLimitConfigError extends Error {
  constructor(problems) {
    super(`Invalid rate-limit configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'RateLimitConfigError'
    this.problems = problems
  }
}

/** Old variable names that are intentionally no longer read. */
const LEGACY_VARS = [
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_WINDOW_MS',
  'AUTH_RATE_LIMIT_MAX',
  'SCANNER_RATE_LIMIT_MAX',
  'REPORTS_RATE_LIMIT_MAX',
  'OCR_RATE_LIMIT_MAX',
]

const MIN_WINDOW_MS = 1_000
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_LIMIT     = 1_000_000

function loadRateLimitConfig(env = process.env, { isProd = false, isDev = false } = {}) {
  const problems = []

  function int(key, def, { min = 1, max = MAX_LIMIT } = {}) {
    const raw = env[key]
    if (raw === undefined || raw === '') return def
    if (!/^\d+$/.test(String(raw).trim())) {
      problems.push(`${key}="${raw}" is not a positive integer`)
      return def
    }
    const n = parseInt(raw, 10)
    if (n < min || n > max) {
      problems.push(`${key}=${n} is out of range (${min}..${max})`)
      return def
    }
    return n
  }

  function oneOf(key, def, allowed) {
    const raw = env[key]
    if (raw === undefined || raw === '') return def
    const v = String(raw).trim().toLowerCase()
    if (!allowed.includes(v)) {
      problems.push(`${key}="${raw}" must be one of: ${allowed.join(', ')}`)
      return def
    }
    return v
  }

  function bool(key, def) {
    const raw = env[key]
    if (raw === undefined || raw === '') return def
    const v = String(raw).trim().toLowerCase()
    if (['true', '1', 'yes'].includes(v))  return true
    if (['false', '0', 'no'].includes(v))  return false
    problems.push(`${key}="${raw}" must be true or false`)
    return def
  }

  // ── Windows ────────────────────────────────────────────────────────────
  // API traffic uses a SHORT window: a burst is forgiven within a minute
  // instead of locking a person out for up to 15 minutes (the old behaviour).
  // Credential endpoints keep a LONG window because brute force is slow.
  const apiWindowMs  = int('RATE_LIMIT_API_WINDOW_MS',  60_000,      { min: MIN_WINDOW_MS, max: MAX_WINDOW_MS })
  const authWindowMs = int('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60_000, { min: MIN_WINDOW_MS, max: MAX_WINDOW_MS })
  const ocrWindowMs  = int('RATE_LIMIT_OCR_UPLOAD_WINDOW_MS', 5 * 60_000, { min: MIN_WINDOW_MS, max: MAX_WINDOW_MS })
  const heavyWindowMs = int('RATE_LIMIT_HEAVY_OPS_WINDOW_MS', 5 * 60_000, { min: MIN_WINDOW_MS, max: MAX_WINDOW_MS })

  // ── Budgets (per window) ───────────────────────────────────────────────
  // Sizing - derived from reading the client, not from live metrics (none are
  // available in the source tree): a dashboard load is ~8-10 requests, a POS
  // product search is 1 request per 200 ms-debounced keystroke burst
  // (<= ~10/min while actively billing), the two background pollers are
  // 1-2 requests/min each. A busy cashier peaks well under 150 requests/min,
  // so 300/min/user leaves 2x headroom while still stopping a runaway loop
  // (a loop at even 5 req/s = 300/min trips it within a minute).
  const limits = {
    // Tier 1 - baseline, every /api/v1 request counted exactly once here.
    user:    int('RATE_LIMIT_USER_MAX',    isDev ? 2000 : 300),   // per verified user
    company: int('RATE_LIMIT_COMPANY_MAX', isDev ? 6000 : 1200),  // per verified company/tenant (all its staff)
    ip:      int('RATE_LIMIT_IP_MAX',      isDev ? 1000 : 120),   // UNauthenticated traffic only, per IP

    // Tier 2 - specialised, only for the routes named in middleware/rateLimit/index.js.
    authFail:  int('RATE_LIMIT_AUTH_FAIL_MAX',  isDev ? 100 : 20), // FAILED login/register/verify-otp per IP per auth window
    otpSend:   int('RATE_LIMIT_OTP_SEND_MAX',   isDev ? 100 : 10), // OTP sends (SMS/WhatsApp/e-mail cost money) per IP per auth window
    refresh:   int('RATE_LIMIT_REFRESH_MAX',    isDev ? 300 : 60), // token refresh per IP per auth window
    sensitive: int('RATE_LIMIT_SENSITIVE_MAX',  isDev ? 100 : 10), // password/PIN checks, per verified user per auth window
    reports:   int('RATE_LIMIT_REPORTS_MAX',    isDev ? 600 : 90), // heavy aggregate SQL, per verified user per api window
    scanner:   int('RATE_LIMIT_SCANNER_MAX',    isDev ? 600 : 180),// barcode/fuzzy lookups, per verified user per api window
    ocrUpload: int('RATE_LIMIT_OCR_UPLOAD_MAX', isDev ? 100 : 15), // Sharp+Tesseract uploads, per verified user per OCR window
    // Manual, admin-only, never-looped heavy operations (full-DB backup run / download).
    // NOT applied to /cloud-storage/upload: AutoCloudBackup uploads one PDF per invoice.
    heavyOps:  int('RATE_LIMIT_HEAVY_OPS_MAX',  isDev ? 100 : 10),
  }

  // ── Store ──────────────────────────────────────────────────────────────
  const store = oneOf('RATE_LIMIT_STORE', 'memory', ['memory', 'redis'])
  const redisUrl = env.REDIS_URL ? String(env.REDIS_URL).trim() : null
  if (store === 'redis' && !redisUrl) {
    problems.push('RATE_LIMIT_STORE=redis requires REDIS_URL')
  }
  const redisPrefix = env.RATE_LIMIT_REDIS_PREFIX ? String(env.RATE_LIMIT_REDIS_PREFIX).trim() : 'byapar:rl:'

  // ── Proxy trust ────────────────────────────────────────────────────────
  // Number  -> that many proxy hops in front of Node (Express semantics)
  // CIDRs   -> comma list, e.g. "loopback, 10.0.0.0/8" (Express semantics)
  // false   -> trust nobody, use the socket address
  const rawTrust = env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? '1' : String(env.TRUST_PROXY).trim()
  let trustProxy
  if (/^\d+$/.test(rawTrust)) {
    trustProxy = parseInt(rawTrust, 10)
    if (trustProxy > 10) problems.push(`TRUST_PROXY=${trustProxy} hops is implausible (max 10)`)
  } else if (rawTrust.toLowerCase() === 'false') {
    trustProxy = false
  } else if (rawTrust.toLowerCase() === 'true') {
    if (isProd) problems.push('TRUST_PROXY=true is forbidden in production (X-Forwarded-For becomes spoofable). Use a hop count (e.g. 1) or a CIDR list.')
    trustProxy = true
  } else if (/^[A-Za-z0-9.:/_,\s-]+$/.test(rawTrust)) {
    trustProxy = rawTrust.split(',').map(s => s.trim()).filter(Boolean)
  } else {
    problems.push(`TRUST_PROXY="${rawTrust}" is not a hop count, "false", or a comma-separated CIDR/keyword list`)
    trustProxy = 1
  }

  const logRejections = bool('RATE_LIMIT_LOG_REJECTIONS', true)
  const diagnosticsRoles = String(env.RATE_LIMIT_DIAGNOSTICS_ROLES || 'owner,admin')
    .split(',').map(s => s.trim()).filter(Boolean)

  if (problems.length) throw new RateLimitConfigError(problems)

  const legacyVarsIgnored = LEGACY_VARS.filter(k => env[k] !== undefined && env[k] !== '')

  return Object.freeze({
    apiWindowMs, authWindowMs, ocrWindowMs, heavyWindowMs,
    limits: Object.freeze(limits),
    store, redisUrl, redisPrefix,
    trustProxy,
    logRejections,
    diagnosticsRoles,
    legacyVarsIgnored,
  })
}

module.exports = { loadRateLimitConfig, RateLimitConfigError, LEGACY_VARS }
