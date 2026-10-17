'use strict'
const jwt = require('jsonwebtoken')
const { verifyIdentityFromAuthHeader, resolveRateLimitIdentity, getIdentity } = require('../src/middleware/rateLimit/identity')

const SECRET = 'unit-test-secret'
const sign = (payload, secret = SECRET, opts = { expiresIn: '1h' }) => jwt.sign(payload, secret, opts)
const bearer = (t) => `Bearer ${t}`

describe('verifyIdentityFromAuthHeader', () => {
  it('returns ids for a validly signed staff token', () => {
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1', companyId: 'c1' })), SECRET)).toEqual({ userId: 'u1', companyId: 'c1' })
  })
  it('rejects a token signed with another secret (forged)', () => {
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1', companyId: 'c1' }, 'attacker')), SECRET)).toBeNull()
  })
  it('rejects an expired token', () => {
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1', companyId: 'c1' }, SECRET, { expiresIn: -10 })), SECRET)).toBeNull()
  })
  it('rejects alg=none / unsigned tokens', () => {
    const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + Buffer.from('{"userId":"u1","companyId":"c1"}').toString('base64url') + '.'
    expect(verifyIdentityFromAuthHeader(bearer(none), SECRET)).toBeNull()
  })
  it('rejects removed storefront customer tokens', () => {
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1', companyId: 'c1', kind: 'customer' })), SECRET)).toBeNull()
  })
  it('rejects tokens without both ids, and ids that could inject bucket keys', () => {
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1' })), SECRET)).toBeNull()
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1', companyId: 'c1:evil key' })), SECRET)).toBeNull()
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'x'.repeat(200), companyId: 'c1' })), SECRET)).toBeNull()
  })
  it('rejects malformed / missing / non-Bearer headers and a missing secret', () => {
    for (const h of [undefined, '', 'Basic abc', 'Bearer', 'Bearer not.a.jwt', 'Bearer ' + 'a'.repeat(5000)]) {
      expect(verifyIdentityFromAuthHeader(h, SECRET)).toBeNull()
    }
    expect(verifyIdentityFromAuthHeader(bearer(sign({ userId: 'u1', companyId: 'c1' })), undefined)).toBeNull()
  })
})

describe('resolveRateLimitIdentity middleware', () => {
  const run = (req) => { let called = false; resolveRateLimitIdentity(() => SECRET)(req, {}, () => { called = true }); return called }

  it('never reads identity from other headers, query or body', () => {
    const req = { headers: { 'x-user-id': 'victim', 'x-company-id': 'victimco' }, query: { userId: 'victim' }, body: { userId: 'victim', companyId: 'victimco' } }
    expect(run(req)).toBe(true)
    expect(req.rateLimitIdentity).toBeNull()
  })
  it('sets identity from a valid bearer token and caches it', () => {
    const req = { headers: { authorization: bearer(sign({ userId: 'u9', companyId: 'c9' })) } }
    run(req)
    expect(req.rateLimitIdentity).toEqual({ userId: 'u9', companyId: 'c9' })
    req.headers.authorization = 'Bearer garbage'          // later tampering must not change the cached result
    expect(getIdentity(req, () => SECRET)).toEqual({ userId: 'u9', companyId: 'c9' })
  })
  it('never rejects the request itself', () => {
    expect(run({ headers: { authorization: 'Bearer garbage' } })).toBe(true)
  })
})
