/** company-customer.test.js — pure calculation tests for the Company vs Customer report. */
'use strict'
jest.mock('../src/db/knex', () => () => ({}))
const { buildRows, toCSV } = require('../src/services/companyCustomerService')

const parties = new Map([['a', { code: 'C1', name: 'Alpha', credit_limit: 0 }], ['b', { code: 'C2', name: 'Beta', credit_limit: 1000 }]])
const sales   = new Map([['a', { sales: 1000, discount: 100 }], ['_walkin', { sales: 30, discount: 15 }]])
const returns = new Map([['a', { sr: 200, sre: 50 }], ['b', { sr: 30, sre: 0 }]])   // b: returns but no sales

describe('buildRows', () => {
  it('Net = Sales − Discount − SR − SR Expiry (discount deducted once)', () => {
    const { rows, totals } = buildRows({ sales, returns, parties, discountExcluded: false })
    expect(rows.find(r => r.customer_code === 'C1').net).toBe(650)
    expect(totals).toEqual({ sales: 1030, discount: 115, sales_return: 230, sales_return_expiry: 50, net: 635 })
    expect(totals.sales - totals.discount - totals.sales_return - totals.sales_return_expiry).toBe(totals.net)
  })
  it('Discount Excluded keeps the Discount column but does not deduct it', () => {
    const { rows, totals } = buildRows({ sales, returns, parties, discountExcluded: true })
    expect(rows.find(r => r.customer_code === 'C1')).toMatchObject({ discount: 100, net: 750 })
    expect(totals.discount).toBe(115); expect(totals.net).toBe(750)
  })
  it('includes customers with returns but no sales, and walk-in sales', () => {
    const { rows } = buildRows({ sales, returns, parties, discountExcluded: false })
    expect(rows.find(r => r.customer_code === 'C2')).toMatchObject({ sales: 0, sales_return: 30, net: -30, customer_type: 'credit' })
    expect(rows.find(r => r.customer_id === null).customer_name).toMatch(/Walk-in/)
  })
  it('drops customers removed by the customer-type filter and empty rows', () => {
    const only = new Map([['b', parties.get('b')]])
    expect(buildRows({ sales: new Map([['a', sales.get('a')]]), returns, parties: only, discountExcluded: false }).rows.map(r => r.customer_code)).toEqual(['C2'])   // C1 filtered out upstream by customer type
    expect(buildRows({ sales: new Map(), returns: new Map(), parties, discountExcluded: false })).toEqual({ rows: [], totals: { sales: 0, discount: 0, sales_return: 0, sales_return_expiry: 0, net: 0 } })
  })
  it('rounds to 2 dp and totals equal the sum of displayed rows', () => {
    const s = new Map([['a', { sales: 0.1 + 0.2, discount: 0.005 }]])
    const { rows, totals } = buildRows({ sales: s, returns: new Map(), parties, discountExcluded: false })
    expect(rows[0].sales).toBe(0.3); expect(totals.net).toBe(rows[0].net)
  })
})

describe('toCSV', () => {
  it('has the 7 columns in order, a Total row and the active filters', () => {
    const rep = { filters: { from: '2026-05-01', to: '2026-05-31', company: 'Cipla', customer_type: 'credit', discount_excluded: true },
      rows: [{ customer_code: 'C1', customer_name: 'Alpha, Ltd', sales: 1000, discount: 100, sales_return: 200, sales_return_expiry: 50, net: 750 }],
      totals: { sales: 1000, discount: 100, sales_return: 200, sales_return_expiry: 50, net: 750 } }
    const lines = toCSV(rep).replace('\uFEFF', '').trim().split('\r\n')
    expect(lines[1]).toContain('Credit Customer'); expect(lines[1]).toContain('Yes')
    expect(lines[3]).toBe('Customer Code,Particular,Sales,Discount,Sales Return,Sales Return Expiry,Net')
    expect(lines[4]).toBe('C1,"Alpha, Ltd",1000.00,100.00,200.00,50.00,750.00')
    expect(lines[5]).toBe(',Total,1000.00,100.00,200.00,50.00,750.00')
  })
})
