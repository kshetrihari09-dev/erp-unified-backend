/**
 * party-balance.test.js — contract tests for partyBalanceService input handling and
 * the balance formula. (The SQL itself is exercised against a real Postgres in the manual test plan.)
 */
'use strict'
const mockRaw = jest.fn()
jest.mock('../src/db/knex', () => Object.assign(() => ({}), { raw: (...a) => mockRaw(...a), schema: { hasTable: async () => true } }))
const { getBalances } = require('../src/services/partyBalanceService')

const row = (o) => ({ party_id: 'p', type: 'customer', opening_balance: 10000, pre_debit: 3000, pre_credit: 2000, per_debit: 500, per_credit: 600, receipts: 600, ...o })

describe('getBalances — formula', () => {
  beforeEach(() => mockRaw.mockReset())
  it('customer: opening = initial + Σdebit − Σcredit before From; closing = opening + period movement', async () => {
    mockRaw.mockResolvedValue({ rows: [row()] })
    const b = (await getBalances('c', { from: '2026-05-01', to: '2026-05-31' })).get('p')
    expect(b).toMatchObject({ initial_opening: 10000, before_movement: 1000, opening_balance: 11000, period_movement: -100, closing_balance: 10900, receipts: 600 })
  })
  it('supplier uses credit − debit (payable)', async () => {
    mockRaw.mockResolvedValue({ rows: [row({ type: 'supplier', opening_balance: 8000, pre_debit: 1500, pre_credit: 4000, per_debit: 0, per_credit: 0 })] })
    expect((await getBalances('c', { from: '2026-05-01' })).get('p')).toMatchObject({ opening_balance: 10500, closing_balance: 10500 })
  })
  it('no transactions → opening equals the original opening balance; negative (advance) opening is preserved', async () => {
    mockRaw.mockResolvedValue({ rows: [row({ opening_balance: -1000, pre_debit: 0, pre_credit: 0, per_debit: 0, per_credit: 0, receipts: 0 })] })
    expect((await getBalances('c', { from: '2026-05-01' })).get('p')).toMatchObject({ opening_balance: -1000, closing_balance: -1000 })
  })
  it('rounds to 2 decimals', async () => {
    mockRaw.mockResolvedValue({ rows: [row({ opening_balance: 0.1, pre_debit: 0.2, pre_credit: 0, per_debit: 0, per_credit: 0 })] })
    expect((await getBalances('c', { from: '2026-05-01' })).get('p').opening_balance).toBe(0.3)
  })
})

describe('getBalances — validation and parameter binding', () => {
  beforeEach(() => { mockRaw.mockReset(); mockRaw.mockResolvedValue({ rows: [] }) })
  it('rejects malformed dates and inverted ranges before touching the database', async () => {
    await expect(getBalances('c', { from: "2026-05-01'; DROP TABLE parties;--" })).rejects.toThrow(/YYYY-MM-DD/)
    await expect(getBalances('c', { from: '01/05/2026' })).rejects.toThrow(/YYYY-MM-DD/)
    await expect(getBalances('c', { from: '2026-06-01', to: '2026-05-01' })).rejects.toThrow(/cannot be after/)
    expect(mockRaw).not.toHaveBeenCalled()
  })
  it('passes every value as a bound parameter, never inside the SQL text', async () => {
    await getBalances('company-1', { from: '2026-05-01', to: '2026-05-31', partyId: 'party-9', partyType: 'customer' })
    const [sql, bind] = mockRaw.mock.calls[0]
    expect(bind).toEqual({ cid: 'company-1', from: '2026-05-01', to: '2026-05-31', pid: 'party-9', ptype: 'customer' })
    for (const v of ['company-1', '2026-05-01', 'party-9']) expect(sql).not.toContain(v)
  })
  it('treats From as the first day of the period: movements strictly before it are "opening"', async () => {
    await getBalances('c', { from: '2026-05-01' })
    const sql = mockRaw.mock.calls[0][0]
    expect(sql).toMatch(/mv\.dt <\s+CAST\(:from AS date\)/); expect(sql).toMatch(/mv\.dt >= CAST\(:from AS date\)/); expect(sql).toMatch(/mv\.dt <= CAST\(:to AS date\)/)
  })
})
