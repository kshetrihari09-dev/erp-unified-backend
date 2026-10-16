/** company-customer.test.js — pure calculation tests for the Company vs Customer report. */
'use strict'
jest.mock('../src/db/knex', () => () => ({}))
jest.mock('../src/services/partyBalanceService', () => ({ getBalances: async () => new Map() }))
const { buildRows, toCSV } = require('../src/services/companyCustomerService')

const parties = new Map([['a', { code: 'C1', name: 'Alpha', credit_limit: 0 }], ['b', { code: 'C2', name: 'Beta', credit_limit: 1000 }]])
const sales   = new Map([['a', { sales: 1000, discount: 100 }], ['_walkin', { sales: 30, discount: 15 }]])
const returns = new Map([['a', { sr: 200, sre: 50 }], ['b', { sr: 30, sre: 0 }]])   // b: returns but no sales

describe('buildRows', () => {
  it('Net = Sales − Discount − SR − SR Expiry (discount deducted once)', () => {
    const { rows, totals } = buildRows({ sales, returns, parties })
    expect(rows.find(r => r.customer_code === 'C1').net).toBe(650)
    expect(totals).toMatchObject({ sales: 1030, discount: 115, sales_return: 230, sales_return_expiry: 50, net: 635 })
    expect(totals.sales - totals.discount - totals.sales_return - totals.sales_return_expiry).toBe(totals.net)
  })
  it('includes customers with returns but no sales, and walk-in sales', () => {
    const { rows } = buildRows({ sales, returns, parties })
    expect(rows.find(r => r.customer_code === 'C2')).toMatchObject({ sales: 0, sales_return: 30, net: -30, customer_type: 'credit' })
    expect(rows.find(r => r.customer_id === null).customer_name).toMatch(/Walk-in/)
  })
  it('drops customers removed by the customer-type filter and empty rows', () => {
    const only = new Map([['b', parties.get('b')]])
    expect(buildRows({ sales: new Map([['a', sales.get('a')]]), returns, parties: only }).rows.map(r => r.customer_code)).toEqual(['C2'])   // C1 filtered out upstream by customer type
    const empty = buildRows({ sales: new Map(), returns: new Map(), parties })
    expect(empty.rows).toEqual([]); expect(empty.totals).toMatchObject({ sales: 0, discount: 0, sales_return: 0, sales_return_expiry: 0, net: 0, opening_balance: 0, closing_balance: 0 })
  })
  it('rounds to 2 dp and totals equal the sum of displayed rows', () => {
    const s = new Map([['a', { sales: 0.1 + 0.2, discount: 0.005 }]])
    const { rows, totals } = buildRows({ sales: s, returns: new Map(), parties })
    expect(rows[0].sales).toBe(0.3); expect(totals.net).toBe(rows[0].net)
  })
})

describe('buildRows — opening / receipts / closing (ledger columns)', () => {
  const bal = new Map([
    ['a', { opening_balance: 11000, receipts: 600, period_movement: -100, closing_balance: 10900 }],
    ['b', { opening_balance: 5000,  receipts: 0,   period_movement: 0,    closing_balance: 5000 }],    // balance only, no sales
  ])
  it('keeps Opening/Receipts/Closing separate from Sales and Net (nothing added or deducted twice)', () => {
    const { rows } = buildRows({ sales, returns, parties, balances: bal })
    expect(rows.find(r => r.customer_code === 'C1')).toMatchObject({ opening_balance: 11000, sales: 1000, net: 650, receipts: 600, closing_balance: 10900 })
  })
  it('lists balance-only customers only when asked (not for a single-company view)', () => {
    const only = { sales: new Map(), returns: new Map(), parties, balances: bal }
    expect(buildRows({ ...only, includeBalanceOnly: false }).rows).toEqual([])
    const r = buildRows({ ...only, includeBalanceOnly: true }).rows
    expect(r.map(x => x.customer_code).sort()).toEqual(['C1', 'C2'])
    expect(r.find(x => x.customer_code === 'C2')).toMatchObject({ opening_balance: 5000, sales: 0, closing_balance: 5000 })
  })
  it('totals reconcile with the rows: Σ closing = Σ opening + Σ ledger movement', () => {
    const { rows, totals } = buildRows({ sales: new Map(), returns: new Map(), parties, balances: bal, includeBalanceOnly: true })
    for (const k of ['opening_balance', 'receipts', 'closing_balance', 'ledger_movement']) expect(totals[k]).toBe(Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100)
    expect(totals.closing_balance).toBe(totals.opening_balance + totals.ledger_movement)
  })
  it('a zero-balance, zero-activity customer is not listed', () => {
    const z = new Map([['a', { opening_balance: 0, receipts: 0, period_movement: 0, closing_balance: 0 }]])
    expect(buildRows({ sales: new Map(), returns: new Map(), parties, balances: z, includeBalanceOnly: true }).rows).toEqual([])
  })
})

describe('toCSV', () => {
  it('has the 7 columns in order, a Total row and the active filters', () => {
    const rep = { filters: { from: '2026-05-01', to: '2026-05-31', company: 'Cipla', customer_type: 'credit' },
      rows: [{ customer_code: 'C1', customer_name: 'Alpha, Ltd', opening_balance: 11000, sales: 1000, discount: 100, sales_return: 200, sales_return_expiry: 50, net: 750, receipts: 600, closing_balance: 10900 }],
      totals: { opening_balance: 11000, sales: 1000, discount: 100, sales_return: 200, sales_return_expiry: 50, net: 750, receipts: 600, closing_balance: 10900 } }
    const lines = toCSV(rep).replace('\uFEFF', '').trim().split('\r\n')
    expect(lines[1]).toContain('Credit Customer'); expect(lines[1]).not.toMatch(/Discount Excluded/)
    expect(lines[3]).toBe('Customer Code,Particular,Opening Balance,Sales,Discount,Sales Return,Sales Return Expiry,Net,Receipts,Closing Balance')
    expect(lines[4]).toBe('C1,"Alpha, Ltd",11000.00,1000.00,100.00,200.00,50.00,750.00,600.00,10900.00')
    expect(lines[5]).toBe(',Total,11000.00,1000.00,100.00,200.00,50.00,750.00,600.00,10900.00')
  })
})
