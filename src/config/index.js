/**
 * src/config/index.js
 *
 * Single source of truth for all server configuration.
 *
 * Loads environment variables (already populated by dotenv in server.js),
 * validates required values, and exports a typed config object.
 * Every module imports from here — never from process.env directly.
 *
 * Usage:
 *   const config = require('../config')
 *   config.jwt.secret
 *   config.db.url
 *   config.security.bcryptRounds
 */

'use strict'

const os = require('os')

// ── Helpers ───────────────────────────────────────────────────────────────────

function required(key) {
  const value = process.env[key]
  if (!value) {
    console.error(`[Config] FATAL: required env var "${key}" is not set.`)
    process.exit(1)
  }
  return value
}

function optional(key, defaultValue) {
  return process.env[key] !== undefined ? process.env[key] : defaultValue
}

function optionalInt(key, defaultValue) {
  const v = process.env[key]
  if (v === undefined || v === '') return defaultValue
  const n = parseInt(v, 10)
  if (isNaN(n)) return defaultValue
  return n
}

function optionalBool(key, defaultValue = false) {
  const v = process.env[key]
  if (v === undefined || v === '') return defaultValue
  return v === 'true' || v === '1'
}

// ── Environment detection ─────────────────────────────────────────────────────

const NODE_ENV = optional('NODE_ENV', 'development')
const isDev    = NODE_ENV === 'development'
const isStaging= NODE_ENV === 'staging'
const isProd   = NODE_ENV === 'production'

// ── LAN IP detection (for scanner QR URLs) ───────────────────────────────────

function detectLanIp() {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of (ifaces[name] || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      const ip = iface.address
      if (
        /^192\.168\./.test(ip) ||
        /^10\./.test(ip) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      ) {
        return { ip, lanDetected: true }
      }
    }
  }
  return { ip: '127.0.0.1', lanDetected: false }
}

// ── Config object ─────────────────────────────────────────────────────────────

const config = {
  env: NODE_ENV,
  isDev,
  isStaging,
  isProd,

  server: {
    port:  optionalInt('PORT', 5000),
    https: optionalBool('HTTPS', false),
    sslKeyPath:  optional('SSL_KEY_PATH', './certs/localhost-key.pem'),
    sslCertPath: optional('SSL_CERT_PATH', './certs/localhost.pem'),
    lan:   detectLanIp(),
  },

  db: {
    // Prefer DATABASE_URL (Render/Railway) over individual vars
    url: optional('DATABASE_URL', null),
    host:     optional('DB_HOST', 'localhost'),
    port:     optionalInt('DB_PORT', 5432),
    name:     optional('DB_NAME', 'erp_unified_backend'),
    user:     optional('DB_USER', 'postgres'),
    password: optional('DB_PASSWORD', ''),
  },

  jwt: {
    // In prod/staging these are required — crash fast if missing
    secret:         isProd || isStaging
                      ? required('JWT_SECRET')
                      : optional('JWT_SECRET', 'dev_jwt_secret_not_for_production'),
    refreshSecret:  isProd || isStaging
                      ? required('JWT_REFRESH_SECRET')
                      : optional('JWT_REFRESH_SECRET', 'dev_refresh_secret_not_for_production'),
    expiresIn:      optional('JWT_EXPIRES_IN', isDev ? '8h' : '2h'),
    refreshExpires: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  cors: {
    // Comma-separated list from CORS_ORIGIN env var (set in production).
    // Default covers both http and https for the two common dev ports so that
    // Vite (5173) and CRA/Next (3000) work whether the dev server uses a
    // self-signed cert (https) or plain http.
    origins: (optional(
      'CORS_ORIGIN',
      'http://localhost:3000,https://localhost:3000,' +
      'http://localhost:5173,https://localhost:5173'
    ))
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  security: {
    bcryptRounds:          optionalInt('BCRYPT_ROUNDS',         isDev ? 10 : 14),
    rateLimitWindowMs:     optionalInt('RATE_LIMIT_WINDOW_MS',  15 * 60 * 1000),
    rateLimitMax:          optionalInt('RATE_LIMIT_MAX',         isDev ? 500 : 100),
    authRateLimitMax:      optionalInt('AUTH_RATE_LIMIT_MAX',    isDev ?  50 :  10),
    scannerRateLimitMax:   optionalInt('SCANNER_RATE_LIMIT_MAX', isDev ? 300 : 100),
    sessionTtlMinutes:     optionalInt('SESSION_TTL_MINUTES', 10),
  },

  logging: {
    level:        optional('LOG_LEVEL', isDev ? 'debug' : 'warn'),
    morganFormat: optional('MORGAN_FORMAT', isDev ? 'dev' : 'combined'),
  },
}

module.exports = config
