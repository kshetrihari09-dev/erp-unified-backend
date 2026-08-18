/**
 * voucher-cross-company-security.test.js — Regression tests for the
 * cross-company voucher IDOR/BOLA fix.
 *
 * Before the fix, PostingEngine.post()/reverse() and VoucherService.cancel()
 * looked up vouchers by `id` alone (post() even derived the "authorization"
 * company from the voucher's own creator via a join) — so a user
 * authenticated into Company A could post/reverse/cancel a voucher that
 * actually belonged to Company B, simply by knowing/guessing its UUID.
 *
 * These tests assert:
 *   A. Company A cannot POST a Company B voucher
 *   B. Company A cannot REVERSE a Company B voucher
 *   C. Company A cannot CANCEL a Company B voucher
 *   D. Company A cannot UPDATE (edit) a Company B voucher
 *   E. Company A CAN still post/reverse/cancel its OWN vouchers (no regression)
 *   F. A step-up token minted for Company A cannot authorize an action
 *      scoped to Company B
 *   G. A nonexistent voucher id returns the same safe response as a
 *      cross-company voucher (no existence leakage)
 *
 * Uses the same lightweight in-memory mock Knex approach as
 * posting-engine.test.js, extended with onConflict()/merge() and advisory
 * lock support so the full (non -InTransaction) post()/reverse() paths —
 * the ones actually exposed on the HTTP routes — can be exercised.
 */
'use strict'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest'

// ─── Mock DB ─────────────────────────────────────────────────────────────────

let _mockState = {}

function filterRows(rows, col, val) {
  if (typeof col === 'function') return rows.filter(col)
  if (typeof col === 'object' && col !== null) {
    return rows.filter(r => Object.entries(col).every(([k, v]) => r[k] === v))
  }
  if (val === undefined) return rows
  return rows.filter(r => r[col] === val)
}

function makeQB(rowsRef) {
  let _filtered = [...rowsRef.rows]

  const qb = {
    where: (col, val) => {
      if (typeof col === 'function') {
        const subFilters = []
        const subQB = {
          where:   (c, v) => { subFilters.push({ type: 'and', c, v }); return subQB },
          orWhere: (c, v) => { subFilters.push({ type: 'or',  c, v }); return subQB },
        }
        try { col.call(subQB) } catch {}
        if (subFilters.length > 0) {
          _filtered = _filtered.filter(r => subFilters.some(f => r[f.c] === f.v))
        }
        return qb
      }
      _filtered = filterRows(_filtered, col, val)
      return qb
    },
    andWhere:  (col, val) => { _filtered = filterRows(_filtered, col, val); return qb },
    orWhere:   ()         => qb,
    whereIn:   (col, vals) => { _filtered = _filtered.filter(r => vals.includes(r[col])); return qb },
    whereNull: (col)       => { _filtered = _filtered.filter(r => r[col] == null); return qb },
    orderBy:   ()          => qb,
    limit:     ()          => qb,
    offset:    ()          => qb,
    select:    ()          => qb,
    join:      ()          => qb,
    leftJoin:  ()          => qb,
    clearSelect: ()        => qb,
    clone:     ()          => makeQB({ rows: _filtered }),
    first:     async ()    => _filtered[0],
    count:     async (col) => {
      const alias = (col || 'count as count').split(' as ')[1] || 'count'
      return [{ [alias]: _filtered.length }]
    },
    insert: (data) => {
      const row = { id: `uuid-${Math.random().toString(36).slice(2, 10)}`, created_at: new Date().toISOString(), ...data }
      rowsRef.rows.push(row)
      const insertResult = {
        returning: () => ({
          then: (fn) => fn ? fn([row]) : Promise.resolve([row]),
          catch: () => insertResult,
        }),
        // Support .insert(...).onConflict([...]).merge({...}) — used by the
        // processing_log idempotency upsert in PostingEngine.post()/reverse().
        onConflict: () => ({
          merge: async (mergeData) => { Object.assign(row, mergeData); return 1 },
        }),
        then: (fn) => fn ? fn([row]) : Promise.resolve([row]),
      }
      return insertResult
    },
    update: async (data) => {
      _filtered.forEach(r => Object.assign(r, data))
      return _filtered.length
    },
    del: async () => {
      const n = _filtered.length
      rowsRef.rows = rowsRef.rows.filter(r => !_filtered.includes(r))
      return n
    },
    then: (fn) => fn ? fn(_filtered) : Promise.resolve(_filtered),
  }
  return qb
}

function makeTrx(state) {
  const trx = (table) => {
    if (!state[table]) state[table] = []
    const ref = { get rows() { return state[table] }, set rows(v) { state[table] = v } }
    return makeQB(ref)
  }
  trx.raw = async (sql) => {
    if (sql.includes('is_period_locked'))            return { rows: [{ locked: false }] }
    if (sql.includes('next_voucher_number'))          return { rows: [{ voucher_no: 'REV-2082-00001' }] }
    if (sql.includes('current_company_id'))           return {}
    if (sql.includes('pg_try_advisory_xact_lock'))    return { rows: [{ acquired: true }] }
    if (sql.includes('pg_advisory_xact_lock'))        return { rows: [] }
    if (sql.includes('lock_id'))                      return { rows: [{ lock_id: 42 }] }
    return { rows: [] }
  }
  trx.rollback = async () => { state._rolled_back = true }
  trx.commit   = async () => { state._committed = true }
  return trx
}

let mockCurrentTrx = null
jest.mock('../db/knex', () => {
  const fn = (...args) => mockCurrentTrx(...args)
  fn.transaction = async (fn2) => fn2(mockCurrentTrx)
  fn.setRLSContext = async (trx, companyId) => trx.raw(`SET LOCAL app.current_company_id = '${companyId}'`)
  return fn
})

jest.mock('../utils/auditLogger', () => ({ log: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../utils/hashing', () => ({
  hashJournalEntry:   jest.fn(() => 'mock-hash'),
  getLastJournalHash: jest.fn().mockResolvedValue('prev-hash'),
  hashAuditEntry:     jest.fn(() => 'mock-audit-hash'),
  getLastAuditHash:   jest.fn().mockResolvedValue('prev-audit-hash'),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COMPANY_A = 'company-A'
const COMPANY_B = 'company-B'
const USER_A    = 'user-A'   // authenticated member of Company A

const ACCOUNTS = [
  { id: 'a-acc-csh', company_id: COMPANY_A, code: '1000', name: 'Cash A', type: 'asset',  sub_type: 'cash', is_group: false, is_active: true },
  { id: 'a-acc-rev', company_id: COMPANY_A, code: '4000', name: 'Rev A',  type: 'income',  sub_type: 'sales', is_group: false, is_active: true },
  { id: 'b-acc-csh', company_id: COMPANY_B, code: '1000', name: 'Cash B', type: 'asset',  sub_type: 'cash', is_group: false, is_active: true },
  { id: 'b-acc-rev', company_id: COMPANY_B, code: '4000', name: 'Rev B',  type: 'income',  sub_type: 'sales', is_group: false, is_active: true },
]

function baseState() {
  return {
    accounts:         [...ACCOUNTS],
    vouchers:         [],
    voucher_lines:    [],
    journal_entries:  [],
    journal_lines:    [],
    audit_log:        [],
    processing_log:   [],
  }
}

/** A voucher that belongs to Company B — the "victim" voucher Company A must never touch. */
function addCompanyBVoucher(state, override = {}) {
  const v = {
    id: 'voucher-belongs-to-B', company_id: COMPANY_B, voucher_no: 'SI-B-00001',
    voucher_type: 'SALES', voucher_date: '2024-01-15', status: 'DRAFT',
    narration: 'Company B sale', currency: 'NPR', exchange_rate: 1,
    ...override,
  }
  state.vouchers.push(v)
  state.voucher_lines.push(
    { id: 'bl-1', voucher_id: v.id, account_id: 'b-acc-csh', line_no: 1, debit: 500, credit: 0 },
    { id: 'bl-2', voucher_id: v.id, account_id: 'b-acc-rev', line_no: 2, debit: 0,   credit: 500 },
  )
  return v
}

/** A voucher that genuinely belongs to Company A — used for the "no regression" tests. */
function addCompanyAVoucher(state, override = {}) {
  const v = {
    id: 'voucher-belongs-to-A', company_id: COMPANY_A, voucher_no: 'SI-A-00001',
    voucher_type: 'SALES', voucher_date: '2024-01-15', status: 'DRAFT',
    narration: 'Company A sale', currency: 'NPR', exchange_rate: 1,
    ...override,
  }
  state.vouchers.push(v)
  state.voucher_lines.push(
    { id: 'al-1', voucher_id: v.id, account_id: 'a-acc-csh', line_no: 1, debit: 750, credit: 0 },
    { id: 'al-2', voucher_id: v.id, account_id: 'a-acc-rev', line_no: 2, debit: 0,   credit: 750 },
  )
  return v
}

const PostingEngine     = require('./postingEngine')
const VoucherService     = require('../services/voucherService')
const VoucherEditService = require('../services/voucherEditService')

function setup() {
  const s = baseState()
  mockCurrentTrx = makeTrx(s)
  return s
}

// ─── A. POST ───────────────────────────────────────────────────────────────

describe('Cross-company IDOR — PostingEngine.post()', () => {

  test('A: Company A user cannot POST a Company B voucher', async () => {
    const s = setup()
    addCompanyBVoucher(s)

    await expect(PostingEngine.post('voucher-belongs-to-B', COMPANY_A, USER_A, null))
      .rejects.toMatchObject({ status: 404 })

    // No mutation: voucher untouched, no journal entries created.
    expect(s.vouchers.find(v => v.id === 'voucher-belongs-to-B').status).toBe('DRAFT')
    expect(s.journal_entries).toHaveLength(0)
    expect(s.journal_lines).toHaveLength(0)
  })

  test('G: nonexistent voucher gives the same safe response as a cross-company voucher', async () => {
    const s = setup()
    addCompanyBVoucher(s)

    let crossCompanyErr, nonexistentErr
    try { await PostingEngine.post('voucher-belongs-to-B', COMPANY_A, USER_A, null) } catch (e) { crossCompanyErr = e }
    try { await PostingEngine.post('totally-made-up-id',   COMPANY_A, USER_A, null) } catch (e) { nonexistentErr  = e }

    expect(crossCompanyErr.status).toBe(nonexistentErr.status)
    expect(crossCompanyErr.message).toBe(nonexistentErr.message)
  })

  test('E: Company A user CAN post their own Company A voucher (no regression)', async () => {
    const s = setup()
    addCompanyAVoucher(s)

    const result = await PostingEngine.post('voucher-belongs-to-A', COMPANY_A, USER_A, null)

    expect(result.journal_entry).toBeDefined()
    expect(s.vouchers.find(v => v.id === 'voucher-belongs-to-A').status).toBe('POSTED')
    expect(s.journal_entries.length).toBeGreaterThan(0)
  })

})

// ─── B. REVERSE ─────────────────────────────────────────────────────────────

describe('Cross-company IDOR — PostingEngine.reverse()', () => {

  test('B: Company A user cannot REVERSE a Company B voucher', async () => {
    const s = setup()
    const v = addCompanyBVoucher(s, { status: 'POSTED' })
    s.journal_entries.push({
      id: 'je-B-1', company_id: COMPANY_B, voucher_id: v.id,
      total_debit: 500, total_credit: 500, event_type: 'POSTED',
    })

    await expect(PostingEngine.reverse('voucher-belongs-to-B', COMPANY_A, USER_A, 'fraudulent attempt', null))
      .rejects.toMatchObject({ status: 404 })

    // Original voucher and journal entry remain unchanged; no reversal artifacts created.
    expect(s.vouchers.find(vv => vv.id === 'voucher-belongs-to-B').status).toBe('POSTED')
    expect(s.journal_entries).toHaveLength(1)
    expect(s.vouchers).toHaveLength(1) // no reversal voucher was inserted
  })

  test('G: nonexistent voucher gives the same safe response as a cross-company voucher (reverse)', async () => {
    const s = setup()
    addCompanyBVoucher(s, { status: 'POSTED' })

    let crossCompanyErr, nonexistentErr
    try { await PostingEngine.reverse('voucher-belongs-to-B', COMPANY_A, USER_A, 'x', null) } catch (e) { crossCompanyErr = e }
    try { await PostingEngine.reverse('totally-made-up-id',   COMPANY_A, USER_A, 'x', null) } catch (e) { nonexistentErr  = e }

    expect(crossCompanyErr.status).toBe(nonexistentErr.status)
    expect(crossCompanyErr.message).toBe(nonexistentErr.message)
  })

  test('E: Company A user CAN reverse their own posted Company A voucher (no regression)', async () => {
    const s = setup()
    const v = addCompanyAVoucher(s, { status: 'POSTED' })
    s.journal_entries.push({
      id: 'je-A-1', company_id: COMPANY_A, voucher_id: v.id,
      total_debit: 750, total_credit: 750, event_type: 'POSTED',
    })

    const result = await PostingEngine.reverse('voucher-belongs-to-A', COMPANY_A, USER_A, 'correction', null)

    expect(result.reversal_voucher).toBeDefined()
    expect(s.vouchers.find(vv => vv.id === 'voucher-belongs-to-A').status).toBe('REVERSED')
  })

})

// ─── C. CANCEL ───────────────────────────────────────────────────────────────

describe('Cross-company IDOR — VoucherService.cancel()', () => {

  test('C: Company A user cannot CANCEL a Company B voucher', async () => {
    const s = setup()
    addCompanyBVoucher(s) // DRAFT

    await expect(VoucherService.cancel('voucher-belongs-to-B', COMPANY_A, USER_A, 'not my voucher', null))
      .rejects.toMatchObject({ status: 404 })

    expect(s.vouchers.find(v => v.id === 'voucher-belongs-to-B').status).toBe('DRAFT')
  })

  test('G: nonexistent voucher gives the same safe response as a cross-company voucher (cancel)', async () => {
    const s = setup()
    addCompanyBVoucher(s)

    let crossCompanyErr, nonexistentErr
    try { await VoucherService.cancel('voucher-belongs-to-B', COMPANY_A, USER_A, 'x', null) } catch (e) { crossCompanyErr = e }
    try { await VoucherService.cancel('totally-made-up-id',   COMPANY_A, USER_A, 'x', null) } catch (e) { nonexistentErr  = e }

    expect(crossCompanyErr.status).toBe(nonexistentErr.status)
    expect(crossCompanyErr.message).toBe(nonexistentErr.message)
  })

  test('E: Company A user CAN cancel their own DRAFT Company A voucher (no regression)', async () => {
    const s = setup()
    addCompanyAVoucher(s) // DRAFT

    const result = await VoucherService.cancel('voucher-belongs-to-A', COMPANY_A, USER_A, 'mistake', null)

    expect(result.cancelled).toBe(true)
    expect(s.vouchers.find(v => v.id === 'voucher-belongs-to-A').status).toBe('CANCELLED')
  })

})

// ─── C2. POST /vouchers/:id/cancel — server-side permission gate ────────────
//
// VoucherService.cancel() enforces company ownership, but that alone doesn't
// stop ANY authenticated member of the right company from cancelling
// vouchers — the route must also require a permission, same as /post
// (post_vouchers) and /reverse (reverse_entries) already do. These tests
// exercise requirePermission('cancel_vouchers') exactly as Express calls it.

describe('Cancellation authorization — requirePermission(\'cancel_vouchers\')', () => {
  const { requirePermission } = require('../middleware/index')

  function mockRes() {
    const res = {}
    res.status = jest.fn(() => res)
    res.json   = jest.fn(() => res)
    return res
  }

  test('user WITH can_post_vouchers passes the cancel_vouchers gate', async () => {
    const s = setup()
    s.users = [{ id: USER_A, can_post_vouchers: true }]
    const req = { user: { id: USER_A }, companyId: COMPANY_A }
    const res = mockRes()
    const next = jest.fn()

    await requirePermission('cancel_vouchers')(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  test('user WITHOUT can_post_vouchers is rejected with 403 and never reaches the service (no mutation)', async () => {
    const s = setup()
    addCompanyAVoucher(s) // DRAFT — would be cancellable if the gate were skipped
    s.users = [{ id: USER_A, can_post_vouchers: false }]
    const req = { user: { id: USER_A }, companyId: COMPANY_A }
    const res = mockRes()
    const next = jest.fn()

    await requirePermission('cancel_vouchers')(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    // The gate short-circuits before VoucherService.cancel() is ever
    // invoked, so the voucher this unauthorized user targeted is untouched.
    expect(s.vouchers.find(v => v.id === 'voucher-belongs-to-A').status).toBe('DRAFT')
  })

  test('a full unauthorized request (no permission + wrong company) still yields zero mutation end-to-end', async () => {
    const s = setup()
    addCompanyBVoucher(s) // DRAFT, belongs to Company B
    s.users = [{ id: USER_A, can_post_vouchers: false }]
    const req = { user: { id: USER_A }, companyId: COMPANY_A }
    const res = mockRes()
    const next = jest.fn()

    await requirePermission('cancel_vouchers')(req, res, next)
    expect(next).not.toHaveBeenCalled() // permission gate stops it first

    // Even if it had, VoucherService.cancel() would independently stop it
    // on company ownership — belt-and-suspenders, verified directly:
    await expect(VoucherService.cancel('voucher-belongs-to-B', COMPANY_A, USER_A, 'x', null))
      .rejects.toMatchObject({ status: 404 })

    expect(s.vouchers.find(v => v.id === 'voucher-belongs-to-B').status).toBe('DRAFT')
  })
})

// ─── D. UPDATE / EDIT ────────────────────────────────────────────────────────

describe('Cross-company IDOR — VoucherEditService.edit()', () => {

  test('D: Company A user cannot UPDATE (edit) a Company B posted voucher', async () => {
    const s = setup()
    const v = addCompanyBVoucher(s, { status: 'POSTED' })
    s.journal_entries.push({ id: 'je-B-2', company_id: COMPANY_B, voucher_id: v.id, total_debit: 500, total_credit: 500 })

    await expect(VoucherEditService.edit({
      voucherId: 'voucher-belongs-to-B',
      companyId: COMPANY_A, // attacker's own company context
      userId: USER_A,
      reason: 'trying to tamper with another company\'s voucher',
      lines: [
        { account_id: 'b-acc-csh', debit: 999, credit: 0 },
        { account_id: 'b-acc-rev', debit: 0,   credit: 999 },
      ],
    }, null)).rejects.toMatchObject({ status: 404 })

    // Nothing about the victim voucher changed.
    const stillB = s.vouchers.find(vv => vv.id === 'voucher-belongs-to-B')
    expect(stillB.status).toBe('POSTED')
    expect(stillB.total_amount).not.toBe(999)
  })

})

// ─── F. Step-up token scoping ────────────────────────────────────────────────

describe('Cross-company IDOR — step-up token binding', () => {
  const { signStepUpToken, verifyStepUpToken } = require('../utils/stepUp')

  test('F: a step-up token minted for Company A does not verify for Company B', () => {
    const token = signStepUpToken({ userId: USER_A, companyId: COMPANY_A, action: 'voucherEdit' })

    const okForA = verifyStepUpToken(token, { userId: USER_A, companyId: COMPANY_A, strictAction: 'voucherEdit' })
    const okForB = verifyStepUpToken(token, { userId: USER_A, companyId: COMPANY_B, strictAction: 'voucherEdit' })

    expect(okForA).toBe(true)
    expect(okForB).toBe(false)
  })

  test('F: a step-up token minted for one action does not authorize a different strict action', () => {
    const token = signStepUpToken({ userId: USER_A, companyId: COMPANY_A, action: 'voucherEdit' })
    const okForReverse = verifyStepUpToken(token, { userId: USER_A, companyId: COMPANY_A, strictAction: 'reverseEntry' })
    expect(okForReverse).toBe(false)
  })
})
