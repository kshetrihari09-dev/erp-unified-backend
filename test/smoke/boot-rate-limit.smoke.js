/**
 * Boot smoke test: starts the REAL src/server.js (all middleware + routers) with the
 * PostgreSQL layer stubbed out, then exercises the rate limiters over real HTTP.
 *
 *   node test/smoke/boot-rate-limit.smoke.js
 *
 * What it proves: server.js mounts the limiters as documented, CORS exposes the
 * Retry-After / limiter headers on 429s, trust-proxy resolves client IPs from the right
 * of X-Forwarded-For, and the auth / baseline tiers answer with the documented shape.
 * What it does NOT prove: anything behind the database (real logins, real data).
 */
'use strict'
const path = require('path')
const Module = require('module')
const https = require('https')   // dev boot auto-enables HTTPS when certs exist
const jwt = require('jsonwebtoken')

const PORT = 5391
Object.assign(process.env, {
  NODE_ENV: 'development', PORT: String(PORT), JWT_SECRET: 'smoke-secret-smoke-secret-smoke-secret',
  JWT_REFRESH_SECRET: 'smoke-refresh-smoke-refresh-smoke', DB_PASSWORD: 'x', DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
  CORS_ORIGIN: 'http://localhost:5173', TRUST_PROXY: '1',
  // production-like budgets so the numbers below match the documented defaults
  RATE_LIMIT_USER_MAX: '300', RATE_LIMIT_COMPANY_MAX: '1200', RATE_LIMIT_IP_MAX: '120', RATE_LIMIT_AUTH_FAIL_MAX: '20',
  // legacy variables must be ignored + reported
  RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '900000',
})

// ── stub the database layer (module path used by server.js: ./db/knex) ──────────
const chain = () => new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? (res) => res([]) : chain()),
  apply: () => chain(),
})
const stubDb = new Proxy(function () {}, {
  get: (_t, p) => {
    if (p === 'raw') return async () => ({ rows: [{ '?column?': 1 }] })
    if (p === 'destroy') return async () => {}
    if (p === 'then') return undefined
    return chain()
  },
  apply: () => chain(),
})
const knexPath = require.resolve('../../src/db/knex')
require.cache[knexPath] = { id: knexPath, filename: knexPath, loaded: true, exports: stubDb }
const origExit = process.exit
process.exit = (c) => { console.error('process.exit called with', c); origExit(c) }

const logs = []
const origWarn = console.warn
console.warn = (...a) => { logs.push(a.join(' ')); }
require('../../src/server')

const req = (method, urlPath, headers = {}, body) => new Promise((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
    let data = ''; res.on('data', d => data += d); res.on('end', () => { let json; try { json = JSON.parse(data) } catch {} resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data }) })
  })
  r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end()
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${cond ? '' : '  ' + extra}`); if (!cond) failures++ }

;(async () => {
  for (let i = 0; i < 50 && !(await req('GET', '/health').catch(() => null)); i++) await sleep(200)
  const health = await req('GET', '/health')
  check('server booted; /health is up and unlimited', health.status === 200)
  for (let i = 0; i < 200; i++) await req('GET', '/health')
  check('/health stays 200 after 200 hits (outside the limiter stack)', (await req('GET', '/health')).status === 200)

  check('legacy RATE_LIMIT_MAX=2 is ignored and reported at boot', logs.some(l => l.includes('rate_limit_legacy_env_ignored') && l.includes('RATE_LIMIT_MAX')))

  // unauthenticated → per-IP bucket (120). Requests 1..120 reach authenticate (401), the 121st is a 429.
  const ipH = { 'X-Forwarded-For': '203.0.113.10', Origin: 'http://localhost:5173' }
  let first429 = null, n = 0
  while (n < 140) { n++; const r = await req('GET', '/api/v1/notifications', ipH); if (r.status === 429) { first429 = { r, n }; break } }
  check('unauthenticated IP bucket: first 429 is request #121 (limit 120)', first429 && first429.n === 121, JSON.stringify(first429 && first429.n))
  const h = first429.r.headers
  check('429 carries Retry-After (integer seconds <= 60)', /^\d+$/.test(h['retry-after']) && +h['retry-after'] <= 60 && +h['retry-after'] >= 1, h['retry-after'])
  check('429 names the limiter and its source', h['x-ratelimit-limiter'] === 'ip' && h['x-ratelimit-source'] === 'app-limiter')
  check('429 body is the documented JSON shape', first429.r.body && first429.r.body.code === 'RATE_LIMITED' && first429.r.body.success === false && first429.r.body.retryAfterSeconds === +h['retry-after'])
  const expose = (h['access-control-expose-headers'] || '').toLowerCase()
  check('CORS exposes Retry-After + limiter headers on the 429 (browser JS can read them)', expose.includes('retry-after') && expose.includes('x-ratelimit-limiter') && expose.includes('x-ratelimit-source') && h['access-control-allow-origin'] === 'http://localhost:5173', expose)

  // a different real client IP is not affected; spoofed leading XFF entries do not create new buckets
  const other = await req('GET', '/api/v1/notifications', { 'X-Forwarded-For': '203.0.113.11' })
  check('another client IP is unaffected', other.status === 401, String(other.status))
  const spoof = await req('GET', '/api/v1/notifications', { 'X-Forwarded-For': '9.9.9.9, 203.0.113.10' })
  check('prepending a fake IP to X-Forwarded-For does NOT escape the bucket', spoof.status === 429, String(spoof.status))

  // authenticated → per-user bucket (300), independent of the exhausted IP bucket
  const tok = (u, c = 'company-1') => jwt.sign({ userId: u, companyId: c, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' })
  const sameIp = (u) => ({ 'X-Forwarded-For': '203.0.113.10', Authorization: `Bearer ${tok(u)}` })
  const authed = await req('GET', '/api/v1/notifications', sameIp('alice'))
  check('a verified user behind the SAME exhausted IP still gets through the limiter (reaches authenticate)', authed.status !== 429, String(authed.status))
  let userFirst429 = null; n = 1
  while (n < 330) { n++; const r = await req('GET', '/api/v1/notifications', sameIp('alice')); if (r.status === 429) { userFirst429 = { r, n }; break } }
  check('per-user bucket: first 429 is request #301 (limit 300)', userFirst429 && userFirst429.n === 301, JSON.stringify(userFirst429 && userFirst429.n))
  check('…reported as limiter "user"', userFirst429 && userFirst429.r.headers['x-ratelimit-limiter'] === 'user')
  const bob = await req('GET', '/api/v1/notifications', sameIp('bob'))
  check('a colleague on the same IP has their own bucket', bob.status !== 429, String(bob.status))

  // forged token cannot pick a bucket
  const forged = jwt.sign({ userId: 'fresh', companyId: 'x' }, 'attacker-secret')
  const f = await req('GET', '/api/v1/notifications', { 'X-Forwarded-For': '203.0.113.10', Authorization: `Bearer ${forged}` })
  check('a forged token falls back to the (exhausted) IP bucket', f.status === 429 && f.headers['x-ratelimit-limiter'] === 'ip', `${f.status} ${f.headers['x-ratelimit-limiter']}`)

  // /auth: failed logins are capped per IP at 20; /auth/me is NOT in that budget
  const loginIp = { 'X-Forwarded-For': '198.51.100.77' }
  let loginFirst429 = null
  for (let i = 1; i <= 40; i++) { const r = await req('POST', '/api/v1/auth/login', loginIp, { email: 'a@b.co', password: 'wrong' }); if (r.status === 429) { loginFirst429 = { r, i }; break } }
  check('failed logins: first 429 is attempt #21 (limit 20)', loginFirst429 && loginFirst429.i === 21, JSON.stringify(loginFirst429 && loginFirst429.i))
  check('…limiter "auth_fail" with a ~15 minute Retry-After', loginFirst429 && loginFirst429.r.headers['x-ratelimit-limiter'] === 'auth_fail' && +loginFirst429.r.headers['retry-after'] > 600)

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SMOKE CHECKS PASSED')
  origExit(failures ? 1 : 0)
})().catch(e => { console.error(e); origExit(2) })
