/**
 * Static guard on server.js: the limiter arrangement documented in
 * middleware/rateLimit/index.js must be the one actually mounted. (server.js cannot be
 * imported in a unit test - it connects to PostgreSQL and listens on a port.)
 */
'use strict'
const fs = require('fs'), path = require('path')
const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8')
const idx = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i }

describe('server.js rate-limit wiring', () => {
  it('baseline limiter is mounted on the API prefix BEFORE every router', () => {
    const base = idx('app.use(API, generalLimiter)')
    const mounts = [...src.matchAll(/^app\.use\(`\$\{API\}\/[a-z-]+[^\n]*Router\)/gm)]
    expect(mounts.length).toBeGreaterThan(15)           // sanity: we really found the router mounts
    for (const m of mounts) expect(m.index).toBeGreaterThan(base)
  })
  it('reports limiter is mounted exactly once (no double counting)', () => {
    expect(src.match(/reportsLimiter(?!,\s*\n)/g).filter(Boolean).length).toBeGreaterThan(0)
    expect(src.match(/app\.use\([^)]*reportsLimiter[^)]*\)/g)).toHaveLength(1)
  })
  it('ocr limiter guards the purchase-scans mount; auth limiter guards /auth', () => {
    expect(src).toMatch(/purchase-scans`,\s+ocrLimiter, purchaseScansRouter/)
    expect(src).toMatch(/auth`,\s+authLimiter, authRouter/)
  })
  it('heavy-ops limiter covers backup run + download', () => {
    expect(src).toMatch(/app\.post\(`\$\{API\}\/settings\/backup\/run`,\s+heavyOpsLimiter\)/)
    expect(src).toMatch(/app\.get\(`\$\{API\}\/settings\/backup\/:id\/download`,\s+heavyOpsLimiter\)/)
  })
  it('trust proxy comes from validated config, never a literal or `true`', () => {
    expect(src).toContain("app.set('trust proxy', config.rateLimit.trustProxy)")
    expect(src).not.toMatch(/app\.set\('trust proxy',\s*true\)/)
  })
  it('CORS runs BEFORE the limiters so 429s carry CORS headers the browser can read', () => {
    expect(idx('exposedHeaders')).toBeLessThan(idx('app.use(API, generalLimiter)'))
  })
  it('CORS exposes Retry-After and the limiter/source headers', () => {
    const m = src.match(/exposedHeaders:\s*\[([^\]]*)\]/)[1]
    for (const h of ['Retry-After', 'RateLimit-Reset', 'X-RateLimit-Limiter', 'X-RateLimit-Source']) expect(m).toContain(`'${h}'`)
  })
  it('health and LAN discovery stay outside the limiter stack', () => {
    const base = idx('app.use(API, generalLimiter)')
    expect(idx("app.get('/health'")).toBeLessThan(base)
    expect(idx('/discovery/info')).toBeLessThan(base)
  })
  it('no code reads X-Forwarded-For directly for bucketing', () => {
    const rl = ['rateLimit/index.js', 'rateLimit/identity.js', 'rateLimit/store.js']
      .map(f => fs.readFileSync(path.join(__dirname, '../src/middleware', f), 'utf8')).join('\n')
    expect(rl).not.toMatch(/headers\[['"]x-forwarded-for['"]\]/i)
  })
})
