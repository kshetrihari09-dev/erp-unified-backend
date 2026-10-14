/**
 * stock-register.test.js — pure calculation + CSV tests for the Stock Register.
 * (The SQL itself is exercised against a real Postgres in the manual test plan.)
 */
'use strict'
jest.mock('../src/db/knex', () => () => ({}))
const { buildRegister, toCSV } = require('../src/services/stockRegisterService')

describe('buildRegister — running balance', () => {
  const rows = [
    { ty: 'PU',  qty_in: 50, qty_out: 0,  qty_free: 5, free_effect: 1 },   // +55
    { ty: 'SL',  qty_in: 0,  qty_out: 30, qty_free: 2, free_effect: 0 },   // -30 (sale bonus never leaves stock)
    { ty: 'SRN', qty_in: 4,  qty_out: 0,  qty_free: 0, free_effect: 1 },   // +4
    { ty: 'PRN', qty_in: 0,  qty_out: 6,  qty_free: 0, free_effect: 1 },   // -6
  ]
  it('starts from the opening balance and applies every movement', () => {
    const r = buildRegister(100, rows)
    expect(r.rows.map(x => x.balance)).toEqual([155, 125, 129, 123])
    expect(r.closing).toBe(123)
  })
  it('tracks free quantity separately in totals', () => {
    const r = buildRegister(0, rows)
    expect(r.totals).toEqual({ qty_in: 54, qty_out: 36, qty_free: 7 })
  })
  it('handles an empty range (closing = opening)', () => {
    const r = buildRegister(42.5, [])
    expect(r.rows).toEqual([]); expect(r.closing).toBe(42.5)
  })
  it('does not accumulate floating-point drift', () => {
    const many = Array.from({ length: 10 }, () => ({ qty_in: 0.1, qty_out: 0, qty_free: 0, free_effect: 1 }))
    expect(buildRegister(0, many).closing).toBe(1)
  })
})

describe('toCSV', () => {
  const rep = {
    product: { item_code: 'P001', name: 'Para, "500"' },
    filters: { from: '2026-02-10', to: null, store: 'all' },
    opening_balance: 155,
    rows: [{ date: '2026-02-10', inv_no: 'SI-1', batch: 'B1', particular: 'OM PRAKASH', narration: '', ty: 'SL', qty_in: 0, qty_out: 30, balance: 125, qty_free: 2, rate: 20, store: 'Main Store', mrp: 25, expiry: '12/27' }],
    totals: { qty_in: 0, qty_out: 30, qty_free: 2, closing_balance: 125 },
  }
  it('has the 14 columns in order, opening row, escaped values and totals', () => {
    const lines = toCSV(rep).replace('\uFEFF', '').trim().split('\r\n')
    expect(lines[4]).toBe('Date,Inv No.,Batch,Particular,Narration,Ty,In,Out,Bal,Free,Rate,Store,MRP,Expiry')
    expect(lines[0]).toBe('Stock Register')
    expect(lines[1]).toContain('"Para, ""500"""')
    expect(lines[5]).toContain('Opening Balance')
    expect(lines[6]).toBe('2026-02-10,SI-1,B1,OM PRAKASH,,SL,0,30,125,2,20,Main Store,25,12/27')
    expect(lines[7]).toContain('Total')
  })
})
