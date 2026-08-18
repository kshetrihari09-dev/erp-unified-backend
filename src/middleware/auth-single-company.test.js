/**
 * auth-single-company.test.js — Regression tests for the single-company
 * login/session model.
 *
 * One user belongs to exactly one company (users.company_id). The
 * authenticated request's company_id and role must always come from the
 * database, never from anything the client controls — including the JWT
 * payload itself, since a JWT can be up to JWT_EXPIRES_IN old and the
 * user's company/role/active-status may have changed since it was issued.
 *
 * These tests exercise authenticate() directly, the same way Express
 * calls it, against a real (HMAC-signed) JWT and a mocked `users` table.
 */
'use strict'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest'

let usersTable = []

jest.mock('../db/knex', () => {
  const fn = (table) => {
    if (table !== 'users') throw new Error(`unexpected table in this test: ${table}`)
    let filtered = usersTable
    const qb = {
      where: (col) => {
        filtered = filtered.filter(u => Object.entries(col).every(([k, v]) => u[k] === v))
        return qb
      },
      first: async (...cols) => {
        const row = filtered[0]
        if (!row) return undefined
        if (!cols.length) return row
        const out = {}
        for (const c of cols) out[c] = row[c]
        return out
      },
    }
    return qb
  }
  return fn
})

const jwt = require('jsonwebtoken')
const { authenticate } = require('./index')

function mockRes() {
  const res = {}
  res.status = jest.fn(() => res)
  res.json   = jest.fn(() => res)
  return res
}

function tokenFor(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' })
}

describe('authenticate() — company_id and role always come from the database', () => {

  test('req.companyId is set from users.company_id, not from the JWT payload', async () => {
    usersTable = [{ id: 'user-1', email: 'owner@abcpharmacy.com', role: 'owner', company_id: 'company-real', is_active: true }]

    // Forged/stale JWT claiming a completely different company.
    const token = tokenFor({ userId: 'user-1', email: 'owner@abcpharmacy.com', role: 'owner', companyId: 'company-FORGED' })
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = mockRes()
    const next = jest.fn()

    await authenticate(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.companyId).toBe('company-real')      // never 'company-FORGED'
    expect(req.user.role).toBe('owner')
  })

  test('a role change in the database takes effect immediately, even with a still-valid JWT', async () => {
    usersTable = [{ id: 'user-2', email: 'cashier@abcpharmacy.com', role: 'cashier', company_id: 'company-real', is_active: true }]

    // Token was minted while this user was still an 'owner'.
    const token = tokenFor({ userId: 'user-2', email: 'cashier@abcpharmacy.com', role: 'owner', companyId: 'company-real' })
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = mockRes()
    const next = jest.fn()

    await authenticate(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.user.role).toBe('cashier')            // demoted role wins, not the JWT's stale 'owner'
  })

  test('a deactivated account is rejected even with a valid, unexpired token', async () => {
    usersTable = [{ id: 'user-3', email: 'x@abcpharmacy.com', role: 'admin', company_id: 'company-real', is_active: false }]
    const token = tokenFor({ userId: 'user-3', email: 'x@abcpharmacy.com', role: 'admin', companyId: 'company-real' })
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = mockRes()
    const next = jest.fn()

    await authenticate(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  test('a token for a user that no longer exists is rejected', async () => {
    usersTable = []
    const token = tokenFor({ userId: 'ghost-user', email: 'x@abcpharmacy.com', role: 'admin', companyId: 'company-real' })
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = mockRes()
    const next = jest.fn()

    await authenticate(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  test('two different companies\' users never resolve to each other\'s company_id', async () => {
    usersTable = [
      { id: 'owner-a', email: 'owner@companyA.com', role: 'owner', company_id: 'company-A', is_active: true },
    ]
    const tokenA = tokenFor({ userId: 'owner-a', email: 'owner@companyA.com', role: 'owner', companyId: 'company-A' })
    const reqA = { headers: { authorization: `Bearer ${tokenA}` } }
    const resA = mockRes()
    await authenticate(reqA, resA, jest.fn())
    expect(reqA.companyId).toBe('company-A')

    usersTable = [
      { id: 'owner-b', email: 'owner@companyB.com', role: 'owner', company_id: 'company-B', is_active: true },
    ]
    // Even reusing owner-a's forged companyId claim inside a token that
    // authenticates as owner-b changes nothing — owner-b's own row is what
    // determines company_id.
    const tokenB = tokenFor({ userId: 'owner-b', email: 'owner@companyB.com', role: 'owner', companyId: 'company-A' })
    const reqB = { headers: { authorization: `Bearer ${tokenB}` } }
    const resB = mockRes()
    await authenticate(reqB, resB, jest.fn())
    expect(reqB.companyId).toBe('company-B')
  })
})
