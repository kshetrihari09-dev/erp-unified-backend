/**
 * reporting-engine-ledger.test.js — Regression tests for the "edited Receipt
 * doesn't update in the Ledger" bug.
 *
 * `ReportingEngine.ledger()` fetches two sets of rows from the DB (the
 * account's original postings, plus any vouchers newly pointing at the
 * account because of an edit) and hands them to
 * `mergeAndPaginateLedgerRows()` — a pure function with no DB involved —
 * to patch, filter, sort, paginate, and compute running balances. That pure
 * function is exactly where the bug lived, so these tests exercise it
 * directly with hand-built fixtures shaped exactly like the two queries in
 * ledger() (engines/reportingEngine.js) select.
 *
 * Covers the six scenarios from the spec (§22):
 *   1. Amount edited
 *   2. Party edited
 *   3. Account edited (Cash → Bank)
 *   4. Date edited (date-range membership)
 *   5. Multiple edits in a row
 *   6. A never-edited voucher is untouched
 */
'use strict'

const { mergeAndPaginateLedgerRows } = require('../src/engines/reportingEngine')

const CASH_ACCOUNT_ID = 'acc-cash'
const BANK_ACCOUNT_ID = 'acc-bank'
const AR_ACCOUNT_ID   = 'acc-ar'
const CUSTOMER_A_ID   = 'party-abc'
const CUSTOMER_B_ID   = 'party-xyz'

// A row exactly as ledger()'s query A (original postings) selects it.
function originalRow(overrides = {}) {
  return {
    event_type: 'POSTED', period_ref: null,
    voucher_id: 'v-1', voucher_no: 'REC-001', voucher_type: 'RECEIPT', reference_no: null,
    voucher_date: '2026-09-20', sort_key: '2026-09-20T10:00:00.000Z',
    account_id: CASH_ACCOUNT_ID, debit: 5000, credit: 0, description: 'Payment received',
    party_name: 'ABC Traders', is_edited: false,
    ...overrides,
  }
}

const NO_MOVED_IN = []
const NO_PARTY_NAMES = new Map()

describe('mergeAndPaginateLedgerRows — Test 1: Amount', () => {
  test('5,000 → 7,000: ledger shows 7,000, exactly one row, no duplicate', () => {
    const original = [originalRow({ is_edited: true })] // frozen at 5,000 forever
    const currentByVoucher = new Map([
      ['v-1', { voucher_id: 'v-1', debit: 7000, credit: 0, description: 'Payment received', party_id: null }],
    ])

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher, voucherPartyIdById: new Map([['v-1', CUSTOMER_A_ID]]),
      partyNameById: new Map([[CUSTOMER_A_ID, 'ABC Traders']]),
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].debit).toBe(7000)
    expect(result.total_debit).toBe(7000)
    expect(result.closing_balance).toBe(7000) // not 5000, not 12000
  })
})

describe('mergeAndPaginateLedgerRows — Test 2: Party', () => {
  test('ABC → XYZ: the row now shows the new party name', () => {
    const original = [originalRow({ is_edited: true, party_name: 'ABC Traders' })]
    const currentByVoucher = new Map([
      ['v-1', { voucher_id: 'v-1', debit: 5000, credit: 0, description: 'Payment received', party_id: CUSTOMER_B_ID }],
    ])

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher, voucherPartyIdById: new Map([['v-1', CUSTOMER_B_ID]]),
      partyNameById: new Map([[CUSTOMER_A_ID, 'ABC Traders'], [CUSTOMER_B_ID, 'XYZ Traders']]),
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].party_name).toBe('XYZ Traders')
  })
})

describe('mergeAndPaginateLedgerRows — Test 3: Account (Cash → Bank)', () => {
  test('Cash ledger: the old posting disappears once the account changes away', () => {
    // Cash's original query found this voucher (it WAS posted to Cash), but
    // the voucher's current voucher_lines no longer has a Cash line at all
    // — currentByVoucher has nothing for it — because the edit moved the
    // whole line to Bank.
    const original = [originalRow({ is_edited: true, account_id: CASH_ACCOUNT_ID })]

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher: new Map(), // nothing current on the Cash account for v-1
      voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })

    expect(result.rows).toHaveLength(0)
    expect(result.closing_balance).toBe(0)
  })

  test('Bank ledger: the voucher now appears, even though it never originally posted to Bank', () => {
    // Bank's query A finds nothing (this voucher never touched Bank
    // originally) — it only shows up via query B ("moved in").
    const movedIn = [{
      voucher_id: 'v-1', voucher_no: 'REC-001', voucher_type: 'RECEIPT', reference_no: null,
      voucher_date: '2026-09-20', sort_key: '2026-09-20T10:00:00.000Z',
      account_id: BANK_ACCOUNT_ID, debit: 5000, credit: 0, description: 'Payment received',
      line_party_id: null, voucher_party_id: CUSTOMER_A_ID, line_party_name: null,
    }]

    const result = mergeAndPaginateLedgerRows({
      originalRows: [], movedIn,
      currentByVoucher: new Map(), voucherPartyIdById: new Map(),
      partyNameById: new Map([[CUSTOMER_A_ID, 'ABC Traders']]),
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].account_id).toBe(BANK_ACCOUNT_ID)
    expect(result.rows[0].debit).toBe(5000)
    expect(result.rows[0].party_name).toBe('ABC Traders')
  })

  test('An oscillating edit (Cash → Bank → Cash) is not double-counted on the Cash ledger', () => {
    // Original posting WAS Cash; current voucher_lines is ALSO Cash again
    // (it bounced through Bank and back) — this must be treated as a normal
    // in-place amount/whatever correction, not a "moved away + moved back"
    // double entry.
    const original = [originalRow({ is_edited: true, account_id: CASH_ACCOUNT_ID, debit: 5000 })]
    const currentByVoucher = new Map([
      ['v-1', { voucher_id: 'v-1', debit: 5000, credit: 0, description: 'Payment received', party_id: null }],
    ])

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN, // query B correctly finds nothing: journal_lines DOES have this account
      currentByVoucher, voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].debit).toBe(5000)
  })
})

describe('mergeAndPaginateLedgerRows — Test 4: Date', () => {
  test('2026-09-20 → 2026-10-05: gone from the September window', () => {
    // voucher_date on the row IS the current, corrected date (it's read off
    // live `vouchers.voucher_date`, not the frozen journal_entries.entry_date
    // — see ledger()'s query A) — so this is what an edited row's date looks
    // like once fetched, no extra patch needed.
    const original = [originalRow({ is_edited: true, voucher_date: '2026-10-05' })]
    const currentByVoucher = new Map([
      ['v-1', { voucher_id: 'v-1', debit: 5000, credit: 0, description: 'Payment received', party_id: null }],
    ])

    const septResult = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher, voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: '2026-09-01', dateTo: '2026-09-30', page: 1, limit: 100,
    })
    expect(septResult.rows).toHaveLength(0)

    const octResult = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher, voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: '2026-10-01', dateTo: '2026-10-31', page: 1, limit: 100,
    })
    expect(octResult.rows).toHaveLength(1)
    expect(octResult.rows[0].entry_date).toBe('2026-10-05')
  })

  test('Opening balance picks up a transaction whose edited date now falls before the window', () => {
    const original = [originalRow({ is_edited: true, voucher_date: '2026-08-15', debit: 5000 })]
    const currentByVoucher = new Map([
      ['v-1', { voucher_id: 'v-1', debit: 5000, credit: 0, description: 'Payment received', party_id: null }],
    ])

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher, voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: '2026-09-01', dateTo: '2026-09-30', page: 1, limit: 100,
    })
    expect(result.rows).toHaveLength(0)
    expect(result.opening_balance).toBe(5000)
  })
})

describe('mergeAndPaginateLedgerRows — Test 5: Multiple edits', () => {
  test('5,000 → 7,000 → 9,000: final ledger shows 9,000, no cumulative duplicate', () => {
    // voucher_lines only ever holds the CURRENT state — the 7,000
    // intermediate value has already been overwritten in the DB by the time
    // this query runs, same as real life.
    const original = [originalRow({ is_edited: true, debit: 5000 })]
    const currentByVoucher = new Map([
      ['v-1', { voucher_id: 'v-1', debit: 9000, credit: 0, description: 'Payment received', party_id: null }],
    ])

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher, voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].debit).toBe(9000)
    expect(result.closing_balance).toBe(9000)
  })
})

describe('mergeAndPaginateLedgerRows — Test 6: Never edited', () => {
  test('A plain, un-edited voucher passes through unchanged', () => {
    const original = [originalRow({ is_edited: false, debit: 5000 })]

    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher: new Map(), voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].debit).toBe(5000)
    expect(result.rows[0].party_name).toBe('ABC Traders') // untouched original value
  })

  test('"Failed edit" simulation: no audit_log entry means the frozen row is trusted as-is', () => {
    // If an edit attempt failed and rolled back, no EDIT_VOUCHER audit_log
    // row exists, so is_edited is false and the original posting — still
    // correct — is what's shown. This models §22 Test 6's expectation at
    // the read side: a failed edit leaves the ledger exactly as it was.
    const original = [originalRow({ is_edited: false, debit: 5000, voucher_date: '2026-09-20' })]
    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher: new Map(), voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: '2026-09-01', dateTo: '2026-09-30', page: 1, limit: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].debit).toBe(5000)
    expect(result.rows[0].entry_date).toBe('2026-09-20')
  })
})

describe('mergeAndPaginateLedgerRows — running balance & pagination', () => {
  test('running balance accumulates opening + each row in date order', () => {
    const original = [
      originalRow({ voucher_id: 'v-1', voucher_date: '2026-09-05', debit: 1000, credit: 0, sort_key: '2026-09-05T09:00:00Z' }),
      originalRow({ voucher_id: 'v-2', voucher_date: '2026-09-10', debit: 0, credit: 300,  sort_key: '2026-09-10T09:00:00Z' }),
      originalRow({ voucher_id: 'v-3', voucher_date: '2026-08-01', debit: 500, credit: 0,  sort_key: '2026-08-01T09:00:00Z' }), // before the window
    ]
    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher: new Map(), voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: '2026-09-01', dateTo: '2026-09-30', page: 1, limit: 100,
    })
    expect(result.opening_balance).toBe(500) // the August row
    expect(result.rows.map(r => r.running_balance)).toEqual([1500, 1200])
    expect(result.closing_balance).toBe(1200)
  })

  test('rows within the same date are ordered by insertion (sort_key)', () => {
    const original = [
      originalRow({ voucher_id: 'v-2', voucher_date: '2026-09-10', sort_key: '2026-09-10T15:00:00Z' }),
      originalRow({ voucher_id: 'v-1', voucher_date: '2026-09-10', sort_key: '2026-09-10T09:00:00Z' }),
    ]
    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher: new Map(), voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: null, dateTo: null, page: 1, limit: 100,
    })
    expect(result.rows.map(r => r.voucher_id)).toEqual(['v-1', 'v-2'])
  })

  test('page/limit slice the in-window rows', () => {
    const original = [1, 2, 3, 4, 5].map(n => originalRow({
      voucher_id: `v-${n}`, voucher_date: `2026-09-0${n}`, sort_key: `2026-09-0${n}T09:00:00Z`, debit: n * 100,
    }))
    const result = mergeAndPaginateLedgerRows({
      originalRows: original, movedIn: NO_MOVED_IN,
      currentByVoucher: new Map(), voucherPartyIdById: new Map(), partyNameById: NO_PARTY_NAMES,
      dateFrom: null, dateTo: null, page: 2, limit: 2,
    })
    expect(result.total).toBe(5)
    expect(result.rows.map(r => r.voucher_id)).toEqual(['v-3', 'v-4'])
  })
})
