/**
 * party-balance.test.js — Validation tests for Party Balance report
 *
 * Scenarios from spec:
 *   A: Purchase 10,000 + Payment 4,000 → Supplier balance = 6,000
 *   B: Sale 20,000   + Receipt  7,000  → Customer balance = 13,000
 */
'use strict'

jest.mock('../src/db/knex', () => () => ({}))

const ReportingEngine = require('../src/engines/reportingEngine')

// ─── Mock DB ──────────────────────────────────────────────────────────────────
// Handles: where(obj), where(col,val), whereIn, pluck, sum, groupBy, orderBy,
// join (pre-merged), date comparisons, aliased column names (strip "alias.")

function stripAlias(col) {
  // 'jl.debit' → 'debit',  'p.company_id' → 'company_id'
  return typeof col === 'string' ? col.split('.').pop() : col
}

function matchesFilter(row, col, val) {
  if (typeof col === 'object' && col !== null) {
    return Object.entries(col).every(([k, v]) => row[stripAlias(k)] === v)
  }
  return row[stripAlias(col)] === val
}

function applyDateFilter(rows, col, op, val) {
  if (!val) return rows
  const c = stripAlias(col)
  return rows.filter(r => {
    if (!r[c]) return true   // no date → include
    if (op === '>=' ) return r[c] >= val
    if (op === '<=' ) return r[c] <= val
    if (op === '>'  ) return r[c] >  val
    if (op === '<'  ) return r[c] <  val
    return true
  })
}

function makeQB(getRows) {
  let _rows  = null
  let _group = null   // column name to group by (set by groupBy())

  const rows   = () => { if (_rows === null) _rows = [...getRows()]; return _rows }
  const filter = (fn) => { _rows = rows().filter(fn) }

  const qb = {
    where: (col, op, val) => {
      if (typeof col === 'function') return qb
      if (typeof col === 'object')  { filter(r => matchesFilter(r, col, null)); return qb }
      if (val === undefined)        { filter(r => matchesFilter(r, col, op));   return qb }
      _rows = applyDateFilter(rows(), col, op, val)
      return qb
    },
    andWhere: (col, op, val) => qb.where(col, op, val),
    whereIn:  (col, vals) => { filter(r => (vals||[]).includes(r[stripAlias(col)])); return qb },
    whereNull:(col)       => { filter(r => r[stripAlias(col)] == null); return qb },
    join:     ()          => qb,
    leftJoin: ()          => qb,
    orderBy:  ()          => qb,
    select:   ()          => qb,
    groupBy: (col) => { _group = stripAlias(col); return qb },
    pluck: (col) => Promise.resolve(rows().map(r => r[stripAlias(col)])),
    first: async () => rows()[0],
    then:  (fn) => fn ? fn(rows()) : Promise.resolve(rows()),
    sum: (colMap) => {
      const rs = rows()
      if (_group) {
        // GROUP BY aggregate: one result row per unique group value
        const groups = {}
        for (const r of rs) {
          const key = r[_group]
          if (!groups[key]) groups[key] = { [_group]: key }
          for (const [alias, col] of Object.entries(colMap)) {
            groups[key][alias] = (groups[key][alias] || 0) + Number(r[stripAlias(col)] || 0)
          }
        }
        _rows = Object.values(groups)
      } else {
        const result = {}
        for (const [alias, col] of Object.entries(colMap)) {
          result[alias] = rs.reduce((s, r) => s + Number(r[stripAlias(col)] || 0), 0)
        }
        _rows = [result]
      }
      return qb
    },
  }
  return qb
}

function makeMockDb(state) {
  return (table) => {
    const baseTable = table.split(' as ')[0].trim()

    if (baseTable === 'journal_lines') {
      // Pre-merge journal_entries onto journal_lines for JOIN queries
      const merged = (state.journal_lines || []).map(jl => {
        const je = (state.journal_entries || []).find(e => e.id === jl.journal_entry_id) || {}
        return { ...je, ...jl }
      })
      return makeQB(() => merged)
    }

    if (baseTable === 'parties') {
      return makeQB(() => state.parties || [])
    }

    return makeQB(() => state[baseTable] || [])
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CID         = 'company-1'
const SUPPLIER_ID = 'party-supplier'
const CUSTOMER_ID = 'party-customer'
const AR_ACC_ID   = 'acc-ar'
const AP_ACC_ID   = 'acc-ap'

function buildState() {
  return {
    parties: [
      { id: SUPPLIER_ID, company_id: CID, type: 'supplier', name: 'Test Supplier', code: 'S001', opening_balance: 0, is_active: true },
      { id: CUSTOMER_ID, company_id: CID, type: 'customer', name: 'Test Customer', code: 'C001', opening_balance: 0, is_active: true },
    ],
    accounts: [
      { id: AR_ACC_ID, company_id: CID, sub_type: 'accounts_receivable', is_active: true },
      { id: AP_ACC_ID, company_id: CID, sub_type: 'accounts_payable',    is_active: true },
    ],
    journal_entries: [
      { id: 'je-purchase', company_id: CID, entry_date: '2024-01-10' },
      { id: 'je-payment',  company_id: CID, entry_date: '2024-01-15' },
      { id: 'je-sale',     company_id: CID, entry_date: '2024-01-10' },
      { id: 'je-receipt',  company_id: CID, entry_date: '2024-01-20' },
    ],
    journal_lines: [
      // PURCHASE: CR AP 10,000  (increases supplier balance)
      { id: 'jl-1', journal_entry_id: 'je-purchase', account_id: AP_ACC_ID, party_id: SUPPLIER_ID, debit: 0,     credit: 10000 },
      // PAYMENT:  DR AP 4,000   (reduces supplier balance)
      { id: 'jl-2', journal_entry_id: 'je-payment',  account_id: AP_ACC_ID, party_id: SUPPLIER_ID, debit: 4000,  credit: 0     },
      // SALE:     DR AR 20,000  (increases customer balance)
      { id: 'jl-3', journal_entry_id: 'je-sale',     account_id: AR_ACC_ID, party_id: CUSTOMER_ID, debit: 20000, credit: 0     },
      // RECEIPT:  CR AR 7,000   (reduces customer balance)
      { id: 'jl-4', journal_entry_id: 'je-receipt',  account_id: AR_ACC_ID, party_id: CUSTOMER_ID, debit: 0,     credit: 7000  },
    ],
  }
}

// ─── Scenario A: Supplier ─────────────────────────────────────────────────────

describe('Scenario A — Supplier balance', () => {

  test('Purchase 10,000 + Payment 4,000 → balance = 6,000', async () => {
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'supplier', db: makeMockDb(buildState()),
    })
    expect(results).toHaveLength(1)
    expect(results[0].total_invoiced).toBe(10000)
    expect(results[0].total_paid).toBe(4000)
    expect(results[0].balance).toBe(6000)
  })

  test('Fully paid supplier: balance = 0', async () => {
    const state = buildState()
    state.journal_lines.push(
      { id: 'jl-5', journal_entry_id: 'je-payment', account_id: AP_ACC_ID, party_id: SUPPLIER_ID, debit: 6000, credit: 0 }
    )
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'supplier', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(0)
  })

  test('Overpaid supplier: balance = -2,000', async () => {
    const state = buildState()
    state.journal_lines.push(
      { id: 'jl-5', journal_entry_id: 'je-payment', account_id: AP_ACC_ID, party_id: SUPPLIER_ID, debit: 8000, credit: 0 }
    )
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'supplier', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(-2000)
  })

  test('Multiple purchases accumulate: 10,000 + 5,000 - 4,000 = 11,000', async () => {
    const state = buildState()
    state.journal_entries.push({ id: 'je-purchase2', company_id: CID, entry_date: '2024-01-12' })
    state.journal_lines.push(
      { id: 'jl-6', journal_entry_id: 'je-purchase2', account_id: AP_ACC_ID, party_id: SUPPLIER_ID, debit: 0, credit: 5000 }
    )
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'supplier', db: makeMockDb(state),
    })
    expect(results[0].total_invoiced).toBe(15000)
    expect(results[0].total_paid).toBe(4000)
    expect(results[0].balance).toBe(11000)
  })

})

// ─── Scenario B: Customer ─────────────────────────────────────────────────────

describe('Scenario B — Customer balance', () => {

  test('Sale 20,000 + Receipt 7,000 → balance = 13,000', async () => {
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(buildState()),
    })
    expect(results).toHaveLength(1)
    expect(results[0].total_invoiced).toBe(20000)
    expect(results[0].total_collected).toBe(7000)
    expect(results[0].balance).toBe(13000)
  })

  test('Fully collected customer: balance = 0', async () => {
    const state = buildState()
    state.journal_lines.push(
      { id: 'jl-5', journal_entry_id: 'je-receipt', account_id: AR_ACC_ID, party_id: CUSTOMER_ID, debit: 0, credit: 13000 }
    )
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(0)
  })

  test('Overpaid customer: balance = -5,000', async () => {
    const state = buildState()
    state.journal_lines.find(jl => jl.id === 'jl-4').credit = 25000
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(-5000)
  })

  test('Multiple receipts: 7,000 + 3,000 = 10,000 collected → balance = 10,000', async () => {
    const state = buildState()
    state.journal_entries.push({ id: 'je-receipt2', company_id: CID, entry_date: '2024-01-25' })
    state.journal_lines.push(
      { id: 'jl-5', journal_entry_id: 'je-receipt2', account_id: AR_ACC_ID, party_id: CUSTOMER_ID, debit: 0, credit: 3000 }
    )
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(state),
    })
    expect(results[0].total_collected).toBe(10000)
    expect(results[0].balance).toBe(10000)
  })

})

// ─── Combined and edge cases ──────────────────────────────────────────────────

describe('Combined and edge cases', () => {

  test('Both parties correct simultaneously', async () => {
    const results = await ReportingEngine.partyBalance(CID, { db: makeMockDb(buildState()) })
    expect(results).toHaveLength(2)
    const sup = results.find(p => p.id === SUPPLIER_ID)
    const cus = results.find(p => p.id === CUSTOMER_ID)
    expect(sup.balance).toBe(6000)
    expect(cus.balance).toBe(13000)
  })

  test('Opening balance is included in final balance', async () => {
    const state = buildState()
    state.parties.find(p => p.id === CUSTOMER_ID).opening_balance = 500
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(13500)  // 500 + 20,000 − 7,000
  })

  test('Zero opening balance + no transactions → balance = 0', async () => {
    const state = buildState()
    state.journal_lines = []
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(0)
    expect(results[0].total_invoiced).toBe(0)
    expect(results[0].total_collected).toBe(0)
  })

  test('Opening balance only (no journal entries) → balance = opening', async () => {
    const state = buildState()
    state.parties.find(p => p.id === CUSTOMER_ID).opening_balance = 1500
    state.journal_lines = state.journal_lines.filter(jl => jl.party_id !== CUSTOMER_ID)
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer', db: makeMockDb(state),
    })
    expect(results[0].balance).toBe(1500)
  })

  test('Date filter: receipt on 2024-01-20 excluded when dateTo=2024-01-18', async () => {
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer',
      dateTo:    '2024-01-18',
      db: makeMockDb(buildState()),
    })
    expect(results[0].total_invoiced).toBe(20000)   // sale on Jan 10 included
    expect(results[0].total_collected).toBe(0)       // receipt on Jan 20 excluded
    expect(results[0].balance).toBe(20000)
  })

  test('Date filter: dateFrom excludes earlier transactions', async () => {
    const results = await ReportingEngine.partyBalance(CID, {
      partyType: 'customer',
      dateFrom:  '2024-01-15',   // sale on Jan 10 excluded; receipt on Jan 20 included
      db: makeMockDb(buildState()),
    })
    expect(results[0].total_invoiced).toBe(0)
    expect(results[0].total_collected).toBe(7000)
    expect(results[0].balance).toBe(-7000)   // opening 0 + 0 invoiced - 7,000 collected
  })

  test('Mathematical identity: balance = opening + invoiced - collected/paid', async () => {
    const results = await ReportingEngine.partyBalance(CID, { db: makeMockDb(buildState()) })
    for (const p of results) {
      const opening = Number(p.opening_balance) || 0
      if (p.type === 'customer') {
        expect(p.balance).toBe(opening + p.total_invoiced - p.total_collected)
      } else {
        expect(p.balance).toBe(opening + p.total_invoiced - p.total_paid)
      }
    }
  })

})
