/**
 * middleware/rateLimit/diagnostics.js
 *
 * Everything needed to tell, after the fact, WHICH layer produced a 429 and why.
 *
 * A 429 can come from four different places; each leaves a different fingerprint:
 *
 *   source header (X-RateLimit-Source)   meaning
 *   ----------------------------------   -----------------------------------------
 *   app-limiter                          an express-rate-limit instance in THIS app
 *                                        (X-RateLimit-Limiter names which one)
 *   application                          app code returned 429 itself (PIN lockout,
 *                                        OTP quota) - NOT a traffic limiter
 *   nginx                                nginx limit_req (see nginx/*.conf)
 *   (none of the above)                  hosting platform / CDN / upstream provider -
 *                                        it never reached this app's limiter code
 *
 * Log lines are single-line JSON with the stable `event` names below so they can be
 * grepped / shipped to a log platform:
 *
 *   rate_limit_rejected   a limiter in this app rejected the request
 *   http_429_application  app code (not a limiter) answered 429
 *
 * NEVER logged: Authorization header, tokens, passwords, OTP values, request bodies,
 * query strings. Only ids (uuid), method, normalised route, counts and timings.
 */
'use strict'

const net = require('net')

// ── IP key ────────────────────────────────────────────────────────────────
/**
 * Normalises an address into a bucket key.
 *  - IPv4-mapped IPv6 (::ffff:1.2.3.4) -> the IPv4 address
 *  - IPv6 -> its /64 prefix (a single customer is normally handed a whole /64,
 *    so keying on the full address lets one host rotate through 2^64 buckets)
 * Only ever called with req.ip (Express's trust-proxy-aware address) - never with a
 * raw X-Forwarded-For header.
 */
function ipKey(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown'
  let a = ip.trim()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a)
  if (mapped) a = mapped[1]
  if (net.isIPv4(a)) return a
  if (net.isIPv6(a)) {
    // expand "::" then keep the first 4 groups (/64)
    const [head, tail = ''] = a.split('::')
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    const missing = a.includes('::') ? 8 - h.length - t.length : 0
    const groups = [...h, ...Array(Math.max(0, missing)).fill('0'), ...t]
    return groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64'
  }
  return 'unknown'
}

// ── Route template (low-cardinality, no ids / query string) ───────────────
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function routeTemplate(req) {
  const raw = String(req.originalUrl || req.url || '').split('?')[0]
  return raw
    .replace(UUID_RE, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{20,}(?=\/|$)/gi, '/:id')
    .slice(0, 160)
}

// ── Counters (since process start) ────────────────────────────────────────
const counters = new Map()
function bump(limiter) {
  const c = counters.get(limiter) || { rejected: 0, lastRejectedAt: null }
  c.rejected += 1
  c.lastRejectedAt = new Date().toISOString()
  counters.set(limiter, c)
}
function snapshotCounters() {
  return Object.fromEntries(counters.entries())
}
function resetCounters() { counters.clear() }

// ── Logging ───────────────────────────────────────────────────────────────
let sink = (line) => console.warn(line)
/** Test hook: capture log lines. Pass null to restore console output. */
function setLogSink(fn) { sink = fn || ((line) => console.warn(line)) }
let enabled = true
function setLoggingEnabled(v) { enabled = !!v }

function proxyInfo(req, trustProxySetting) {
  const xff = req.headers['x-forwarded-for']
  return {
    trustProxy: trustProxySetting === undefined ? null : trustProxySetting,
    forwardedHops: Array.isArray(req.ips) ? req.ips.length : 0,
    xffPresent: typeof xff === 'string' && xff.length > 0,
    viaTrustedProxy: Array.isArray(req.ips) && req.ips.length > 0,
  }
}

function logRejection({ req, limiterName, keyType, reason, info, retryAfterSeconds, windowMs, trustProxy }) {
  bump(limiterName)
  if (!enabled) return
  const identity = req.rateLimitIdentity || null
  const line = {
    ts: new Date().toISOString(),
    level: 'warn',
    event: 'rate_limit_rejected',
    source: 'app-limiter',
    requestId: req.id || null,
    method: req.method,
    route: routeTemplate(req),
    limiter: limiterName,
    keyType,                                    // user | company | ip
    reason,
    userId: identity ? identity.userId : null,
    companyId: identity ? identity.companyId : null,
    ip: ipKey(req.ip),
    proxy: proxyInfo(req, trustProxy),
    limit: info && info.limit,
    used: info && info.used,
    remaining: info && info.remaining,
    windowMs,
    retryAfterSeconds,
    resetAt: info && info.resetTime ? new Date(info.resetTime).toISOString() : null,
    durationMs: req._rlStartedAt ? Date.now() - req._rlStartedAt : null,
    status: 429,
  }
  try { sink(JSON.stringify(line)) } catch { /* logging must never break a request */ }
}

/**
 * Middleware: (1) stamps start time, (2) tags every 429 with X-RateLimit-Source when
 * the app limiter did not already, and (3) logs 429s that did NOT come from a limiter
 * (so "application" 429s are visible and distinguishable from traffic limiting).
 */
function classify429(getTrustProxy = () => undefined) {
  return function classify429Middleware(req, res, next) {
    req._rlStartedAt = Date.now()
    const origWriteHead = res.writeHead
    res.writeHead = function patchedWriteHead(status, ...rest) {
      if (status === 429 && !res.getHeader('X-RateLimit-Source') && !res.headersSent) {
        res.setHeader('X-RateLimit-Source', 'application')
      }
      return origWriteHead.call(this, status, ...rest)
    }
    res.on('finish', () => {
      if (res.statusCode !== 429) return
      if (res.getHeader('X-RateLimit-Source') !== 'application') return
      bump('application')
      if (!enabled) return
      const identity = req.rateLimitIdentity || null
      try {
        sink(JSON.stringify({
          ts: new Date().toISOString(), level: 'warn', event: 'http_429_application', source: 'application',
          requestId: req.id || null, method: req.method, route: routeTemplate(req),
          userId: identity ? identity.userId : null, companyId: identity ? identity.companyId : null,
          ip: ipKey(req.ip), proxy: proxyInfo(req, getTrustProxy()),
          note: 'Application-defined 429 (not a traffic limiter): check the response body `code`.',
          durationMs: Date.now() - req._rlStartedAt, status: 429,
        }))
      } catch { /* ignore */ }
    })
    next()
  }
}

module.exports = {
  ipKey, routeTemplate, logRejection, classify429, snapshotCounters, resetCounters, setLogSink, setLoggingEnabled, proxyInfo,
}
