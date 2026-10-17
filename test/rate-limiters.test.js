/**
 * Behavioural tests for the rate-limiting stack, exercised through real Express +
 * supertest. The app below mounts the limiters in the SAME arrangement as server.js
 * (verified separately by rate-limit-wiring.test.js) with tiny budgets so thresholds
 * can be crossed quickly.
 */
'use strict'
const express = require('express')
const request = require('supertest')
const jwt = require('jsonwebtoken')

const { loadRateLimitConfig } = require('../src/config/rateLimitConfig')
const { createRateLimiters } = require('../src/middleware/rateLimit')
const diag = require('../src/middleware/rateLimit/diagnostics')

const SECRET = 'rate-limit-test-secret'
const token = (userId, companyId = 'co-1', secret = SECRET, opts = { expiresIn: '1h' }) =>
  jwt.sign({ userId, companyId, role: 'owner' }, secret, opts)
const auth = (userId, companyId) => ({ Authorization: `Bearer ${token(userId, companyId)}` })

const SMALL = {
  RATE_LIMIT_USER_MAX: '5', RATE_LIMIT_COMPANY_MAX: '8', RATE_LIMIT_IP_MAX: '3',
  RATE_LIMIT_AUTH_FAIL_MAX: '3', RATE_LIMIT_OTP_SEND_MAX: '2', RATE_LIMIT_REFRESH_MAX: '3',
  RATE_LIMIT_SENSITIVE_MAX: '2', RATE_LIMIT_REPORTS_MAX: '4', RATE_LIMIT_SCANNER_MAX: '3',
  RATE_LIMIT_OCR_UPLOAD_MAX: '2', RATE_LIMIT_HEAVY_OPS_MAX: '2',
}
// Many tests only care about ONE tier, so lift the baseline out of the way.
const HIGH_BASELINE = { RATE_LIMIT_USER_MAX: '1000', RATE_LIMIT_COMPANY_MAX: '5000', RATE_LIMIT_IP_MAX: '1000' }

let toClose = []
afterEach(async () => { for (const c of toClose) await c(); toClose = []; diag.resetCounters(); diag.setLogSink(null) })

/** Builds an app wired like server.js. */
function makeApp(env = {}, { isProd = true } = {}) {
  const cfg = loadRateLimitConfig({ ...SMALL, ...env }, { isProd })
  const rl = createRateLimiters(cfg, { logger: { warn() {}, error() {} }, getSecret: () => SECRET })
  toClose.push(() => rl.close())
  const app = express()
  app.set('trust proxy', cfg.trustProxy)
  app.use((req, _res, next) => { req.id = 'req-' + Math.random().toString(36).slice(2, 8); next() })
  app.use(express.json())
  const API = '/api/v1'

  app.use(API, rl.baseline)
  app.use([`${API}/reports`, `${API}/stock-register`], rl.reports)
  app.post(`${API}/settings/backup/run`, rl.heavyOps)
  app.get(`${API}/settings/backup/:id/download`, rl.heavyOps)

  const authR = express.Router()
  authR.post('/login', (req, res) => (req.body.password === 'ok' ? res.json({ success: true }) : res.status(401).json({ success: false })))
  authR.post('/verify-otp', (req, res) => (req.body.otp === '1234' ? res.json({ success: true }) : res.status(400).json({ success: false })))
  authR.post('/register', (_q, res) => res.status(201).json({ success: true }))
  authR.post('/send-otp', (_q, res) => res.json({ success: true }))
  authR.post('/refresh', (_q, res) => res.json({ success: true }))
  authR.post('/verify-password', (req, res) => (req.body.password === 'ok' ? res.json({ success: true }) : res.status(401).json({ success: false })))
  authR.put('/change-password', (_q, res) => res.json({ success: true }))
  authR.get('/me', (_q, res) => res.json({ success: true }))
  app.use(`${API}/auth`, rl.authRoutes, authR)

  app.post(`${API}/purchase-scans`, rl.ocrUpload, (_q, res) => res.status(201).json({ success: true }))
  app.get(`${API}/purchase-scans/:id`, rl.ocrUpload, (_q, res) => res.json({ success: true, status: 'processing' }))
  app.use(`${API}/scanner`, rl.scanner, (_q, res) => res.json({ success: true }))
  app.use(`${API}/reports/company-vs-customer`, (_q, res) => res.json({ ok: true }))
  app.get(`${API}/reports/:name`, (_q, res) => res.json({ ok: true }))
  app.get(`${API}/stock-register`, (_q, res) => res.json({ ok: true }))
  app.post(`${API}/settings/backup/run`, (_q, res) => res.json({ ok: true }))
  app.get(`${API}/settings/backup/:id/download`, (_q, res) => res.json({ ok: true }))
  app.get(`${API}/products`, (_q, res) => res.json({ ok: true }))
  app.options(`${API}/products`, (_q, res) => res.sendStatus(204))
  app.get(`${API}/notifications`, (_q, res) => res.json({ ok: true }))
  app.get(`${API}/app-429`, (_q, res) => res.status(429).json({ success: false, code: 'PIN_LOCKED', message: 'locked' }))
  return { app, rl, cfg }
}

const statuses = (rs) => rs.map(r => r.status)

// ═══════════════════════════════════════════════════════════════════════════
describe('tier 1 baseline: below / above threshold + 429 shape', () => {
  it('allows exactly `user` requests per window then answers 429 with consistent headers and body', async () => {
    const { app } = makeApp()
    const h = auth('alice')
    for (let i = 0; i < 5; i++) expect((await request(app).get('/api/v1/products').set(h)).status).toBe(200)

    const res = await request(app).get('/api/v1/products').set(h)
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers['retry-after'])
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(res.headers['x-ratelimit-limiter']).toBe('user')
    expect(res.headers['x-ratelimit-source']).toBe('app-limiter')
    expect(res.headers['ratelimit-limit']).toBe('5')
    expect(res.headers['ratelimit-remaining']).toBe('0')
    expect(res.body).toEqual({
      success: false, code: 'RATE_LIMITED', limiter: 'user',
      message: 'Too many requests. Please wait and try again.', retryAfterSeconds: retryAfter,
    })
  })

  it('Retry-After shrinks as the window elapses and requests succeed again after the reset', async () => {
    const { app } = makeApp({ RATE_LIMIT_API_WINDOW_MS: '1500' })
    const h = auth('bob')
    for (let i = 0; i < 5; i++) await request(app).get('/api/v1/products').set(h)
    const blocked = await request(app).get('/api/v1/products').set(h)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(2)
    await new Promise(r => setTimeout(r, 1700))
    expect((await request(app).get('/api/v1/products').set(h)).status).toBe(200)
  })

  it('does not count CORS preflight (OPTIONS) requests', async () => {
    const { app } = makeApp()
    const h = auth('carol')
    for (let i = 0; i < 20; i++) expect((await request(app).options('/api/v1/products').set(h)).status).toBe(204)
    for (let i = 0; i < 5; i++) expect((await request(app).get('/api/v1/products').set(h)).status).toBe(200)
  })
})

describe('tier 1 baseline: separate buckets per user / company / ip', () => {
  it('two users sharing one IP get independent per-user buckets', async () => {
    const { app } = makeApp(HIGH_BASELINE && { RATE_LIMIT_COMPANY_MAX: '1000' })
    const ip = { 'X-Forwarded-For': '203.0.113.7' }
    for (let i = 0; i < 5; i++) await request(app).get('/api/v1/products').set({ ...auth('alice'), ...ip })
    expect((await request(app).get('/api/v1/products').set({ ...auth('alice'), ...ip })).status).toBe(429)
    // same IP, different person: unaffected
    expect((await request(app).get('/api/v1/products').set({ ...auth('dave'), ...ip })).status).toBe(200)
  })

  it('the company bucket aggregates all of a tenant\'s staff (limiter reported as "company")', async () => {
    const { app } = makeApp()                        // user=5, company=8
    const res = []
    for (const u of ['u1', 'u2', 'u3']) for (let i = 0; i < 3; i++) res.push(await request(app).get('/api/v1/products').set(auth(u, 'co-A')))
    expect(statuses(res).slice(0, 8)).toEqual(Array(8).fill(200))
    expect(res[8].status).toBe(429)
    expect(res[8].headers['x-ratelimit-limiter']).toBe('company')
    // ...but a different company on the same IP is untouched
    expect((await request(app).get('/api/v1/products').set(auth('u9', 'co-B'))).status).toBe(200)
  })

  it('unauthenticated traffic is limited per IP with the smaller `ip` budget', async () => {
    const { app } = makeApp()
    for (let i = 0; i < 3; i++) expect((await request(app).get('/api/v1/notifications').set('X-Forwarded-For', '198.51.100.1')).status).toBe(200)
    const blocked = await request(app).get('/api/v1/notifications').set('X-Forwarded-For', '198.51.100.1')
    expect(blocked.status).toBe(429)
    expect(blocked.headers['x-ratelimit-limiter']).toBe('ip')
    expect((await request(app).get('/api/v1/notifications').set('X-Forwarded-For', '198.51.100.2')).status).toBe(200)
  })
})

describe('identity cannot be spoofed to choose or escape a bucket', () => {
  it('forged / wrong-secret / expired tokens fall back to the per-IP bucket', async () => {
    const { app } = makeApp()
    const ip = { 'X-Forwarded-For': '192.0.2.50' }
    const forged = () => ({ Authorization: `Bearer ${token('different-user-each-time-' + Math.random(), 'co-1', 'attacker-secret')}` })
    const expired = { Authorization: `Bearer ${token('eve', 'co-1', SECRET, { expiresIn: -60 })}` }
    const rs = []
    for (let i = 0; i < 3; i++) rs.push(await request(app).get('/api/v1/products').set({ ...forged(), ...ip }))
    expect(statuses(rs)).toEqual([200, 200, 200])
    // a 4th attempt - with a freshly forged identity - is STILL the same IP bucket (limit 3), not a new user bucket
    const r4 = await request(app).get('/api/v1/products').set({ ...forged(), ...ip })
    expect(r4.status).toBe(429)
    expect(r4.headers['x-ratelimit-limiter']).toBe('ip')
    expect((await request(app).get('/api/v1/products').set({ ...expired, ...ip })).status).toBe(429)
  })

  it('X-User-Id / X-Company-Id headers, query and body are ignored', async () => {
    const { app } = makeApp()
    const ip = { 'X-Forwarded-For': '192.0.2.77' }
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get('/api/v1/products?userId=v1' + i).set({ ...ip, 'X-User-Id': 'v' + i, 'X-Company-Id': 'c' + i })
      expect(r.status).toBe(200)
    }
    expect((await request(app).get('/api/v1/products').set({ ...ip, 'X-User-Id': 'brand-new' })).status).toBe(429)
  })
})

describe('reverse proxy / X-Forwarded-For handling', () => {
  const unauth = (app, xff) => request(app).get('/api/v1/notifications').set('X-Forwarded-For', xff)

  it('trust proxy = 1: client-prepended X-Forwarded-For entries are ignored (rightmost wins)', async () => {
    const { app } = makeApp({ TRUST_PROXY: '1' })
    const rs = []
    for (let i = 1; i <= 4; i++) rs.push(await unauth(app, `10.${i}.${i}.${i}, 7.7.7.7`))   // attacker rotates the LEFT entry
    expect(statuses(rs)).toEqual([200, 200, 200, 429])
  })

  it('trust proxy = 1: different proxy-appended (real client) IPs are separate buckets', async () => {
    const { app } = makeApp({ TRUST_PROXY: '1' })
    for (let i = 0; i < 3; i++) await unauth(app, '1.1.1.1')
    expect((await unauth(app, '1.1.1.1')).status).toBe(429)
    expect((await unauth(app, '2.2.2.2')).status).toBe(200)
  })

  it('trust proxy = 2 (CDN + nginx): second entry from the right is the client', async () => {
    const { app } = makeApp({ TRUST_PROXY: '2' })
    const rs = []
    for (let i = 1; i <= 4; i++) rs.push(await unauth(app, `99.${i}.0.1, 5.5.5.5, 172.16.0.9`))
    expect(statuses(rs)).toEqual([200, 200, 200, 429])
  })

  it('trust proxy = false: X-Forwarded-For is ignored entirely (socket address used)', async () => {
    const { app } = makeApp({ TRUST_PROXY: 'false' })
    const rs = []
    for (let i = 1; i <= 4; i++) rs.push(await unauth(app, `8.8.8.${i}`))                    // all "different" IPs, one socket
    expect(statuses(rs)).toEqual([200, 200, 200, 429])
  })

  it('IPv6 clients are bucketed by /64 so one host cannot rotate through addresses', async () => {
    const { app } = makeApp({ TRUST_PROXY: '1' })
    const rs = []
    for (let i = 1; i <= 4; i++) rs.push(await unauth(app, `2001:db8:abcd:12:0:0:0:${i}`))
    expect(statuses(rs)).toEqual([200, 200, 200, 429])
    expect((await unauth(app, '2001:db8:abcd:13::1')).status).toBe(200)                       // another /64
  })
})

describe('tier 2: authentication & OTP protection', () => {
  const post = (app, path, body, headers = {}) => request(app).post('/api/v1/auth' + path).set(headers).send(body)

  it('failed logins from one IP are capped (3) and the 4th gets 429 with the auth_fail limiter + Retry-After', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.20' }
    for (let i = 0; i < 3; i++) expect((await post(app, '/login', { email: 'a@x.com', password: 'bad' }, ip)).status).toBe(401)
    const blocked = await post(app, '/login', { email: 'a@x.com', password: 'bad' }, ip)
    expect(blocked.status).toBe(429)
    expect(blocked.headers['x-ratelimit-limiter']).toBe('auth_fail')
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(60)          // 15-minute auth window
    expect(blocked.body.code).toBe('RATE_LIMITED')
  })

  it('SUCCESSFUL logins do not consume the budget - a whole shop can log in from one IP', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.21' }
    for (let i = 0; i < 25; i++) expect((await post(app, '/login', { email: `staff${i}@x.com`, password: 'ok' }, ip)).status).toBe(200)
    expect((await post(app, '/login', { email: 'a@x.com', password: 'bad' }, ip)).status).toBe(401)   // still has its full failure budget
  })

  it('failed attempts against DIFFERENT accounts share the per-IP budget (credential stuffing)', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.22' }
    const rs = []
    for (let i = 0; i < 4; i++) rs.push(await post(app, '/login', { email: `victim${i}@x.com`, password: 'guess' }, ip))
    expect(statuses(rs)).toEqual([401, 401, 401, 429])
    // another IP is unaffected
    expect((await post(app, '/login', { email: 'victim0@x.com', password: 'guess' }, { 'X-Forwarded-For': '203.0.113.99' })).status).toBe(401)
  })

  it('exhausting login failures does not lock the shop out of /auth/me (separate bucket)', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.23' }
    for (let i = 0; i < 4; i++) await post(app, '/login', { password: 'bad' }, ip)
    expect((await request(app).get('/api/v1/auth/me').set({ ...ip, ...auth('alice') })).status).toBe(200)
  })

  it('OTP verification failures are capped; wrong codes cannot be brute-forced', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.24' }
    const rs = []
    for (let i = 0; i < 4; i++) rs.push(await post(app, '/verify-otp', { otp: String(1000 + i) }, ip))
    expect(statuses(rs)).toEqual([400, 400, 400, 429])
    expect(rs[3].headers['x-ratelimit-limiter']).toBe('auth_fail')
  })

  it('OTP SENDS count every time (they cost money): 2 allowed, 3rd is 429', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.25' }
    const rs = []
    for (let i = 0; i < 3; i++) rs.push(await post(app, '/send-otp', { phone: '+9779800000000' }, ip))
    expect(statuses(rs)).toEqual([200, 200, 429])
    expect(rs[2].headers['x-ratelimit-limiter']).toBe('otp_send')
  })

  it('registration attempts count even when they succeed', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.26' }
    const rs = []
    for (let i = 0; i < 3; i++) rs.push(await post(app, '/register', {}, ip))
    expect(statuses(rs)).toEqual([201, 201, 429])
  })

  it('token refresh has its own bucket', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.27' }
    const rs = []
    for (let i = 0; i < 4; i++) rs.push(await post(app, '/refresh', {}, ip))
    expect(statuses(rs)).toEqual([200, 200, 200, 429])
    expect(rs[3].headers['x-ratelimit-limiter']).toBe('auth_refresh')
  })

  it('password re-check failures are limited PER USER, not per shared IP', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    const ip = { 'X-Forwarded-For': '203.0.113.28' }
    for (let i = 0; i < 2; i++) await post(app, '/verify-password', { password: 'bad' }, { ...ip, ...auth('mallory') })
    const blocked = await post(app, '/verify-password', { password: 'bad' }, { ...ip, ...auth('mallory') })
    expect(blocked.status).toBe(429)
    expect(blocked.headers['x-ratelimit-limiter']).toBe('auth_sensitive')
    // a colleague behind the same IP can still confirm their own password
    expect((await post(app, '/verify-password', { password: 'ok' }, { ...ip, ...auth('alice') })).status).toBe(200)
    // and a successful check by the blocked user... is also refused while locked (bucket already over limit)
    expect((await post(app, '/verify-password', { password: 'ok' }, { ...ip, ...auth('mallory') })).status).toBe(429)
  })

  it('successful password checks never consume the budget', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    for (let i = 0; i < 12; i++) expect((await post(app, '/verify-password', { password: 'ok' }, auth('alice'))).status).toBe(200)
  })

  it('only ONE specialised limiter runs per request: /auth/me never touches auth budgets', async () => {
    const { app } = makeApp(HIGH_BASELINE)
    for (let i = 0; i < 30; i++) expect((await request(app).get('/api/v1/auth/me').set(auth('alice'))).status).toBe(200)
  })
})

describe('tier 2: reports, scanner, OCR, heavy ops', () => {
  it('reports: per-user cap (4); a different user is unaffected; other routes still work for the capped user', async () => {
    const { app } = makeApp({ RATE_LIMIT_USER_MAX: '100', RATE_LIMIT_COMPANY_MAX: '1000' })
    const rs = []
    for (let i = 0; i < 5; i++) rs.push(await request(app).get('/api/v1/reports/sales').set(auth('alice')))
    expect(statuses(rs)).toEqual([200, 200, 200, 200, 429])
    expect(rs[4].headers['x-ratelimit-limiter']).toBe('reports')
    expect((await request(app).get('/api/v1/reports/sales').set(auth('bob'))).status).toBe(200)
    expect((await request(app).get('/api/v1/products').set(auth('alice'))).status).toBe(200)
  })

  it('reports tier counts each request exactly ONCE across /reports/*, nested reports and /stock-register', async () => {
    const { app } = makeApp({ RATE_LIMIT_USER_MAX: '100', RATE_LIMIT_COMPANY_MAX: '1000' })
    const paths = ['/api/v1/reports/company-vs-customer/x', '/api/v1/reports/sales', '/api/v1/stock-register', '/api/v1/reports/profit-loss']
    const rs = []
    for (const p of paths) rs.push(await request(app).get(p).set(auth('alice')))
    expect(statuses(rs)).toEqual([200, 200, 200, 200])                     // 4 requests == limit 4 => no double counting
    expect((await request(app).get('/api/v1/reports/sales').set(auth('alice'))).status).toBe(429)
  })

  it('scanner lookups are capped per user', async () => {
    const { app } = makeApp({ RATE_LIMIT_USER_MAX: '100', RATE_LIMIT_COMPANY_MAX: '1000' })
    const rs = []
    for (let i = 0; i < 4; i++) rs.push(await request(app).get('/api/v1/scanner/products/barcode/123').set(auth('alice')))
    expect(statuses(rs)).toEqual([200, 200, 200, 429])
    expect(rs[3].headers['x-ratelimit-limiter']).toBe('scanner')
  })

  it('OCR: uploads are capped (2) but the status poll is NOT limited by the upload budget', async () => {
    const { app } = makeApp({ RATE_LIMIT_USER_MAX: '1000', RATE_LIMIT_COMPANY_MAX: '5000' })
    const h = auth('alice')
    // a scan being polled every 2 s for a long time - far beyond the upload cap
    for (let i = 0; i < 60; i++) expect((await request(app).get('/api/v1/purchase-scans/scan-1').set(h)).status).toBe(200)
    const up = []
    for (let i = 0; i < 3; i++) up.push(await request(app).post('/api/v1/purchase-scans').set(h))
    expect(statuses(up)).toEqual([201, 201, 429])
    expect(up[2].headers['x-ratelimit-limiter']).toBe('ocr_upload')
    expect((await request(app).get('/api/v1/purchase-scans/scan-1').set(h)).status).toBe(200)   // still pollable while uploads are capped
  })

  it('heavy ops (backup run / download) are capped independently of each other family', async () => {
    const { app } = makeApp({ RATE_LIMIT_USER_MAX: '1000', RATE_LIMIT_COMPANY_MAX: '5000' })
    const h = auth('admin1')
    const rs = []
    for (let i = 0; i < 3; i++) rs.push(await request(app).post('/api/v1/settings/backup/run').set(h))
    expect(statuses(rs)).toEqual([200, 200, 429])
    expect(rs[2].headers['x-ratelimit-limiter']).toBe('heavy_ops')
  })
})

describe('concurrency: multiple simultaneous users and bursts', () => {
  it('a burst of 20 simultaneous requests from one user lets exactly `user` (5) through', async () => {
    const { app } = makeApp({ RATE_LIMIT_COMPANY_MAX: '1000' })
    const rs = await Promise.all(Array.from({ length: 20 }, () => request(app).get('/api/v1/products').set(auth('alice'))))
    expect(rs.filter(r => r.status === 200)).toHaveLength(5)
    expect(rs.filter(r => r.status === 429)).toHaveLength(15)
  })

  it('10 users x 10 simultaneous requests each: every user gets exactly 5 through, none starve another', async () => {
    const { app } = makeApp({ RATE_LIMIT_COMPANY_MAX: '1000' })
    const users = Array.from({ length: 10 }, (_, i) => `staff-${i}`)
    const rs = await Promise.all(users.flatMap(u => Array.from({ length: 10 }, () =>
      request(app).get('/api/v1/products').set({ ...auth(u), 'X-Forwarded-For': '203.0.113.200' }).then(r => ({ u, status: r.status })))))
    for (const u of users) expect(rs.filter(r => r.u === u && r.status === 200)).toHaveLength(5)
  })
})

describe('diagnostics: structured logs, classification, counters', () => {
  it('logs one structured line per rejection with ids/route/limiter/timing and NO secrets', async () => {
    const lines = []
    diag.setLogSink(l => lines.push(JSON.parse(l)))
    const { app } = makeApp()
    const secretQuery = 'apikey=SUPERSECRET123'
    const h = { ...auth('alice', 'co-77'), 'X-Forwarded-For': '203.0.113.9' }
    for (let i = 0; i < 5; i++) await request(app).get('/api/v1/products').set(h)
    await request(app).get(`/api/v1/products?${secretQuery}`).set(h).send()
    const rejected = lines.filter(l => l.event === 'rate_limit_rejected')
    expect(rejected).toHaveLength(1)
    const l = rejected[0]
    expect(l).toMatchObject({
      level: 'warn', source: 'app-limiter', method: 'GET', route: '/api/v1/products', limiter: 'user', keyType: 'user',
      userId: 'alice', companyId: 'co-77', ip: '203.0.113.9', status: 429, limit: 5, windowMs: 60000,
    })
    expect(l.requestId).toMatch(/^req-/)
    expect(l.proxy).toMatchObject({ trustProxy: 1, viaTrustedProxy: true, xffPresent: true, forwardedHops: 1 })
    expect(l.retryAfterSeconds).toBeGreaterThan(0)
    expect(typeof l.durationMs).toBe('number')
    expect(new Date(l.resetAt).getTime()).toBeGreaterThan(Date.now() - 1000)
    const raw = JSON.stringify(lines)
    expect(raw).not.toContain('SUPERSECRET123')                // query string never logged
    expect(raw).not.toContain(token('alice', 'co-77').slice(0, 20))
    expect(raw.toLowerCase()).not.toContain('authorization')
    expect(raw.toLowerCase()).not.toContain('bearer')
  })

  it('route is a low-cardinality template (uuids/numeric ids replaced)', async () => {
    const lines = []
    diag.setLogSink(l => lines.push(JSON.parse(l)))
    const { app } = makeApp({ RATE_LIMIT_IP_MAX: '1' })
    const id = '3f2b8c1e-1111-4222-8333-444455556666'
    await request(app).get(`/api/v1/purchase-scans/${id}`)
    await request(app).get(`/api/v1/purchase-scans/${id}`)
    expect(lines.find(l => l.event === 'rate_limit_rejected').route).toBe('/api/v1/purchase-scans/:id')
  })

  it('an application-defined 429 (PIN lockout) is tagged "application" - distinguishable from a limiter', async () => {
    const lines = []
    diag.setLogSink(l => lines.push(JSON.parse(l)))
    const { app } = makeApp()
    const res = await request(app).get('/api/v1/app-429').set(auth('alice'))
    expect(res.status).toBe(429)
    expect(res.headers['x-ratelimit-source']).toBe('application')
    expect(res.headers['x-ratelimit-limiter']).toBeUndefined()
    expect(res.body.code).toBe('PIN_LOCKED')
    expect(lines.find(l => l.event === 'http_429_application')).toBeTruthy()
    expect(diag.snapshotCounters().application.rejected).toBe(1)
  })

  it('keeps per-limiter rejection counters for the diagnostics endpoint', async () => {
    const { app, rl } = makeApp()
    for (let i = 0; i < 7; i++) await request(app).get('/api/v1/products').set(auth('alice'))
    expect(diag.snapshotCounters().user.rejected).toBe(2)
    expect(rl.describe()).toMatchObject({ store: { kind: 'memory' }, limits: { user: 5 }, windowsMs: { api: 60000 } })
  })

  it('can silence rejection logs (RATE_LIMIT_LOG_REJECTIONS=false) while still counting', async () => {
    const lines = []
    diag.setLogSink(l => lines.push(l))
    const { app } = makeApp({ RATE_LIMIT_LOG_REJECTIONS: 'false' })
    for (let i = 0; i < 6; i++) await request(app).get('/api/v1/products').set(auth('alice'))
    expect(lines).toHaveLength(0)
    expect(diag.snapshotCounters().user.rejected).toBe(1)
    diag.setLoggingEnabled(true)
  })
})
