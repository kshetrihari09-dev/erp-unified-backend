/**
 * voucher-edit.integration.test.js — regression tests for editing POSTED
 * Receipt / Payment vouchers.
 *
 * Runs the REAL stack — express routes (authenticate → requirePermission →
 * requireStepUp), VoucherEditService, PostingEngine, the real migrations and
 * the real append-only/immutability triggers — against a throwaway Postgres
 * database that this file creates and drops itself. It never touches your
 * development database.
 *
 * Needs a reachable PostgreSQL server (credentials from .env / DB_* vars,
 * user must be allowed to CREATE DATABASE). If none is reachable the suite is
 * skipped with a notice; set REQUIRE_DB_TESTS=1 (e.g. in CI) to make that a
 * hard failure instead.
 *
 * Scenarios (spec §16): A amount · B account · C party · D date ·
 * E repeated edits · F party balance · G voucher detail · H failed edit,
 * plus: step-up still enforced, reversal dated at the entry it cancels,
 * no sequence number burned, public reverse after edits, concurrency,
 * and journal hash-chain integrity.
 */
'use strict'

const path = require('path')
const { spawnSync } = require('child_process')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest'

const PG = {
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
}
const TEST_DB = `voucher_edit_test_${process.pid}`
process.env.VE_TEST_DB = TEST_DB
process.env.VE_PG = JSON.stringify(PG)

// Is a Postgres server reachable at all?  (sync probe so we can choose describe vs describe.skip)
const probe = spawnSync(process.execPath, ['-e', `
  const { Client } = require('pg');
  const c = new Client({ ...${JSON.stringify(PG)}, database: 'postgres', connectionTimeoutMillis: 4000 });
  c.connect().then(() => c.end().then(() => process.exit(0))).catch(() => process.exit(1));
`], { cwd: path.join(__dirname, '..'), timeout: 10000 })
const dbAvailable = probe.status === 0
if (!dbAvailable && !process.env.REQUIRE_DB_TESTS) {
  console.warn('[voucher-edit.integration] PostgreSQL not reachable — suite SKIPPED (set REQUIRE_DB_TESTS=1 to fail instead)')
}
const maybeDescribe = (dbAvailable || process.env.REQUIRE_DB_TESTS) ? describe : describe.skip

// Point every service at the throwaway DB. (Factory may only use `require`/`process`.)
jest.mock('../src/db/knex', () => {
  const { types } = require('pg')
  types.setTypeParser(1082, v => v) // DATE → 'YYYY-MM-DD' string, same as production
  const knex = require('knex')
  const pg = JSON.parse(process.env.VE_PG)
  const db = knex({
    client: 'pg',
    connection: { ...pg, database: process.env.VE_TEST_DB },
    pool: { min: 0, max: 8 },
    searchPath: ['public'],
  })
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  db.setRLSContext = async (t, companyId) => {
    if (!UUID_RE.test(companyId)) throw new Error('bad companyId')
    await t.raw(`SET LOCAL app.current_company_id = '${companyId}'`)
  }
  db.withRLS = (companyId, fn) => db.transaction(async t => { await db.setRLSContext(t, companyId); return fn(t) })
  return db
})
// Fire-and-forget credit-risk recalculation is irrelevant here and would race teardown.
jest.mock('../src/services/creditRiskRecalc', () => ({ recalcCustomerAsync: () => {}, recalcCustomer: async () => {} }))

maybeDescribe('POSTED Receipt/Payment edit — everything stays in sync', () => {
  let db, app, request, jwt, signStepUpToken, ReportingEngine, PostingEngine, AuditLogger, VoucherService, verifyJournalChain
  let companyId, userId, token
  let CASH, BANK, AR, AP, ABC, XYZ, SUP, otherCompanyId

  // ───────────────────────────── setup / teardown ─────────────────────────────
  beforeAll(async () => {
    const { Client } = require('pg')
    const admin = new Client({ ...PG, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${TEST_DB}"`)
    await admin.end()

    const knex = require('knex')
    const migrator = knex({
      client: 'pg', connection: { ...PG, database: TEST_DB }, searchPath: ['public'],
      migrations: { directory: path.join(__dirname, '..', 'migrations'), tableName: 'knex_migrations' },
    })
    const log = console.log; console.log = () => {}            // migrations are chatty
    try { await migrator.migrate.latest() } finally { console.log = log; await migrator.destroy() }

    db = require('../src/db/knex')
    jwt = require('jsonwebtoken')
    ;({ signStepUpToken } = require('../src/utils/stepUp'))
    ReportingEngine = require('../src/engines/reportingEngine')
    PostingEngine   = require('../src/engines/postingEngine')
    AuditLogger     = require('../src/utils/auditLogger')
    VoucherService  = require('../src/services/voucherService')
    ;({ verifyJournalChain } = require('../src/utils/hashing'))
    request = require('supertest')

    const express = require('express')
    const { errorHandler } = require('../src/middleware/index')
    app = express()
    app.use(express.json())
    app.use('/accounting', require('../src/routes/accounting'))
    app.use('/parties', require('../src/routes/parties'))
    app.use('/reports', require('../src/routes/reports'))
    app.use(errorHandler)
    jest.spyOn(console, 'error').mockImplementation(() => {})   // errorHandler logs expected 4xx/5xx

    // ── fixtures ──
    ;[{ id: companyId }] = await db('companies').insert({ name: 'Edit Test Co' }).returning('id')
    ;[{ id: otherCompanyId }] = await db('companies').insert({ name: 'Other Co' }).returning('id')
    ;[{ id: userId }] = await db('users').insert({
      company_id: companyId, name: 'Owner', email: 'owner@test.local', role: 'owner', is_active: true,
      can_post_vouchers: true, can_reverse_entries: true,
    }).returning('id')
    await db('user_companies').insert({ user_id: userId, company_id: companyId, is_default: true })
    token = jwt.sign({ userId, companyId }, process.env.JWT_SECRET)

    const acct = async (code, name, type, sub_type, normal_balance) =>
      (await db('accounts').insert({ company_id: companyId, code, name, type, sub_type, normal_balance, is_group: false, is_active: true }).returning('id'))[0].id
    CASH = await acct('1010', 'Cash',               'asset',     'cash',       'debit')
    BANK = await acct('1020', 'Bank',               'asset',     'bank',       'debit')
    AR   = await acct('1200', 'Accounts Receivable','asset',     'receivable', 'debit')
    AP   = await acct('2100', 'Accounts Payable',   'liability', 'payable',    'credit')
    const party = async (code, name, type, control) =>
      (await db('parties').insert({ company_id: companyId, code, name, type, control_account_id: control, opening_balance: 0, is_active: true }).returning('id'))[0].id
    ABC = await party('C-001', 'ABC Traders', 'customer', AR)
    XYZ = await party('C-002', 'XYZ Stores',  'customer', AR)
    SUP = await party('S-001', 'Supplier One','supplier', AP)
    await db('accounting_periods').insert({ company_id: companyId, name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', is_locked: false })
  }, 120000)

  afterAll(async () => {
    if (db) await db.destroy()
    const { Client } = require('pg')
    const admin = new Client({ ...PG, database: 'postgres' })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`)
    await admin.end()
  }, 60000)

  afterEach(() => jest.restoreAllMocks() && jest.spyOn(console, 'error').mockImplementation(() => {}))

  // ───────────────────────────────── helpers ──────────────────────────────────
  const auth = (r, { stepUp = true } = {}) => {
    r.set('Authorization', `Bearer ${token}`)
    if (stepUp) r.set('X-Step-Up-Token', signStepUpToken({ userId, companyId, action: 'voucherEdit' }))
    return r
  }
  async function createVoucher(kind, { party = ABC, account = CASH, amount = 5000, date = '2026-09-25', narration = 'test' } = {}) {
    const res = await auth(request(app).post(`/accounting/${kind}`), { stepUp: false })
      .send({ party_id: party, account_id: account, amount, date, narration })
    expect(res.status).toBe(201)
    return res.body.data.id
  }
  const createReceipt = (o) => createVoucher('receipts', o)
  const createPayment = (o) => createVoucher('payments', { party: SUP, ...o })
  async function edit(kind, id, o, opts) {
    const res = await auth(request(app).put(`/accounting/${kind}/${id}/edit`), opts).send({
      reason: 'test edit', party_id: o.party ?? ABC, account_id: o.account ?? CASH,
      amount: o.amount, date: o.date ?? '2026-09-25', narration: o.narration ?? 'test',
    })
    return res
  }
  const editReceipt = (id, o, opts) => edit('receipts', id, o, opts)
  const editPayment = (id, o, opts) => edit('payments', id, { party: SUP, ...o }, opts)

  const get = async (url) => (await auth(request(app).get(url), { stepUp: false })).body
  const accountLedger = async (accountId, q = '') => (await get(`/accounting/ledger/${accountId}${q}`)).data
  const rowsFor = (ledger, voucherId) => ledger.rows.filter(r => r.voucher_id === voucherId)
  const partyLedgerRows = async (partyId, q = '') =>
    ((await get(`/parties/${partyId}/ledger${q}`)).data.rows || []).filter(r => r.type !== 'opening')
  const partyBalance = async (partyId) => (await get('/reports/party-balance')).data.data.find(p => p.id === partyId)
  const detail = async (id) => (await get(`/accounting/vouchers/${id}`)).data
  const dbVoucher = (id) => db('vouchers').where({ id }).first()
  const dbLines = (id) => db('voucher_lines').where({ voucher_id: id }).orderBy('line_no')
  const journalCount = async () => Number((await db('journal_entries').where({ company_id: companyId }).count('id as c'))[0].c)
  // Net (debit − credit) of an account as of a date, summed from journal_lines — the same
  // basis the Trial Balance / P&L / Balance Sheet use. (The TB's Dr/Cr columns clamp a
  // credit balance on a debit-normal account to 0, so they can't be read as a signed net.)
  async function cashBankNet(accountId, asOf) {
    return (await ReportingEngine.getAccountBalance(db, accountId, companyId, asOf)).balance
  }
  async function expectJournalBalanced() {
    const [t] = await db('journal_lines as jl').join('journal_entries as je', 'jl.journal_entry_id', 'je.id')
      .where('je.company_id', companyId).sum({ dr: 'jl.debit', cr: 'jl.credit' })
    expect(Number(t.dr)).toBe(Number(t.cr))
    const tb = await ReportingEngine.trialBalance(companyId, { asOfDate: '2026-12-31' })   // must not throw
    expect(tb.rows.length).toBeGreaterThan(0)
  }

  // ═════════════════════════════════ TESTS ════════════════════════════════════

  test('A — amount 5,000 → 7,000: every read model shows 7,000, no 5,000 / 12,000 residue', async () => {
    const id = await createReceipt({ amount: 5000 })
    expect(rowsFor(await accountLedger(CASH), id).map(r => Number(r.debit))).toEqual([5000])

    const res = await editReceipt(id, { amount: 7000 })
    expect(res.status).toBe(200)

    // edit response itself carries the CURRENT state
    expect(Number(res.body.data.voucher.total_amount)).toBe(7000)
    expect(res.body.data.lines.map(l => Number(l.debit) + Number(l.credit))).toEqual([7000, 7000])
    expect(Number(res.body.data.journal_entry.total_debit)).toBe(7000)

    // voucher row + lines
    expect(Number((await dbVoucher(id)).total_amount)).toBe(7000)
    expect((await dbLines(id)).map(l => Number(l.debit) + Number(l.credit))).toEqual([7000, 7000])
    // receipts list
    const list = (await get('/accounting/receipts')).data
    expect(list.filter(v => v.id === id).map(v => Number(v.total_amount))).toEqual([7000])
    // account ledger: exactly one row, 7,000
    expect(rowsFor(await accountLedger(CASH), id).map(r => Number(r.debit))).toEqual([7000])
    // party ledger: credit 7,000 exactly once
    const pl = (await partyLedgerRows(ABC)).filter(r => r.type === 'RECEIPT')
    expect(pl.map(r => Number(r.credit))).toEqual([7000])
    // party balance
    expect((await partyBalance(ABC)).balance).toBe(-7000)
    // trial balance (as of today): cash holds 7,000, AR -7,000
    expect(await cashBankNet(CASH, '2026-12-31')).toBe(7000)
    expect(await cashBankNet(AR, '2026-12-31')).toBe(-7000)
  })

  test('B — account Cash → Bank: Cash ledger loses it, Bank ledger has it once; form/detail reopen on Bank', async () => {
    const id = await createReceipt({ amount: 7000, account: CASH })
    await editReceipt(id, { amount: 7000, account: BANK })

    expect(rowsFor(await accountLedger(CASH), id)).toHaveLength(0)
    expect(rowsFor(await accountLedger(BANK), id).map(r => Number(r.debit))).toEqual([7000])

    // voucher_lines: Bank is the debit account, Cash is gone
    const lines = await dbLines(id)
    expect(lines.find(l => Number(l.debit) > 0).account_id).toBe(BANK)
    expect(lines.some(l => l.account_id === CASH)).toBe(false)

    // GET detail ("Received Into" derivation in ReceiptsTab = first debit line) shows Bank,
    // and its journal info identifies the CURRENT posting on Bank
    const d = await detail(id)
    expect(d.lines.find(l => Number(l.debit) > 0).account_id).toBe(BANK)
    expect(d.journal_lines.find(l => Number(l.debit) > 0).account_id).toBe(BANK)

  })

  test('B2 — Payment: Paid From Cash → Bank behaves the same', async () => {
    const id = await createPayment({ amount: 3000, account: CASH })
    expect(rowsFor(await accountLedger(CASH), id).map(r => Number(r.credit))).toEqual([3000])

    await editPayment(id, { amount: 4500, account: BANK })
    expect(rowsFor(await accountLedger(CASH), id)).toHaveLength(0)
    expect(rowsFor(await accountLedger(BANK), id).map(r => Number(r.credit))).toEqual([4500])

    const d = await detail(id)
    expect(d.lines.find(l => Number(l.credit) > 0).account_id).toBe(BANK) // "Paid From"
    expect(Number(d.voucher.total_amount)).toBe(4500)
    const pl = (await partyLedgerRows(SUP)).filter(r => r.type === 'PAYMENT')
    expect(pl.filter(r => r.reference === d.voucher.voucher_no).map(r => Number(r.debit))).toEqual([4500])
  })

  test('C — party ABC → XYZ: ABC loses the receipt, XYZ gets it once', async () => {
    const id = await createReceipt({ party: ABC, amount: 5000 })
    const before = await partyBalance(ABC)
    await editReceipt(id, { party: XYZ, amount: 7000 })

    const no = (await dbVoucher(id)).voucher_no
    expect((await partyLedgerRows(ABC)).filter(r => r.reference === no)).toHaveLength(0)
    expect((await partyLedgerRows(XYZ)).filter(r => r.reference === no).map(r => Number(r.credit))).toEqual([7000])
    expect((await dbVoucher(id)).party_id).toBe(XYZ)

    // balances: ABC no longer includes it, XYZ does
    expect((await partyBalance(ABC)).balance).toBe(before.balance + 5000)
    // account ledger row now names the new party
    const row = rowsFor(await accountLedger(CASH), id)
    expect(row).toHaveLength(1)
    expect(row[0].party_name).toBe('XYZ Stores')
    // AR control account: still exactly one credit row of 7,000
    expect(rowsFor(await accountLedger(AR), id).map(r => Number(r.credit))).toEqual([7000])
  })

  test('D — date 2026-09-25 → 2026-10-02 moves the transaction everywhere (incl. period reports)', async () => {
    const id = await createReceipt({ amount: 5000, date: '2026-09-25' })
    const sep = '?date_from=2026-09-01&date_to=2026-09-30'
    const oct = '?date_from=2026-10-01&date_to=2026-10-31'
    expect(rowsFor(await accountLedger(CASH, sep), id)).toHaveLength(1)

    const sepBefore = await cashBankNet(CASH, '2026-09-30')
    const res = await editReceipt(id, { amount: 5000, date: '2026-10-02' })
    expect(res.status).toBe(200)
    expect(String((await dbVoucher(id)).voucher_date).slice(0, 10)).toBe('2026-10-02')

    // account ledger
    expect(rowsFor(await accountLedger(CASH, sep), id)).toHaveLength(0)
    expect(rowsFor(await accountLedger(CASH, oct), id).map(r => r.voucher_date)).toEqual(['2026-10-02'])
    // party ledger
    const no = (await dbVoucher(id)).voucher_no
    expect((await partyLedgerRows(ABC, sep)).filter(r => r.reference === no)).toHaveLength(0)
    expect((await partyLedgerRows(ABC, oct)).filter(r => r.reference === no)).toHaveLength(1)
    // voucher list date filter
    const inSep = (await get('/accounting/receipts?date_from=2026-09-01&date_to=2026-09-30')).data
    const inOct = (await get('/accounting/receipts?date_from=2026-10-01&date_to=2026-10-31')).data
    expect(inSep.some(v => v.id === id)).toBe(false)
    expect(inOct.some(v => v.id === id)).toBe(true)
    // period-bucketed REPORT: September no longer contains this receipt, because the
    // internal reversal is dated at the ORIGINAL entry (old amount nets to zero in Sept).
    expect(await cashBankNet(CASH, '2026-09-30')).toBe(sepBefore - 5000)
    expect(await cashBankNet(CASH, '2026-10-31')).toBe(sepBefore) // back once October is included
  })

  test('E — repeated edits 5,000 Cash → 7,000 Bank → 9,000 Cash → 12,000 Bank ends as exactly 12,000 Bank', async () => {
    const cashStart = await cashBankNet(CASH, '2026-12-31')
    const bankStart = await cashBankNet(BANK, '2026-12-31')
    const id = await createReceipt({ amount: 5000, account: CASH })
    await editReceipt(id, { amount: 7000,  account: BANK })
    await editReceipt(id, { amount: 9000,  account: CASH })
    const res = await editReceipt(id, { amount: 12000, account: BANK })
    expect(res.status).toBe(200)

    expect(Number((await dbVoucher(id)).total_amount)).toBe(12000)
    expect(rowsFor(await accountLedger(CASH), id)).toHaveLength(0)
    expect(rowsFor(await accountLedger(BANK), id).map(r => Number(r.debit))).toEqual([12000])
    // net balances: only the final 12,000 on Bank, nothing accumulated on Cash
    expect(await cashBankNet(CASH, '2026-12-31')).toBe(cashStart)
    expect(await cashBankNet(BANK, '2026-12-31')).toBe(bankStart + 12000)
    expect(rowsFor(await accountLedger(AR), id).map(r => Number(r.credit))).toEqual([12000])

    // each edit reversed the PREVIOUS anchor, not the original
    const meta = (await dbVoucher(id)).metadata
    expect(meta.ledger_correction.correction_count).toBe(3)
    expect(meta.ledger_correction.superseded_entry_voucher_ids).toHaveLength(3)
    expect(meta.ledger_correction.superseded_entry_voucher_ids[0]).toBe(id) // original first
    const d = await detail(id)
    expect(d.journal_entry.voucher_id).toBe(meta.ledger_correction.active_entry_voucher_id)
    // exactly ONE current financial effect → the books still balance & chain verifies
    await expectJournalBalanced()
    expect((await verifyJournalChain(db, companyId)).valid).toBe(true)
  })

  test('F — party balance has no duplicate after edit', async () => {
    const start = (await partyBalance(ABC)).balance
    const id = await createReceipt({ amount: 5000 })
    expect((await partyBalance(ABC)).balance).toBe(start - 5000)
    await editReceipt(id, { amount: 7000 })
    expect((await partyBalance(ABC)).balance).toBe(start - 7000)
    await editReceipt(id, { amount: 2000 })
    expect((await partyBalance(ABC)).balance).toBe(start - 2000)
    // journal-derived AR for this voucher agrees with the party balance
    expect(rowsFor(await accountLedger(AR), id).map(r => Number(r.credit))).toEqual([2000])
  })

  test('G — GET /accounting/vouchers/:id returns CURRENT accounting info, not the obsolete original entry', async () => {
    const id = await createReceipt({ amount: 5000, account: CASH })
    const original = await db('journal_entries').where({ voucher_id: id }).first()
    expect(Number((await detail(id)).journal_entry.total_debit)).toBe(5000)           // unedited → own entry
    expect((await detail(id)).accounting.is_corrected).toBe(false)

    await editReceipt(id, { amount: 12000, account: BANK, date: '2026-10-02' })
    const d = await detail(id)
    const anchorId = (await dbVoucher(id)).metadata.ledger_correction.active_entry_voucher_id

    expect(Number(d.voucher.total_amount)).toBe(12000)
    expect(d.voucher.party_id).toBe(ABC)
    expect(String(d.voucher.voucher_date).slice(0, 10)).toBe('2026-10-02')
    expect(d.lines.find(l => Number(l.debit) > 0)).toMatchObject({ account_id: BANK })
    expect(Number(d.lines.find(l => Number(l.debit) > 0).debit)).toBe(12000)

    expect(d.journal_entry.voucher_id).toBe(anchorId)
    expect(d.journal_entry.id).not.toBe(original.id)          // NOT the stale original
    expect(Number(d.journal_entry.total_debit)).toBe(12000)
    expect(String(d.journal_entry.entry_date).slice(0, 10)).toBe('2026-10-02')
    expect(d.journal_lines.find(l => Number(l.debit) > 0).account_id).toBe(BANK)
    expect(d.accounting).toMatchObject({ active_entry_voucher_id: anchorId, is_corrected: true, correction_count: 1 })
    // the internal anchor is never a normal, user-visible voucher
    const visible = (await get('/accounting/vouchers?limit=200')).data
    expect(visible.some(v => String(v.voucher_no).startsWith('SYS-CORR'))).toBe(false)
    expect(visible.some(v => v.voucher_no && v.voucher_no.startsWith('REV-'))).toBe(false)
    // voucher-postings / posting-status also resolve the current entry
    const ps = (await get(`/accounting/posting-status/RECEIPT/${id}`)).data
    expect(ps.journal_entry_id).toBe(d.journal_entry.id)
    expect(Number(ps.total_debit)).toBe(12000)
  })

  describe('H — failed edit leaves NO partial state', () => {
    async function snapshot(id) {
      return {
        voucher: await dbVoucher(id),
        lines: await dbLines(id),
        journal: await journalCount(),
        vouchers: Number((await db('vouchers').where({ company_id: companyId }).count('id as c'))[0].c),
        cashRows: rowsFor(await accountLedger(CASH), id).map(r => Number(r.debit)),
        bal: (await partyBalance(ABC)).balance,
      }
    }

    test('posting the correction fails → everything rolls back, voucher still editable', async () => {
      const id = await createReceipt({ amount: 5000 })
      const before = await snapshot(id)

      jest.spyOn(PostingEngine, 'postInTransaction').mockRejectedValueOnce(new Error('boom: forced posting failure'))
      const res = await editReceipt(id, { amount: 7000, account: BANK })
      expect(res.status).toBeGreaterThanOrEqual(400)

      const after = await snapshot(id)
      expect(after.voucher.status).toBe('POSTED')                     // never left REVERSED
      expect(Number(after.voucher.total_amount)).toBe(5000)
      expect(after.voucher.metadata?.ledger_correction).toBeUndefined()
      expect(after.lines.map(l => [l.account_id, Number(l.debit), Number(l.credit)]))
        .toEqual(before.lines.map(l => [l.account_id, Number(l.debit), Number(l.credit)]))
      expect(after.journal).toBe(before.journal)                      // no reversal / correction entries
      expect(after.vouchers).toBe(before.vouchers)                    // no stray anchor/reversal vouchers
      expect(after.cashRows).toEqual([5000])
      expect(after.bal).toBe(before.bal)
      // forensic trace of the failed attempt, no EDIT_VOUCHER
      const audit = await db('audit_log').where({ entity_id: id }).whereIn('action', ['EDIT_VOUCHER', 'EDIT_VOUCHER_FAILED'])
      expect(audit.map(a => a.action)).toEqual(['EDIT_VOUCHER_FAILED'])

      // and the voucher is NOT bricked (old code left a COMPLETED reverse in processing_log)
      jest.restoreAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {})
      const retry = await editReceipt(id, { amount: 7000, account: BANK })
      expect(retry.status).toBe(200)
      expect(rowsFor(await accountLedger(BANK), id).map(r => Number(r.debit))).toEqual([7000])
    })

    test('audit write fails (last step) → the whole edit, including the new entry, is rolled back', async () => {
      const id = await createReceipt({ amount: 5000 })
      const before = await snapshot(id)

      jest.spyOn(AuditLogger, 'logStrict').mockRejectedValueOnce(new Error('boom: audit insert failed'))
      const res = await editReceipt(id, { amount: 9999, account: BANK })
      expect(res.status).toBeGreaterThanOrEqual(400)

      const after = await snapshot(id)
      expect(Number(after.voucher.total_amount)).toBe(5000)
      expect(after.journal).toBe(before.journal)
      expect(after.vouchers).toBe(before.vouchers)
      expect(after.cashRows).toEqual([5000])
      expect(after.bal).toBe(before.bal)
    })

    test('invalid input is rejected before anything is written', async () => {
      const id = await createReceipt({ amount: 5000 })
      const before = await snapshot(id)
      expect((await editReceipt(id, { amount: 7000, date: 'not-a-date' })).status).toBe(400)
      expect((await editReceipt(id, { amount: 7000, account: '00000000-0000-4000-8000-000000000000' })).status).toBe(404)
      expect((await editReceipt(id, { amount: 7000, party: '00000000-0000-4000-8000-000000000000' })).status).toBe(404)
      expect((await editReceipt(id, { amount: -1 })).status).toBe(400)
      const after = await snapshot(id)
      expect(after.journal).toBe(before.journal)
      expect(Number(after.voucher.total_amount)).toBe(5000)
    })
  })

  // ──────────────────────────── guarantees we must keep ────────────────────────
  test('security: step-up is enforced server-side on receipt AND payment edit routes (and cannot be skipped)', async () => {
    const r = await createReceipt({ amount: 5000 })
    const p = await createPayment({ amount: 5000 })
    const noToken = await editReceipt(r, { amount: 6000 }, { stepUp: false })
    expect(noToken.status).toBe(400)
    expect(noToken.body.code).toBe('STEP_UP_REQUIRED')
    const noTokenPay = await editPayment(p, { amount: 6000 }, { stepUp: false })
    expect(noTokenPay.status).toBe(400)
    expect(noTokenPay.body.code).toBe('STEP_UP_REQUIRED')
    // a token minted for a DIFFERENT action must not satisfy it
    const wrong = await auth(request(app).put(`/accounting/receipts/${r}/edit`), { stepUp: false })
      .set('X-Step-Up-Token', signStepUpToken({ userId, companyId, action: 'somethingElse' }))
      .send({ reason: 'x', party_id: ABC, account_id: CASH, amount: 6000, date: '2026-09-25' })
    expect(wrong.status).toBe(400)
    expect(Number((await dbVoucher(r)).total_amount)).toBe(5000)
    // without edit_posted_vouchers permission → 403 even with a valid token
    await db('users').where({ id: userId }).update({ can_reverse_entries: false })
    expect((await editReceipt(r, { amount: 6000 })).status).toBe(403)
    await db('users').where({ id: userId }).update({ can_reverse_entries: true })
    expect(Number((await dbVoucher(r)).total_amount)).toBe(5000)
  })

  test('a receipt cannot be edited through the payment route (and vice versa)', async () => {
    const r = await createReceipt({ amount: 5000 })
    const res = await editPayment(r, { amount: 6000 })
    expect(res.status).toBe(400)
    expect(Number((await dbVoucher(r)).total_amount)).toBe(5000)
  })

  test('edit keeps voucher id + number, burns no sequence number, creates no user-visible voucher, writes one audit row', async () => {
    const id = await createReceipt({ amount: 5000 })
    const v0 = await dbVoucher(id)
    const seqBefore = await db('voucher_sequences').where({ company_id: companyId }).select('voucher_type', 'last_number')
    const countVisible = async () => (await get('/accounting/vouchers?limit=500')).data.length

    const n0 = await countVisible()
    await editReceipt(id, { amount: 7000 })
    await editReceipt(id, { amount: 8000, account: BANK })

    const v1 = await dbVoucher(id)
    expect(v1.id).toBe(v0.id)
    expect(v1.voucher_no).toBe(v0.voucher_no)
    expect(v1.status).toBe('POSTED')
    expect(await countVisible()).toBe(n0)
    expect(await db('voucher_sequences').where({ company_id: companyId }).select('voucher_type', 'last_number')).toEqual(seqBefore)
    const audits = await db('audit_log').where({ entity_id: id, action: 'EDIT_VOUCHER' }).orderBy('created_at')
    expect(audits).toHaveLength(2)
    expect(audits[0].payload_before.total_amount).toBeDefined()
    expect(Number(audits[1].payload_after.total_amount)).toBe(8000)
    // edit history endpoint still works
    const hist = (await get(`/accounting/vouchers/${id}/edit-history`)).data
    expect(hist.filter(h => h.action === 'EDIT_VOUCHER')).toHaveLength(2)
  })

  test('immutable journal is never UPDATEd/DELETEd — corrections are reverse + repost', async () => {
    const id = await createReceipt({ amount: 5000 })
    const original = await db('journal_entries').where({ voucher_id: id }).first()
    await editReceipt(id, { amount: 7000 })
    const still = await db('journal_entries').where({ id: original.id }).first()
    expect(Number(still.total_debit)).toBe(5000)                       // untouched
    const reversal = await db('journal_entries').where({ reversed_entry_id: original.id }).first()
    expect(reversal).toBeTruthy()
    expect(Number(reversal.total_credit)).toBe(5000)
    expect(String(reversal.entry_date).slice(0, 10)).toBe(String(original.entry_date).slice(0, 10)) // dated at the entry it cancels
    await expect(db('journal_entries').where({ id: original.id }).update({ narration: 'tamper' })).rejects.toThrow(/immutable/i)
    // voucher_postings: still exactly one row, still pointing at the visible voucher
    const vp = await db('voucher_postings').where({ voucher_id: id })
    expect(vp).toHaveLength(1)
    expect(vp[0].source_type).toBe('RECEIPT')
  })

  test('public Reverse after edits reverses the LIVE entry (not the stale original) → zero effect', async () => {
    const cashStart = await cashBankNet(CASH, '2026-12-31')
    const arStart = await cashBankNet(AR, '2026-12-31')
    const id = await createReceipt({ amount: 5000, account: CASH })
    await editReceipt(id, { amount: 7000, account: BANK })
    const res = await auth(request(app).post(`/accounting/vouchers/${id}/reverse`), { stepUp: false }).send({ reason: 'cancel it' })
    expect(res.status).toBe(200)
    expect((await dbVoucher(id)).status).toBe('REVERSED')
    expect(await cashBankNet(CASH, '2026-12-31')).toBe(cashStart)
    expect(await cashBankNet(AR, '2026-12-31')).toBe(arStart)
    // Bank ledger: the live 7,000 receipt row plus its public-reversal row net to zero
    const rev = await db('vouchers').where({ reversal_of: id }).where('voucher_no', 'like', 'REV-%').first() // the PUBLIC reversal (edit reversals are SYS-CORR-*)
    const ledger = await accountLedger(BANK)
    const mine = ledger.rows.filter(r => r.voucher_id === id || r.voucher_id === rev.id)
    expect(mine).toHaveLength(2)
    expect(mine.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0)).toBe(0)
    // the reversal reversed the LIVE (7,000 Bank) entry — not the stale 5,000 Cash original
    expect(Number(rev.total_amount)).toBe(7000)
    await expectJournalBalanced()
  })

  test('concurrent edits of the same voucher serialise: one current effect, books balanced, chain valid', async () => {
    const id = await createReceipt({ amount: 1000, account: CASH })
    const results = await Promise.all([
      editReceipt(id, { amount: 2000, account: BANK }),
      editReceipt(id, { amount: 3000, account: CASH }),
      editReceipt(id, { amount: 4000, account: BANK }),
    ])
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
    const v = await dbVoucher(id)
    expect(v.metadata.ledger_correction.correction_count).toBe(3)
    const cash = rowsFor(await accountLedger(CASH), id)
    const bank = rowsFor(await accountLedger(BANK), id)
    expect(cash.length + bank.length).toBe(1)                         // exactly ONE current effect
    expect(Number((cash[0] || bank[0]).debit)).toBe(Number(v.total_amount))
    await expectJournalBalanced()
    expect((await verifyJournalChain(db, companyId)).valid).toBe(true)
  })

  test('company isolation: another company cannot edit this voucher', async () => {
    const id = await createReceipt({ amount: 5000 })
    const VoucherEditService = require('../src/services/voucherEditService')
    await expect(VoucherEditService.edit({
      voucherId: id, companyId: otherCompanyId, userId, reason: 'x',
      lines: [{ account_id: CASH, debit: 1, credit: 0 }, { account_id: AR, debit: 0, credit: 1 }],
    })).rejects.toMatchObject({ status: 404 })
    expect(Number((await dbVoucher(id)).total_amount)).toBe(5000)
  })
})
