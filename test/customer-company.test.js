/** customer-company.test.js — pure calculation + CSV tests for the Customer vs Company report. */
'use strict'
jest.mock('../src/db/knex', () => () => ({}))
jest.mock('../src/services/partyBalanceService', () => ({ getBalances: async () => new Map() }))
const { buildCompanyRows, toCSV, NO_COMPANY } = require('../src/services/customerCompanyService')

const sales   = new Map([['Cipla', { sales: 1030, discount: 115 }], ['Sun', { sales: 1000, discount: 0 }], [NO_COMPANY, { sales: 100, discount: 0 }]])
const returns = new Map([['Cipla', { sr: 270, sre: 0 }], ['Sun', { sr: 0, sre: 200 }], ['Zydus', { sr: 50, sre: 0 }]])   // Zydus: returns but no sales

describe('buildCompanyRows', () => {
  it('Net = Sales − Discount − Sales Return − SR Expiry per company (discount deducted once)', () => {
    const { rows } = buildCompanyRows({ sales, returns })
    expect(rows.find(r => r.company === 'Cipla')).toMatchObject({ sales: 1030, discount: 115, sales_return: 270, net: 645 })
    expect(rows.find(r => r.company === 'Sun')).toMatchObject({ sales_return_expiry: 200, net: 800 })
  })
  it('includes companies that only have returns', () => {
    expect(buildCompanyRows({ sales, returns }).rows.find(r => r.company === 'Zydus')).toMatchObject({ sales: 0, sales_return: 50, net: -50 })
  })
  it('sorts alphabetically with "No Company" last', () => {
    expect(buildCompanyRows({ sales, returns }).rows.map(r => r.company)).toEqual(['Cipla', 'Sun', 'Zydus', NO_COMPANY])
  })
  it('totals equal the sum of the rows and reconcile with the formula', () => {
    const { rows, totals } = buildCompanyRows({ sales, returns })
    expect(totals).toEqual({ sales: 2130, discount: 115, sales_return: 320, sales_return_expiry: 200, net: 1495 })
    expect(totals.net).toBe(Math.round(rows.reduce((a, r) => a + r.net, 0) * 100) / 100)
    expect(totals.sales - totals.discount - totals.sales_return - totals.sales_return_expiry).toBe(totals.net)
  })
  it('empty input and all-zero companies produce no rows', () => {
    expect(buildCompanyRows({ sales: new Map(), returns: new Map() })).toEqual({ rows: [], totals: { sales: 0, discount: 0, sales_return: 0, sales_return_expiry: 0, net: 0 } })
    expect(buildCompanyRows({ sales: new Map([['X', { sales: 0, discount: 0 }]]), returns: new Map() }).rows).toEqual([])
  })
  it('rounds to 2 decimals', () => {
    expect(buildCompanyRows({ sales: new Map([['A', { sales: 0.1 + 0.2, discount: 0 }]]), returns: new Map() }).rows[0].sales).toBe(0.3)
  })
})

describe('toCSV', () => {
  it('header block, 6 columns in order, escaped names and a Total row', () => {
    const rep = { customer: { code: 'D1', name: 'Delta, "Med"' }, filters: { from: '2026-05-01', to: '2026-05-31' },
      ledger: { opening_balance: 1000, receipts: 0, closing_balance: 3015 },
      rows: [{ company: 'Cipla', sales: 1030, discount: 115, sales_return: 270, sales_return_expiry: 0, net: 645 }],
      totals: { sales: 1030, discount: 115, sales_return: 270, sales_return_expiry: 0, net: 645 } }
    const lines = toCSV(rep).replace('\uFEFF', '').trim().split('\r\n')
    expect(lines[1]).toContain('"Delta, ""Med"""'); expect(lines[2]).toBe('Opening Balance,1000.00,Receipts,0.00,Closing Balance,3015.00')
    expect(lines[4]).toBe('Company,Sales,Discount,Sales Return,Sales Return Expiry,Net')
    expect(lines[5]).toBe('Cipla,1030.00,115.00,270.00,0.00,645.00'); expect(lines[6]).toBe('Total,1030.00,115.00,270.00,0.00,645.00')
  })
})
