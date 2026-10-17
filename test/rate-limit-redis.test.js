/**
 * Shared-store tests against a REAL redis-server (spawned on a random port).
 * Skipped (loudly) when the redis-server binary is not installed.
 */
'use strict'
const { spawn, spawnSync } = require('child_process')
const net = require('net')
const express = require('express')
const request = require('supertest')
const jwt = require('jsonwebtoken')
const { loadRateLimitConfig } = require('../src/config/rateLimitConfig')
const { createRateLimiters } = require('../src/middleware/rateLimit')
const diag = require('../src/middleware/rateLimit/diagnostics')

const hasRedis = spawnSync('redis-server', ['--version']).status === 0
const d = hasRedis ? describe : describe.skip
if (!hasRedis) console.warn('[rate-limit-redis.test] redis-server not installed - tests SKIPPED')

const SECRET = 's'
const auth = (u) => ({ Authorization: 'Bearer ' + jwt.sign({ userId: u, companyId: 'co' }, SECRET, { expiresIn: '1h' }) })
const free = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let proc, port
async function startRedis(p) {
  proc = spawn('redis-server', ['--port', String(p), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {                       // wait until it accepts connections
    if (await new Promise(r => net.connect(p, '127.0.0.1').once('connect', function () { this.destroy(); r(true) }).once('error', () => r(false)))) return
    await sleep(100)
  }
  throw new Error('redis did not start')
}
const stopRedis = () => new Promise(r => { if (!proc) return r(); proc.once('exit', r); proc.kill('SIGKILL'); proc = null })

/** One "backend instance": its own limiter objects + own express app. */
function instance(extraEnv = {}) {
  const cfg = loadRateLimitConfig({
    RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://127.0.0.1:${port}`, RATE_LIMIT_REDIS_PREFIX: `t${Date.now()}:`,
    RATE_LIMIT_USER_MAX: '5', RATE_LIMIT_COMPANY_MAX: '1000', RATE_LIMIT_AUTH_FAIL_MAX: '2', ...extraEnv,
  }, { isProd: true })
  const rl = createRateLimiters(cfg, { logger: { warn() {}, error() {} }, getSecret: () => SECRET })
  const app = express()
  app.use('/api/v1', rl.baseline)
  app.get('/api/v1/products', (_q, r) => r.json({ ok: 1 }))
  app.use('/api/v1/auth', rl.authRoutes, express.Router().post('/login', (_q, r) => r.status(401).json({})))
  return { app, rl }
}

d('Redis-backed shared counters', () => {
  beforeAll(async () => { diag.setLoggingEnabled(false); port = await free(); await startRedis(port) })
  afterAll(async () => { await stopRedis(); diag.setLoggingEnabled(true) })

  it('two backend instances enforce ONE budget for the same user (memory store would allow 2x)', async () => {
    const a = instance(), b = instance({ RATE_LIMIT_REDIS_PREFIX: a.rl.storeProvider.status && undefined })
    // same prefix is required for sharing: rebuild b with a's prefix
    const prefix = `shared${Date.now()}:`
    const A = instance({ RATE_LIMIT_REDIS_PREFIX: prefix }), B = instance({ RATE_LIMIT_REDIS_PREFIX: prefix })
    const h = auth('alice')
    const rs = []
    for (let i = 0; i < 8; i++) rs.push((await request(i % 2 ? A.app : B.app).get('/api/v1/products').set(h)).status)
    expect(rs.filter(s => s === 200)).toHaveLength(5)
    expect(rs.filter(s => s === 429)).toHaveLength(3)
    await Promise.all([a, b, A, B].map(x => x.rl.close()))
  })

  it('concurrent requests across instances are counted atomically', async () => {
    const prefix = `atomic${Date.now()}:`
    const A = instance({ RATE_LIMIT_REDIS_PREFIX: prefix }), B = instance({ RATE_LIMIT_REDIS_PREFIX: prefix })
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => request(i % 2 ? A.app : B.app).get('/api/v1/products').set(auth('bob'))))
    expect(rs.filter(r => r.status === 200)).toHaveLength(5)
    await Promise.all([A.rl.close(), B.rl.close()])
  })

  it('the window is fixed from the first hit and expires (TTL), restoring access', async () => {
    const I = instance({ RATE_LIMIT_API_WINDOW_MS: '1500' })
    for (let i = 0; i < 5; i++) await request(I.app).get('/api/v1/products').set(auth('carol'))
    const blocked = await request(I.app).get('/api/v1/products').set(auth('carol'))
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(2)
    await sleep(1700)
    expect((await request(I.app).get('/api/v1/products').set(auth('carol'))).status).toBe(200)
    await I.rl.close()
  })

  it('auth_fail counts only failures through the shared store (decrement works)', async () => {
    const I = instance()
    const ip = { 'X-Forwarded-For': '203.0.113.5' }
    expect((await request(I.app).post('/api/v1/auth/login').set(ip)).status).toBe(401)
    expect((await request(I.app).post('/api/v1/auth/login').set(ip)).status).toBe(401)
    expect((await request(I.app).post('/api/v1/auth/login').set(ip)).status).toBe(429)
    await I.rl.close()
  })
})

d('Redis outage behaviour', () => {
  it('business traffic FAILS OPEN, credential endpoints FAIL CLOSED when the store is down', async () => {
    diag.setLoggingEnabled(false)
    const deadPort = await free()                       // nothing listens here
    const cfg = loadRateLimitConfig({ RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://127.0.0.1:${deadPort}` }, { isProd: true })
    const rl = createRateLimiters(cfg, { logger: { warn() {}, error() {} }, getSecret: () => SECRET })
    const app = express()
    app.use('/api/v1', rl.baseline)
    app.get('/api/v1/products', (_q, r) => r.json({ ok: 1 }))
    app.use('/api/v1/auth', rl.authRoutes, express.Router().post('/login', (_q, r) => r.status(401).json({})))
    app.use((err, _q, res, _n) => res.status(500).json({ failedClosed: true }))   // stand-in for errorHandler

    expect((await request(app).get('/api/v1/products').set(auth('alice'))).status).toBe(200)      // availability preserved
    expect((await request(app).post('/api/v1/auth/login')).status).toBe(500)                       // brute-force guard not bypassed
    await rl.close()
    diag.setLoggingEnabled(true)
  }, 20000)
})
