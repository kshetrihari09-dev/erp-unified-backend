/**
 * server.js — MediERP Unified Backend (Security Upgrade)
 *
 * What changed from the previous version:
 *
 *  1. Config centralised — all env vars read from src/config/index.js
 *  2. Security middleware — rate limiting, HTTPS redirect, security headers,
 *     request ID (src/middleware/security.js)
 *  3. HTTPS support — optionally runs an https.Server in dev for camera testing
 *  4. Trust proxy — required for x-forwarded-proto and x-forwarded-for behind
 *     Nginx / Render / Railway
 *  5. No-cache middleware — still present, prevents 304 on scanner poll
 *  6. Auth routes get a tighter rate limiter (authLimiter)
 *  7. Scanner routes get a dedicated rate limiter (scannerLimiter)
 *  8. Graceful shutdown — SIGTERM/SIGINT handlers close DB pool cleanly
 *
 * Everything else (routes, DB, CORS logic, scanner) is unchanged.
 */

'use strict'

// ── Load env vars before anything else ───────────────────────────────────────
// In development: loads .env
// In staging/prod: platform injects env vars directly; dotenv is a no-op.
require('dotenv').config({ path: '.env' })
require('dotenv').config({ path: '.env.local', override: true })

const express   = require('express')
const cors      = require('cors')
const morgan    = require('morgan')
const path      = require('path')
const fs        = require('fs')
const http      = require('http')
const https     = require('https')

const config    = require('./config')
const {
  generalLimiter,
  authLimiter,
  scannerLimiter,
  httpsRedirect,
  helmetConfig,
  extraSecurityHeaders,
  requestId,
} = require('./middleware/security')

// ── Route modules (UNCHANGED) ─────────────────────────────────────────────────
const authRouter       = require('./routes/auth')
const productsRouter   = require('./routes/products')
const partiesRouter    = require('./routes/parties')
const salesRouter      = require('./routes/sales')
const purchasesRouter  = require('./routes/purchases')
const accountingRouter = require('./routes/accounting')
const reportsRouter    = require('./routes/reports')
const settingsRouter   = require('./routes/settings')
const receivesRouter   = require('./routes/receives')
const stockRouter      = require('./routes/stock')
const returnsRouter    = require('./routes/returns')
const scannerRouter    = require('./scanner/scannerRoutes')

const { errorHandler } = require('./middleware/index')
const db = require('./db/knex')

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express()

// Trust the first reverse proxy (Nginx, Render, Railway).
// Required for:
//   - req.ip to return the real client IP (not the proxy IP)
//   - x-forwarded-proto to work for HTTPS detection
//   - express-rate-limit to rate-limit by real client IP
app.set('trust proxy', 1)

// Disable ETag globally — prevents 304 Not Modified on scanner poll
app.set('etag', false)

// ── 1. Request ID (first — all subsequent middleware can log it) ──────────────
app.use(requestId)

// ── 2. Logging ────────────────────────────────────────────────────────────────
app.use(morgan(config.logging.morganFormat))

// ── 3. HTTPS redirect (no-op in dev; 301 redirect in prod) ───────────────────
app.use(httpsRedirect)

// ── 4. Security headers ───────────────────────────────────────────────────────
app.use(helmetConfig())
app.use(extraSecurityHeaders)

// ── 5. CORS ───────────────────────────────────────────────────────────────────────────────
//
// Origin resolution order:
//   1. No Origin header (server-to-server, curl, Postman)  → allow
//   2. Explicitly listed in config.cors.origins            → allow
//   3. Render / Vercel deploy preview domains              → allow
//   4. LAN IPs in dev (mobile scanner on same WiFi)        → allow
//   5. Everything else                                     → 403 (not 500)
//
// Previously callback(new Error(...)) caused Express's error handler to
// return 500. We now handle the rejection inline with res.status(403).json()
// so blocked origins get a proper 403 and the error middleware is not involved.
//
app.use((req, res, next) => {
  const origin = req.headers.origin

  function isAllowed(o) {
    if (!o) return true                               // no Origin → allow (server-to-server)
    if (config.cors.origins.includes(o)) return true // explicit allow-list
    if (o.endsWith('.onrender.com')) return true    // Render deploy previews
    if (o.endsWith('.vercel.app'))   return true    // Vercel deploy previews

    // LAN IPs — dev only (mobile phones / tablets on the same WiFi)
    if (!config.isProd) {
      try {
        const { hostname } = new URL(o)
        if (
          /^192\.168\./.test(hostname) ||
          /^10\./.test(hostname) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
        ) return true
      } catch { /* URL parse failed — fall through */ }
    }

    return false
  }

  if (!isAllowed(origin)) {
    console.warn(`[CORS] Blocked origin: ${origin}`)
    // Return 403 with JSON body — do NOT call next(err) which would cause 500
    res.status(403).json({ success: false, message: `CORS: origin ${origin} not allowed` })
    return
  }

  // Origin is allowed — delegate to the cors package for correct header injection
  cors({
    origin: true,           // reflect the matched origin back
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
  })(req, res, next)
})

// ── 6. Body parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ── 7. No-cache (belt-and-suspenders; etag:false above handles most cases) ────
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// ── 8. Static uploads ─────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  // Add security headers to uploaded file responses
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  },
}))

// ── 9. Health check (no rate limit — monitoring tools call this frequently) ───
app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1')
    res.json({
      status:   'ok',
      db:       'connected',
      version:  '2.2.0',
      env:      config.env,
      time:     new Date().toISOString(),
      name:     'MediERP Unified Backend',
      https:    config.server.https,
      lan:      config.server.lan,
    })
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message })
  }
})

// ── 10. API routes ────────────────────────────────────────────────────────────
const API = '/api/v1'

// Apply general rate limit to all API routes
app.use(API, generalLimiter)

// Auth — tighter limit on login/register/OTP
app.use(`${API}/auth`,       authLimiter, authRouter)

// Pharma ERP (UNCHANGED)
app.use(`${API}/products`,   productsRouter)
app.use(`${API}/parties`,    partiesRouter)
app.use(`${API}/sales`,      salesRouter)
app.use(`${API}/purchases`,  purchasesRouter)
app.use(`${API}/receives`,   receivesRouter)
app.use(`${API}/stock`,      stockRouter)
app.use(`${API}/returns`,    returnsRouter)
app.use(`${API}/settings`,   settingsRouter)

// Accounting Engine (UNCHANGED)
app.use(`${API}/accounting`, accountingRouter)

// Reports (UNCHANGED)
app.use(`${API}/reports`,    reportsRouter)

// Scanner — dedicated rate limit for polling
app.use(`${API}/scanner`,    scannerLimiter, scannerRouter)

// Date utilities (UNCHANGED)
app.get(`${API}/date/today`, (req, res) => {
  const { todayBS } = require('./utils/helpers')
  const today = new Date().toISOString().split('T')[0]
  res.json({ success: true, data: { ad: today, bs: todayBS() } })
})
app.get(`${API}/date/ad-to-bs`, (req, res) => {
  const { adToBS } = require('./utils/helpers')
  const { date } = req.query
  if (!date) return res.status(400).json({ success: false, message: 'date query param required' })
  res.json({ success: true, data: { ad: date, bs: adToBS(date) } })
})

// ── 11. 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  })
})

// ── 12. Global error handler ──────────────────────────────────────────────────
app.use(errorHandler)

// ── 13. Server creation (HTTP or HTTPS) ──────────────────────────────────────
function createServer() {
  if (config.server.https) {
    // Self-signed HTTPS in dev — required for getUserMedia (camera) on Chrome
    // Generate certs with: mkcert localhost 127.0.0.1 192.168.1.x
    // Install mkcert root CA once with: mkcert -install
    try {
      const key  = fs.readFileSync(config.server.sslKeyPath)
      const cert = fs.readFileSync(config.server.sslCertPath)
      return https.createServer({ key, cert }, app)
    } catch (err) {
      console.error(`[HTTPS] Could not read cert files: ${err.message}`)
      console.error('[HTTPS] Falling back to HTTP. Run: mkcert localhost 127.0.0.1 <your-lan-ip>')
      console.error('[HTTPS] Then set SSL_KEY_PATH and SSL_CERT_PATH in .env.development')
    }
  }
  return http.createServer(app)
}

// ── 14. Start ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await db.raw('SELECT 1')
    console.log('✅ PostgreSQL connected')

    const server = createServer()
    const PORT   = config.server.port
    const proto  = config.server.https ? 'https' : 'http'

    server.listen(PORT, '0.0.0.0', () => {
      const { ip, lanDetected } = config.server.lan
      console.log(`\n🏦 MediERP Unified Backend v2.2 [${config.env}]`)
      console.log(`   API:    ${proto}://localhost:${PORT}/api/v1`)
      if (lanDetected) {
        console.log(`   LAN:    ${proto}://${ip}:${PORT}/api/v1  ← mobile uses this`)
      } else {
        console.log(`   LAN:    (no LAN IP detected — are you on WiFi?)`)
      }
      console.log(`   Health: ${proto}://localhost:${PORT}/health`)
      console.log(`   HTTPS:  ${config.server.https ? '✓ enabled' : '✗ disabled (HTTP)'}`)
      console.log(`   Env:    ${config.env}\n`)
    })

    // ── Graceful shutdown ──────────────────────────────────────────────────
    async function shutdown(signal) {
      console.log(`\n[Shutdown] ${signal} received. Closing gracefully…`)
      server.close(async () => {
        try {
          await db.destroy()
          console.log('[Shutdown] DB pool closed. Bye.')
        } catch {
          // ignore
        }
        process.exit(0)
      })
      // Force exit after 10s if connections don't drain
      setTimeout(() => process.exit(1), 10_000)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT',  () => shutdown('SIGINT'))

  } catch (err) {
    console.error('❌ Failed to connect to PostgreSQL:', err.message)
    process.exit(1)
  }
}

start()
module.exports = app
