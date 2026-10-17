'use strict'
const { loadRateLimitConfig, RateLimitConfigError } = require('../src/config/rateLimitConfig')

const prod = (env = {}) => loadRateLimitConfig(env, { isProd: true })

describe('rate-limit config: defaults', () => {
  it('uses short API window and per-user/company/ip budgets in production', () => {
    const c = prod()
    expect(c.apiWindowMs).toBe(60_000)
    expect(c.authWindowMs).toBe(15 * 60_000)
    expect(c.limits).toMatchObject({ user: 300, company: 1200, ip: 120, authFail: 20, otpSend: 10, refresh: 60, sensitive: 10, reports: 90, scanner: 180, ocrUpload: 15, heavyOps: 10 })
    expect(c.store).toBe('memory')
    expect(c.trustProxy).toBe(1)
  })
  it('is more generous in development', () => {
    const c = loadRateLimitConfig({}, { isDev: true })
    expect(c.limits.user).toBeGreaterThan(300)
  })
  it('the per-user budget is larger than what the old 100/15min per-IP rule allowed per minute', () => {
    expect(prod().limits.user / (prod().apiWindowMs / 60_000)).toBeGreaterThan(100 / 15)
  })
  it('config is frozen', () => {
    const c = prod()
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.limits)).toBe(true)
  })
})

describe('rate-limit config: validation', () => {
  it('accepts overrides', () => {
    const c = prod({ RATE_LIMIT_USER_MAX: '500', RATE_LIMIT_API_WINDOW_MS: '30000' })
    expect(c.limits.user).toBe(500)
    expect(c.apiWindowMs).toBe(30_000)
  })
  it.each([
    ['RATE_LIMIT_USER_MAX', 'abc'], ['RATE_LIMIT_USER_MAX', '0'], ['RATE_LIMIT_USER_MAX', '-5'],
    ['RATE_LIMIT_USER_MAX', '12.5'], ['RATE_LIMIT_USER_MAX', '99999999'],
    ['RATE_LIMIT_API_WINDOW_MS', '10'], ['RATE_LIMIT_API_WINDOW_MS', '999999999999'],
  ])('rejects %s=%s instead of silently falling back', (k, v) => {
    expect(() => prod({ [k]: v })).toThrow(RateLimitConfigError)
  })
  it('reports every problem at once', () => {
    try { prod({ RATE_LIMIT_USER_MAX: 'x', RATE_LIMIT_IP_MAX: '0' }); throw new Error('should have thrown') }
    catch (e) { expect(e.problems).toHaveLength(2) }
  })
  it('rejects an unknown store and redis without REDIS_URL', () => {
    expect(() => prod({ RATE_LIMIT_STORE: 'mongo' })).toThrow(/RATE_LIMIT_STORE/)
    expect(() => prod({ RATE_LIMIT_STORE: 'redis' })).toThrow(/REDIS_URL/)
    expect(prod({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://localhost:6379' }).store).toBe('redis')
  })
  it('rejects a non-boolean RATE_LIMIT_LOG_REJECTIONS', () => {
    expect(() => prod({ RATE_LIMIT_LOG_REJECTIONS: 'maybe' })).toThrow(RateLimitConfigError)
  })
})

describe('rate-limit config: trust proxy', () => {
  it('numeric hops', () => expect(prod({ TRUST_PROXY: '2' }).trustProxy).toBe(2))
  it('false', () => expect(prod({ TRUST_PROXY: 'false' }).trustProxy).toBe(false))
  it('CIDR / keyword list', () => expect(prod({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toEqual(['loopback', '10.0.0.0/8']))
  it('forbids "true" in production (spoofable X-Forwarded-For)', () => {
    expect(() => prod({ TRUST_PROXY: 'true' })).toThrow(/forbidden in production/)
  })
  it('allows "true" outside production', () => {
    expect(loadRateLimitConfig({ TRUST_PROXY: 'true' }, { isDev: true }).trustProxy).toBe(true)
  })
  it('rejects implausible hop counts and garbage', () => {
    expect(() => prod({ TRUST_PROXY: '50' })).toThrow(RateLimitConfigError)
    expect(() => prod({ TRUST_PROXY: '$(rm -rf)' })).toThrow(RateLimitConfigError)
  })
})

describe('rate-limit config: legacy variables', () => {
  it('ignores the old budget variables so a stale RATE_LIMIT_MAX=100 cannot survive the upgrade', () => {
    const c = prod({ RATE_LIMIT_MAX: '100', RATE_LIMIT_WINDOW_MS: '900000', AUTH_RATE_LIMIT_MAX: '10' })
    expect(c.limits.user).toBe(300)
    expect(c.apiWindowMs).toBe(60_000)
    expect(c.legacyVarsIgnored).toEqual(expect.arrayContaining(['RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'AUTH_RATE_LIMIT_MAX']))
  })
})
