/**
 * middleware/rateLimit/index.js
 *
 * createRateLimiters(cfg, deps) builds every limiter used by server.js.
 * Each limiter has ONE documented responsibility. A request is counted by at
 * most: the baseline tier + ONE specialised tier (never two specialised ones).
 *
 * ┌─────────────────────┬───────────────────────────────┬───────────────────┬──────────────────────────┐
 * │ limiter (header)    │ applies to                    │ bucket key        │ counts                   │
 * ├─────────────────────┼───────────────────────────────┼───────────────────┼──────────────────────────┤
 * │ TIER 1 - baseline: every /api/v1 request, exactly once                                             │
 * │ user                │ requests w/ a VERIFIED JWT    │ u:<userId>        │ every request            │
 * │ company             │ requests w/ a VERIFIED JWT    │ c:<companyId>     │ every request (tenant    │
 * │                     │                               │                   │ ceiling across its staff)│
 * │ ip                  │ requests WITHOUT valid JWT    │ ip:<addr or /64>  │ every request            │
 * │ TIER 2 - specialised: only on the routes below, in ADDITION to tier 1                              │
 * │ auth_fail           │ POST /auth/login|verify-otp   │ ip:<addr>         │ FAILED attempts only     │
 * │ auth_register       │ POST /auth/register           │ ip:<addr>         │ every attempt            │
 * │ otp_send            │ POST /auth/send-otp           │ ip:<addr>         │ every send (costs money) │
 * │ auth_refresh        │ POST /auth/refresh            │ ip:<addr>         │ every attempt            │
 * │ auth_sensitive      │ POST /auth/verify-password,   │ u:<userId> (IP if │ FAILED attempts only     │
 * │                     │  security-pin, add-contact,   │  no valid JWT)    │                          │
 * │                     │  add-phone, revoke-sessions;  │                   │                          │
 * │                     │  PUT /auth/change-password    │                   │                          │
 * │ reports             │ /reports/*, /stock-register/* │ u:<userId> or IP  │ every request            │
 * │ scanner             │ /scanner/*                    │ u:<userId> or IP  │ every request            │
 * │ ocr_upload          │ POST /purchase-scans (upload) │ u:<userId> or IP  │ every upload             │
 * │ heavy_ops           │ POST /settings/backup/run,    │ u:<userId> or IP  │ every request            │
 * │                     │ GET /settings/backup/:id/download                 │                          │
 * └─────────────────────┴───────────────────────────────┴───────────────────┴──────────────────────────┘
 *
 * Deliberately NOT specialised-limited:
 *  - GET /purchase-scans/:id (the OCR status poll) - a cheap indexed read; it is
 *    covered by tier 1 and by the client's own backoff. It used to share the 30/15min
 *    upload budget, so a single slow scan polled at 2 s exhausted it.
 *  - /auth/me and /auth/logout - cheap, authenticated, session plumbing; tier 1 only.
 *    They used to share the 10/15min login budget, which locked a whole shop out of
 *    its own session checks.
 *  - /health and /api/v1/discovery/info are mounted before this stack (monitoring,
 *    LAN discovery) and are not limited.
 *
 * Identity: only from a signature-verified JWT (identity.js). IP: only from req.ip
 * (Express' trust-proxy-aware address) - X-Forwarded-For is never read directly.
 */
'use strict'

const express = require('express')
const { rateLimit } = require('express-rate-limit')
const { resolveRateLimitIdentity, getIdentity } = require('./identity')
const { ipKey, logRejection, classify429, setLoggingEnabled } = require('./diagnostics')
const { createStoreProvider } = require('./store')

const MESSAGES = {
  user:           'Too many requests. Please wait and try again.',
  company:        'Your company is sending too many requests. Please wait and try again.',
  ip:             'Too many requests. Please wait and try again.',
  auth_fail:      'Too many failed authentication attempts. Please wait before trying again.',
  auth_register:  'Too many registration attempts. Please wait before trying again.',
  otp_send:       'Too many verification codes requested. Please wait before trying again.',
  auth_refresh:   'Too many session refresh attempts. Please wait and try again.',
  auth_sensitive: 'Too many failed security checks. Please wait before trying again.',
  reports:        'Too many report requests. Please wait and try again.',
  scanner:        'Too many scanner lookups. Please wait and try again.',
  ocr_upload:     'Too many bill-scan uploads. Please wait and try again.',
  heavy_ops:      'This operation was requested too often. Please wait a few minutes and try again.',
}

function createRateLimiters(cfg, deps = {}) {
  const logger        = deps.logger || console
  const getSecret     = deps.getSecret || (() => process.env.JWT_SECRET)
  const storeProvider = deps.storeProvider || createStoreProvider(cfg, { logger })
  setLoggingEnabled(cfg.logRejections)

  const windows = { api: cfg.apiWindowMs, auth: cfg.authWindowMs, ocr: cfg.ocrWindowMs, heavy: cfg.heavyWindowMs }

  // ── bucket key helpers ──────────────────────────────────────────────────
  const userOrIpKey = (req) => {
    const id = getIdentity(req, getSecret)
    return id ? `u:${id.userId}` : `ip:${ipKey(req.ip)}`
  }
  const ipOnlyKey = (req) => `ip:${ipKey(req.ip)}`
  const keyTypeOf = (req) => (getIdentity(req, getSecret) ? 'user' : 'ip')

  // ── shared 429 handler ──────────────────────────────────────────────────
  // `nameOrFn` may be a function so ONE counter instance can report as `user` or
  // `ip` depending on which bucket the request fell into.
  function handlerFor(nameOrFn, windowMs, keyTypeFn) {
    return (req, res) => {
      const name = typeof nameOrFn === 'function' ? nameOrFn(req) : nameOrFn
      const info = req.rateLimit || {}
      const resetMs = info.resetTime ? new Date(info.resetTime).getTime() : Date.now() + windowMs
      const retryAfterSeconds = Math.min(Math.ceil(windowMs / 1000), Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.setHeader('X-RateLimit-Limiter', name)
      res.setHeader('X-RateLimit-Source', 'app-limiter')
      logRejection({
        req, limiterName: name, keyType: keyTypeFn(req),
        reason: `limit of ${info.limit} requests per ${Math.round(windowMs / 1000)}s exceeded`,
        info, retryAfterSeconds, windowMs, trustProxy: cfg.trustProxy,
      })
      res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        limiter: name,
        message: MESSAGES[name] || MESSAGES.user,
        retryAfterSeconds,
      })
    }
  }

  function build(name, { windowMs, limit, keyGenerator, keyType, skip, skipSuccessfulRequests = false, failOpen = true, standardHeaders = 'draft-6', storeName = typeof name === 'string' ? name : 'baseline' }) {
    return rateLimit({
      windowMs,
      limit,
      standardHeaders,                  // RateLimit-Limit / -Remaining / -Reset (exposed via CORS)
      legacyHeaders: false,
      keyGenerator,
      skip,
      skipSuccessfulRequests,
      store: storeProvider.forLimiter(storeName),
      passOnStoreError: failOpen,
      handler: handlerFor(name, windowMs, keyType),
    })
  }

  const notOptions = (req) => req.method === 'OPTIONS'

  // ── TIER 1 - baseline ───────────────────────────────────────────────────
  // One counter instance serves both identities: verified users get a per-user
  // budget, everyone else a (smaller) per-IP budget.
  const identityLimiter = build((req) => (getIdentity(req, getSecret) ? 'user' : 'ip'), {
    storeName: 'baseline',
    windowMs: windows.api,
    limit: (req) => (getIdentity(req, getSecret) ? cfg.limits.user : cfg.limits.ip),
    keyGenerator: userOrIpKey,
    keyType: keyTypeOf,
    skip: notOptions,
  })
  const companyLimiter = build('company', {
    windowMs: windows.api,
    limit: cfg.limits.company,
    keyGenerator: (req) => `c:${getIdentity(req, getSecret).companyId}`,
    keyType: () => 'company',
    skip: (req) => notOptions(req) || !getIdentity(req, getSecret),
    standardHeaders: false,             // keep the (tighter) per-user headers visible to the client
  })

  const baseline = express.Router()
  baseline.use(classify429(() => cfg.trustProxy))
  baseline.use(resolveRateLimitIdentity(getSecret))
  baseline.use(identityLimiter)
  baseline.use(companyLimiter)

  // ── TIER 2 - specialised ────────────────────────────────────────────────
  const authFail = build('auth_fail', {
    windowMs: windows.auth, limit: cfg.limits.authFail, keyGenerator: ipOnlyKey, keyType: () => 'ip',
    skipSuccessfulRequests: true,       // N staff logging in from one shop IP must not exhaust each other
    failOpen: false,                    // brute-force guard: never silently disabled by a store outage
  })
  const authRegister = build('auth_register', {
    windowMs: windows.auth, limit: cfg.limits.otpSend, keyGenerator: ipOnlyKey, keyType: () => 'ip', failOpen: false,
  })
  const otpSend = build('otp_send', {
    windowMs: windows.auth, limit: cfg.limits.otpSend, keyGenerator: ipOnlyKey, keyType: () => 'ip', failOpen: false,
  })
  const authRefresh = build('auth_refresh', {
    windowMs: windows.auth, limit: cfg.limits.refresh, keyGenerator: ipOnlyKey, keyType: () => 'ip', failOpen: false,
  })
  const authSensitive = build('auth_sensitive', {
    windowMs: windows.auth, limit: cfg.limits.sensitive, keyGenerator: userOrIpKey, keyType: keyTypeOf,
    skipSuccessfulRequests: true, failOpen: false,
  })

  const AUTH_ROUTES = [
    { method: 'POST', paths: ['/login', '/verify-otp'],                                   limiter: authFail },
    { method: 'POST', paths: ['/register'],                                               limiter: authRegister },
    { method: 'POST', paths: ['/send-otp'],                                               limiter: otpSend },
    { method: 'POST', paths: ['/refresh'],                                                limiter: authRefresh },
    { method: 'POST', paths: ['/verify-password', '/security-pin', '/add-contact', '/add-phone', '/revoke-sessions'], limiter: authSensitive },
    { method: 'PUT',  paths: ['/change-password'],                                       limiter: authSensitive },
  ]
  /** Mounted at /api/v1/auth: picks exactly one specialised limiter by method + path. */
  function authRoutes(req, res, next) {
    const path = String(req.path || '/').toLowerCase().replace(/\/+$/, '') || '/'
    const hit = AUTH_ROUTES.find(r => r.method === req.method && r.paths.includes(path))
    return hit ? hit.limiter(req, res, next) : next()
  }

  const reports = build('reports', {
    windowMs: windows.api, limit: cfg.limits.reports, keyGenerator: userOrIpKey, keyType: keyTypeOf, skip: notOptions,
  })
  const scanner = build('scanner', {
    windowMs: windows.api, limit: cfg.limits.scanner, keyGenerator: userOrIpKey, keyType: keyTypeOf, skip: notOptions,
  })
  const ocrUpload = build('ocr_upload', {
    windowMs: windows.ocr, limit: cfg.limits.ocrUpload, keyGenerator: userOrIpKey, keyType: keyTypeOf,
    skip: (req) => req.method !== 'POST',   // uploads only - the status poll (GET) is NOT limited here
  })

  const heavyOps = build('heavy_ops', {
    windowMs: windows.heavy, limit: cfg.limits.heavyOps, keyGenerator: userOrIpKey, keyType: keyTypeOf, skip: notOptions,
  })

  function describe() {
    return {
      store: storeProvider.status(),
      trustProxy: cfg.trustProxy,
      windowsMs: windows,
      limits: cfg.limits,
      legacyVarsIgnored: cfg.legacyVarsIgnored,
    }
  }

  return {
    baseline, authRoutes, reports, scanner, ocrUpload, heavyOps,
    describe, storeProvider,
    close: () => storeProvider.close(),
  }
}

module.exports = { createRateLimiters, MESSAGES }
