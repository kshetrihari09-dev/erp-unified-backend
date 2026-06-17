/**
 * src/middleware/security.js
 *
 * Production-grade security middleware stack.
 * Imported and applied in server.js BEFORE route registration.
 *
 * Covers:
 *  1. express-rate-limit   — per-IP throttling with env-tunable limits
 *  2. HTTPS redirect       — 301 redirect for HTTP→HTTPS in production
 *  3. Security headers     — helmet + manual additions (CSP, HSTS, etc.)
 *  4. Request ID           — trace-id on every request for log correlation
 *
 * install once:  npm install express-rate-limit
 */

'use strict'

const { v4: uuid } = require('uuid')
const config       = require('../config')

// ── 1. Rate limiters ──────────────────────────────────────────────────────────

let rateLimit
try {
  rateLimit = require('express-rate-limit')
} catch {
  console.warn('[Security] express-rate-limit not installed. Run: npm install express-rate-limit')
  // Provide a no-op middleware so the app still starts without the package
  rateLimit = () => (_req, _res, next) => next()
}

/**
 * generalLimiter — applied to all /api/v1/* routes.
 * Generous limit; protects against hammering but won't block normal usage.
 */
const generalLimiter = rateLimit({
  windowMs:         config.security.rateLimitWindowMs,
  max:              config.security.rateLimitMax,
  standardHeaders:  true,   // Return rate-limit info in RateLimit-* headers
  legacyHeaders:    false,   // Disable deprecated X-RateLimit-* headers
  keyGenerator:     (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
  handler: (_req, res) => res.status(429).json({
    success: false,
    message: 'Too many requests. Please wait and try again.',
  }),
})

/**
 * authLimiter — tighter limit on login/register/OTP routes.
 * Prevents credential stuffing and OTP brute-force.
 */
const authLimiter = rateLimit({
  windowMs:        config.security.rateLimitWindowMs,
  max:             config.security.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.ip || 'unknown',
  handler: (_req, res) => res.status(429).json({
    success: false,
    message: 'Too many authentication attempts. Please wait 15 minutes.',
  }),
})

/**
 * scannerLimiter — for mobile scanner poll endpoints.
 * Phones poll every 2s; allow headroom for multiple simultaneous sessions.
 */
const scannerLimiter = rateLimit({
  windowMs:        config.security.rateLimitWindowMs,
  max:             config.security.scannerRateLimitMax,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.ip || 'unknown',
  handler: (_req, res) => res.status(429).json({
    success: false,
    message: 'Scanner poll rate limit exceeded.',
  }),
})

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
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "'unsafe-inline'"],   // Vite inlines scripts in dev
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
  generalLimiter,
  authLimiter,
  scannerLimiter,
  httpsRedirect,
  helmetConfig,
  extraSecurityHeaders,
  requestId,
}
