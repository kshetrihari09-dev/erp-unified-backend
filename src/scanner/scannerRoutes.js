/**
 * scannerRoutes.js
 *
 * Mobile Medicine Scanner — offline/LAN polling architecture.
 * No WebSockets, no Socket.IO, no internet required.
 *
 * How it works:
 *   1. Desktop calls POST /scanner/session  → gets sessionId + token
 *   2. QR code encodes http://<LAN-IP>:5000/scan?token=TOKEN&jwt=JWT
 *   3. Mobile opens that URL in browser on same WiFi
 *   4. Mobile polls GET  /scanner/session/:token/ping   → sees "waiting" or "active"
 *   5. Mobile POSTs POST /scanner/session/:token/result → selected product
 *   6. Desktop polls GET  /scanner/session/:token/poll  → gets result when ready
 *
 * Security:
 *   - Sessions use cryptographically random tokens (uuid v4, no hyphens)
 *   - Sessions expire after 10 minutes (configurable)
 *   - Each token can only be used once (consumed on first result read)
 *   - All product lookups still require the real user JWT
 *   - No new DB tables — pure in-memory Map, clears on server restart
 *
 * New endpoints (all under /api/v1/scanner):
 *   POST /scanner/session              — create session (desktop, auth required)
 *   GET  /scanner/session/:token/ping  — mobile checks session is valid (no auth)
 *   POST /scanner/session/:token/result — mobile submits selected product (no auth, validated)
 *   GET  /scanner/session/:token/poll  — desktop polls for result (auth required)
 *   DELETE /scanner/session/:token     — desktop cancels session (auth required)
 *
 *   GET  /scanner/products/barcode/:code — barcode lookup (auth required)
 *   GET  /scanner/products/fuzzy?q=...   — contains search for OCR (auth required)
 *
 * Mount in server.js:
 *   const scannerRouter = require('./scanner/scannerRoutes')
 *   app.use(`${API}/scanner`, scannerRouter)
 */

const router = require('express').Router()
const db     = require('../db/knex')
const { v4: uuid } = require('uuid')
const { authenticate } = require('../middleware/index')

// ── Config ────────────────────────────────────────────────────────────────────
const SESSION_TTL_MS   = 10 * 60 * 1000   // 10 minutes
const CLEANUP_INTERVAL = 60 * 1000         // purge expired every 60s
const MAX_SESSIONS     = 200

// ── In-memory session store ───────────────────────────────────────────────────
/**
 * Map<token, SessionRecord>
 *
 * SessionRecord {
 *   token:      string        // opaque 32-char token in QR URL
 *   companyId:  string        // from JWT of creating user
 *   context:    'sales'|'purchase'
 *   jwt:        string        // user JWT, forwarded to mobile for product API calls
 *   createdAt:  number        // epoch ms
 *   expiresAt:  number        // epoch ms
 *   status:     'waiting'|'connected'|'done'|'cancelled'
 *   result:     object|null   // set when mobile submits selection
 *   consumed:   boolean       // true after desktop reads the result
 * }
 */
const sessions = new Map()

function purgeExpired() {
  const now = Date.now()
  for (const [token, s] of sessions) {
    if (now > s.expiresAt || s.consumed) sessions.delete(token)
  }
}
setInterval(purgeExpired, CLEANUP_INTERVAL)

function createSession(companyId, context, jwt) {
  if (sessions.size >= MAX_SESSIONS) purgeExpired()
  const token = uuid().replace(/-/g, '') + uuid().replace(/-/g, '').slice(0, 8)  // 40 chars
  const record = {
    token,
    companyId,
    context: context || 'sales',
    jwt,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    status:    'waiting',
    result:    null,
    consumed:  false,
  }
  sessions.set(token, record)
  return record
}

function getSession(token) {
  const s = sessions.get(token)
  if (!s) return null
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null }
  return s
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function validateProductResult(data) {
  if (!data || typeof data !== 'object')          return 'Missing data'
  if (!data.productId || typeof data.productId !== 'string')     return 'Missing productId'
  if (!data.productName || typeof data.productName !== 'string') return 'Missing productName'
  if (!['barcode', 'ocr', 'manual'].includes(data.scanMethod))  return 'Invalid scanMethod'
  return null   // null = valid
}

async function fetchProductWithStock(productId, companyId) {
  const p = await db('products')
    .where({ id: productId, company_id: companyId, is_active: true })
    .first(
      'id', 'item_code', 'name', 'generic_name', 'company_name',
      'unit', 'sales_rate', 'mrp', 'purchase_rate', 'min_stock', 'is_active',
      db.raw('tax_rate   as vat_percent'),
      db.raw('cc_percent as cc_pct')
    )
  if (!p) return null

  const stockRow = await db('inventory_batches')
    .where({ product_id: productId, company_id: companyId })
    .sum('qty_remaining as total_stock')
    .first()

  const batches = await db('inventory_batches')
    .where({ product_id: productId, company_id: companyId })
    .where('qty_remaining', '>', 0)
    .orderBy('expiry_date', 'asc')
    .select('batch_no', 'expiry_date', db.raw('qty_remaining as qty'))
    .limit(5)

  return { ...p, current_stock: Number(stockRow?.total_stock) || 0, batches }
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION ROUTES
// ══════════════════════════════════════════════════════════════════════════════

/* ── POST /scanner/session ────────────────────────────────────────────────────
 * Desktop creates a new scanning session.
 * Returns token embedded in the QR URL.
 * ─────────────────────────────────────────────────────────────────────────── */
router.post('/session', authenticate, (req, res) => {
  const { context } = req.body   // 'sales' | 'purchase'
  // Pull raw JWT from Authorization header so we can forward it to mobile
  const jwt = req.headers.authorization?.slice(7) || ''
  const session = createSession(req.companyId, context, jwt)
  res.json({
    success: true,
    data: {
      token:     session.token,
      expiresAt: session.expiresAt,
      ttlSeconds: Math.round(SESSION_TTL_MS / 1000),
    },
  })
})

/* ── GET /scanner/session/:token/ping ────────────────────────────────────────
 * Mobile calls this to verify the session is valid before starting camera.
 * No auth required — token is the only credential.
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/session/:token/ping', (req, res) => {
  const session = getSession(req.params.token)
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found or expired' })
  }
  // Mark as connected (mobile has opened the page)
  if (session.status === 'waiting') session.status = 'connected'
  res.json({
    success: true,
    data: {
      status:    session.status,
      context:   session.context,
      expiresAt: session.expiresAt,
      // Forward the JWT to mobile so it can call product search APIs
      jwt:       session.jwt,
    },
  })
})

/* ── POST /scanner/session/:token/result ─────────────────────────────────────
 * Mobile submits the selected product.
 * No auth required — validated against companyId from session.
 * ─────────────────────────────────────────────────────────────────────────── */
router.post('/session/:token/result', async (req, res, next) => {
  try {
    const session = getSession(req.params.token)
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found or expired' })
    }
    if (session.status === 'done') {
      return res.status(409).json({ success: false, message: 'Result already submitted' })
    }

    const err = validateProductResult(req.body)
    if (err) return res.status(400).json({ success: false, message: err })

    const { productId, productName, scanMethod, barcode, ocrText } = req.body

    // Verify productId belongs to this company
    const product = await fetchProductWithStock(productId, session.companyId)
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' })
    }

    session.result = {
      product,
      scanMethod: scanMethod || 'manual',
      barcode:    barcode  || null,
      ocrText:    ocrText  || null,
      scannedAt:  Date.now(),
    }
    session.status = 'done'

    res.json({ success: true, data: { message: 'Result received. You can close this page.' } })
  } catch (err) { next(err) }
})

/* ── GET /scanner/session/:token/poll ────────────────────────────────────────
 * Desktop polls for the scan result.
 * Auth required. Returns immediately with current status.
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/session/:token/poll', authenticate, (req, res) => {
  const session = getSession(req.params.token)
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session expired' })
  }
  if (session.companyId !== req.companyId) {
    return res.status(403).json({ success: false, message: 'Forbidden' })
  }

  if (session.status !== 'done' || !session.result) {
    return res.json({ success: true, data: { status: session.status, result: null } })
  }

  // Deliver result and mark consumed
  const result = session.result
  session.consumed = true
  sessions.delete(session.token)

  res.json({ success: true, data: { status: 'done', result } })
})

/* ── DELETE /scanner/session/:token ─────────────────────────────────────────
 * Desktop cancels the session (modal closed).
 * ─────────────────────────────────────────────────────────────────────────── */
router.delete('/session/:token', authenticate, (req, res) => {
  const session = sessions.get(req.params.token)
  if (session && session.companyId === req.companyId) {
    sessions.delete(req.params.token)
  }
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT SEARCH ROUTES (used by mobile scanner)
// ══════════════════════════════════════════════════════════════════════════════

/* ── GET /scanner/products/barcode/:code ─────────────────────────────────────
 * Look up a product by barcode (item_code exact match).
 * Auth required (JWT forwarded from session).
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/products/barcode/:code', authenticate, async (req, res, next) => {
  try {
    const code = req.params.code?.trim()
    if (!code) return res.status(400).json({ success: false, message: 'Barcode required' })

    // 1. Exact match
    let product = await db('products')
      .where({ company_id: req.companyId, item_code: code, is_active: true })
      .first('id', 'item_code', 'name', 'generic_name', 'company_name', 'unit',
             'sales_rate', 'mrp', 'purchase_rate', 'min_stock', 'is_active',
             db.raw('tax_rate as vat_percent'), db.raw('cc_percent as cc_pct'))

    // 2. Case-insensitive fallback
    if (!product) {
      product = await db('products')
        .where({ company_id: req.companyId, is_active: true })
        .whereRaw('LOWER(item_code) = LOWER(?)', [code])
        .first('id', 'item_code', 'name', 'generic_name', 'company_name', 'unit',
               'sales_rate', 'mrp', 'purchase_rate', 'min_stock', 'is_active',
               db.raw('tax_rate as vat_percent'), db.raw('cc_percent as cc_pct'))
    }

    if (!product) {
      return res.status(404).json({ success: false, message: 'No product found for this barcode' })
    }

    const full = await fetchProductWithStock(product.id, req.companyId)
    res.json({ success: true, data: full })
  } catch (err) { next(err) }
})

/* ── GET /scanner/products/fuzzy?q=paracetamol&limit=10 ─────────────────────
 * Substring / contains search — for OCR fallback (searches name + generic_name).
 * Auth required (JWT forwarded from session).
 * ─────────────────────────────────────────────────────────────────────────── */
router.get('/products/fuzzy', authenticate, async (req, res, next) => {
  try {
    const raw   = (req.query.q || '').toString().trim()
    const limit = Math.min(parseInt(req.query.limit) || 15, 30)

    if (!raw || raw.length < 2) return res.json({ success: true, data: [] })

    const pattern = `%${raw.replace(/[%_]/g, c => '\\' + c)}%`

    const rows = await db('products')
      .where({ company_id: req.companyId, is_active: true })
      .where(b =>
        b.whereRaw('name         ILIKE ?', [pattern])
         .orWhereRaw('generic_name ILIKE ?', [pattern])
         .orWhereRaw('item_code    ILIKE ?', [pattern])
      )
      .orderByRaw(`
        CASE
          WHEN LOWER(name) LIKE LOWER(?) THEN 0
          WHEN LOWER(generic_name) LIKE LOWER(?) THEN 1
          ELSE 2
        END, name ASC
      `, [`${raw}%`, `${raw}%`])
      .limit(limit)
      .select('id', 'item_code', 'name', 'generic_name', 'company_name', 'unit',
              'sales_rate', 'mrp', 'purchase_rate', 'min_stock', 'is_active',
              db.raw('tax_rate as vat_percent'), db.raw('cc_percent as cc_pct'))

    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

// ══════════════════════════════════════════════════════════════════════════════
// NETWORK INFO (used by desktop to build QR URL with LAN IP)
// ══════════════════════════════════════════════════════════════════════════════

/* ── GET /scanner/network-info ───────────────────────────────────────────────
 * Returns the server's LAN IP address so the desktop can build a QR URL
 * that is reachable from a mobile phone on the same WiFi network.
 *
 * Walks os.networkInterfaces() and returns the first non-loopback IPv4
 * address on a private range (192.168.x.x / 10.x.x.x / 172.16-31.x.x).
 * Falls back to '127.0.0.1' with a `lanDetected: false` flag so the
 * frontend can warn the user that the QR code may not be reachable.
 *
 * Auth required — only authenticated ERP users need this.
 * ─────────────────────────────────────────────────────────────────────────── */
const os = require('os')

function detectLanIp() {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
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

router.get('/network-info', authenticate, (req, res) => {
  const { ip, lanDetected } = detectLanIp()
  const port = parseInt(process.env.PORT || '5000', 10)
  res.json({
    success: true,
    data: { ip, port, lanDetected },
  })
})

module.exports = router
