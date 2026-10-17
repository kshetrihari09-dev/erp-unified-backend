/**
 * src/middleware/security.js
 *
 * Production-grade security middleware stack.
 * Imported and applied in server.js BEFORE route registration.
 *
 * Covers:
 *  1. Rate limiting       — per-user / per-company / per-IP, env-tunable (see ./rateLimit)
 *  2. HTTPS redirect       — 301 redirect for HTTP→HTTPS in production
 *  3. Security headers     — helmet + manual additions (CSP, HSTS, etc.)
 *  4. Request ID           — trace-id on every request for log correlation
 *
 */

'use strict'

const { v4: uuid } = require('uuid')
const config       = require('../config')

// ── 1. Rate limiters ──────────────────────────────────────────────────────────
// All limiter definitions, keys, budgets and their documented responsibilities
// live in ./rateLimit/index.js (see the table at the top of that file) and are
// configured by validated env vars in config/rateLimitConfig.js.
//
//   generalLimiter  - TIER 1 baseline for every /api/v1 request: per verified user,
//                     per verified company, per IP for unauthenticated traffic.
//   authLimiter     - picks ONE credential/sensitive limiter by method + path.
//   reportsLimiter  - heavy aggregate SQL (/reports, /stock-register).
//   scannerLimiter  - barcode / fuzzy product lookups.
//   ocrLimiter      - Scan-Purchase-Bill UPLOADS only (not the status poll).
const { createRateLimiters } = require('./rateLimit')

const rateLimiters = createRateLimiters(config.rateLimit)

const generalLimiter = rateLimiters.baseline
const authLimiter    = rateLimiters.authRoutes
const scannerLimiter = rateLimiters.scanner
const reportsLimiter = rateLimiters.reports
const ocrLimiter     = rateLimiters.ocrUpload
const heavyOpsLimiter = rateLimiters.heavyOps

// ── 2. HTTPS redirect ─────────────────────────────────────────────────────────

/**
 * Redirects HTTP → HTTPS in production.
 * In development this middleware is a transparent pass-through.
 *
 * Works behind a reverse proxy (Nginx, Render, Railway) that sets
 * x-forwarded-proto. Trust the proxy header in server.js:
 *   app.set('trust proxy', 1)
 */
function httpsRedirect(req, res, next) {
  if (!config.isProd) return next()

  const proto = req.headers['x-forwarded-proto'] || req.protocol
  if (proto !== 'https') {
    const host = req.headers['x-forwarded-host'] || req.headers.host
    return res.redirect(301, `https://${host}${req.originalUrl}`)
  }
  next()
}

// ── 3. Security headers ───────────────────────────────────────────────────────

/**
 * Returns a helmet configuration tuned for this ERP app.
 * Call: app.use(helmetConfig())
 *
 * CSP is intentionally permissive for:
 *  - blob: (camera streams via getUserMedia → canvas → blob URL)
 *  - data: (QR code rendered as data URI)
 *  - 'unsafe-inline' styles (Tailwind CSS)
 * Tighten these in a future audit once a nonce-based approach is implemented.
 */
function helmetConfig() {
  let helmet
  try { helmet = require('helmet') } catch {
    console.warn('[Security] helmet not installed.')
    return (_req, _res, next) => next()
  }

  // Build allowed API origins for connect-src
  const apiOrigins = config.cors.origins.join(' ')

  return helmet({
    // Cross-Origin Resource Policy — allow images/fonts cross-origin (needed for uploads)
    crossOriginResourcePolicy: { policy: 'cross-origin' },

    // Content Security Policy
    // scriptSrc drops 'unsafe-inline' in production: this API server
    // itself renders no HTML with inline scripts, so there is nothing
    // that depends on it there. Kept in dev because the app is normally
    // developed against the separately-hosted Vite dev server (which
    // injects an inline HMR client script) proxying through here.
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      config.isProd ? ["'self'"] : ["'self'", "'unsafe-inline'"],
        styleSrc:       ["'self'", "'unsafe-inline'"],   // Tailwind
        imgSrc:         ["'self'", 'data:', 'blob:'],    // QR codes (data:), camera (blob:)
        mediaSrc:       ["'self'", 'blob:'],             // Camera stream
        connectSrc:     ["'self'", apiOrigins, 'blob:'],
        fontSrc:        ["'self'", 'data:'],
        objectSrc:      ["'none'"],
        frameSrc:       ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
      // In dev, report-only so CSP violations are logged but don't block
      reportOnly: config.isDev,
    },

    // HTTP Strict Transport Security (only in prod — not useful over HTTP in dev)
    hsts: config.isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,

    // Prevent clickjacking
    frameguard: { action: 'deny' },

    // Don't send Referrer on cross-origin requests
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // Disable X-Powered-By: Express
    hidePoweredBy: true,

    // Prevent MIME sniffing
    noSniff: true,

    // XSS filter header (legacy, still useful for older browsers)
    xssFilter: true,
  })
}

/**
 * Extra security headers not covered by helmet.
 * Applied after helmet so they can't be overridden.
 */
function extraSecurityHeaders(req, res, next) {
  // Permissions Policy — restrict browser features
  res.setHeader('Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), payment=()'
  )
  // Cross-Origin Opener Policy — isolate window.opener
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  // Cross-Origin Embedder Policy — required for SharedArrayBuffer (future use)
  // Disabled for now — breaks loading third-party iframes if any are added later
  // res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')

  next()
}

// ── 4. Request ID ─────────────────────────────────────────────────────────────

/**
 * Attaches a unique request ID to every request.
 * Useful for correlating logs across the request lifecycle.
 * The ID is also echoed in the response header.
 */
function requestId(req, res, next) {
  const id = uuid()
  req.id = id
  res.setHeader('X-Request-Id', id)
  next()
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  rateLimiters,
  generalLimiter,
  authLimiter,
  scannerLimiter,
  reportsLimiter,
  ocrLimiter,
  heavyOpsLimiter,
  httpsRedirect,
  helmetConfig,
  extraSecurityHeaders,
  requestId,
}
