/**
 * ReportingEngine — Bank-grade financial reports using PostgreSQL CTEs.
 *
 * Key design principles:
 *   - All balances DERIVED from journal_lines (never stored)
 *   - As-of-date filtering (point-in-time reporting)
 *   - Account hierarchy aggregation (parent totals = sum of children)
 *   - All queries run on immutable journal_lines table
 *   - Uses CTEs for clarity and PostgreSQL query optimizer
 */

const db = require('../db/knex')
const config = require('../config')
const { scopeToCurrentEntries } = require('../services/currentEntry')

/**
 * Pure merge/patch/paginate step for ReportingEngine.ledger() — deliberately
 * factored out of the DB-querying method above so the actual bug-fix logic
 * (an edited voucher's CURRENT figures replacing its frozen original
 * journal_lines row; an account change dropping the old row and picking up
 * the new one; date-range membership following the corrected date) can be
 * unit-tested against plain fixtures, with no database involved. See
 * test/reporting-engine-ledger.test.js.
 *
 * `originalRows` / `movedIn` are exactly what the two queries in ledger()
 * select (see there for shape). `currentByVoucher` / `voucherPartyIdById` /
 * `partyNameById` are the Maps built from voucher_lines/vouchers/parties for
 * whichever voucher ids came back `is_edited`.
 */
function mergeAndPaginateLedgerRows({
  originalRows, movedIn, currentByVoucher, voucherPartyIdById, partyNameById,
  dateFrom, dateTo, page = 1, limit = 100,
}) {
  // Patch each originally-posted row with the voucher's CURRENT figures;
  // drop rows whose account changed away from this one (no current line
  // for this account means the edit moved it elsewhere).
  const patched = []
  for (const r of originalRows) {
    if (!r.is_edited) { patched.push(r); continue }
    const current = currentByVoucher.get(r.voucher_id)
    if (!current) continue // account changed away — no longer belongs on this ledger
    const effectivePartyId = current.party_id || voucherPartyIdById.get(r.voucher_id) || null
    patched.push({
      ...r,
      debit: current.debit,
      credit: current.credit,
      description: current.description ?? r.description,
      party_name: effectivePartyId ? (partyNameById.get(effectivePartyId) ?? null) : null,
    })
  }

  for (const r of movedIn) {
    const effectivePartyId = r.line_party_id || r.voucher_party_id || null
    const partyName = effectivePartyId ? (partyNameById.get(effectivePartyId) ?? r.line_party_name ?? null) : null
    patched.push({
      event_type: 'POSTED', period_ref: null,
      voucher_id: r.voucher_id, voucher_no: r.voucher_no, voucher_type: r.voucher_type, reference_no: r.reference_no,
      voucher_date: r.voucher_date, sort_key: r.sort_key,
      account_id: r.account_id, debit: r.debit, credit: r.credit, description: r.description,
      party_name: partyName, is_edited: true,
    })
  }

  // ── Split into "before the window" (opening balance) vs "in the window"
  //    (displayed rows), using each row's CURRENT voucher_date — this is
  //    what makes an edited date correctly move a transaction between
  //    date-range windows instead of staying pinned to its original date. ──
  const beforeWindow = dateFrom ? patched.filter(r => String(r.voucher_date) < dateFrom) : []
  const inWindow = patched.filter(r =>
    (!dateFrom || String(r.voucher_date) >= dateFrom) &&
    (!dateTo   || String(r.voucher_date) <= dateTo),
  )
  inWindow.sort((a, b) => {
    const d = String(a.voucher_date).localeCompare(String(b.voucher_date))
    if (d !== 0) return d
    // sort_key (vouchers.created_at) is a timestamp — compare as Date, not
    // as a locale string (Date#toString() month names don't sort
    // chronologically, e.g. "Apr" < "Jan" alphabetically).
    return new Date(a.sort_key || 0) - new Date(b.sort_key || 0)
  })

  const openingDr = beforeWindow.reduce((s, r) => s + Number(r.debit  || 0), 0)
  const openingCr = beforeWindow.reduce((s, r) => s + Number(r.credit || 0), 0)
  const openingBalance = openingDr - openingCr

  const count = inWindow.length
  const rows  = inWindow.slice((page - 1) * limit, (page - 1) * limit + limit)
    .map(r => ({ ...r, entry_date: r.voucher_date }))

  let runningBalance = openingBalance
  const ledgerRows = rows.map(r => {
    runningBalance += Number(r.debit) - Number(r.credit)
    return { ...r, running_balance: runningBalance }
  })

  return {
    opening_balance: openingBalance,
    closing_balance: runningBalance,
    total_debit:  rows.reduce((s, r) => s + Number(r.debit),  0),
    total_credit: rows.reduce((s, r) => s + Number(r.credit), 0),
    rows: ledgerRows,
    total: Number(count), page, limit,
  }
}

class ReportingEngine {

  /**
   * Get the running balance for a specific account.
   * This is the authoritative balance — derived from journal, never stored.
   */
  static async getAccountBalance(db, accountId, companyId, asOfDate = null) {
    let q = db('journal_lines as jl')
      .join('journal_entries as je', 'jl.journal_entry_id', 'je.id')
      .where('je.company_id', companyId)
      .where('jl.account_id', accountId)

    if (asOfDate) q = q.where('je.entry_date', '<=', asOfDate)

    const [row] = await q.sum({ total_debit: 'jl.debit', total_credit: 'jl.credit' })
    const dr = Number(row?.total_debit  || 0)
    const cr = Number(row?.total_credit || 0)
    return { debit: dr, credit: cr, balance: dr - cr }
  }

  /**
   * General Ledger — full transaction history for an account, with running
   * balance after each entry.
   *
   * Source of truth: the journal, restricted to CURRENT entries.
   *
   * `journal_entries` is append-only, so an edited voucher leaves behind its
   * superseded original entry, an internal reversal, and finally the
   * corrected entry (owned by a hidden anchor voucher — see
   * services/currentEntry.js). This ledger shows exactly ONE row per voucher
   * per account: the corrected entry's line, attributed to the *visible*
   * voucher (its number, type and reference), dated by the corrected entry.
   * Consequently, after any number of edits:
   *   - amount edit  → the single row carries the new amount (never old+new)
   *   - account edit → the old account's ledger has no row for the voucher,
   *                    the new account's ledger has exactly one
   *   - party edit   → the row carries the new party (journal lines get the
   *                    voucher's party from the posting strategy)
   *   - date edit    → entry_date is the new date, so date-range membership
   *                    and the opening balance move with it
   * and it can never disagree with Trial Balance / P&L / Balance Sheet, which
   * sum the same journal (superseded entries net to zero against their
   * reversals, which are dated at the entry they cancel).
   *
   * Output shape is unchanged; windowing/pagination/running balance still
   * go through mergeAndPaginateLedgerRows().
   */
  static async ledger(accountId, companyId, { dateFrom, dateTo, page = 1, limit = 100 } = {}) {
    const account = await db('accounts').where({ id: accountId, company_id: companyId }).first()
    if (!account) throw new Error('Account not found')

    const q = db('journal_lines as jl')
      .join('journal_entries as je', 'jl.journal_entry_id', 'je.id')
    const rows = await scopeToCurrentEntries(q, db)
      .leftJoin('parties as p', 'jl.party_id', 'p.id')
      .where('je.company_id', companyId)
      .where('jl.account_id', accountId)
      .select(
        'je.event_type', 'je.period_ref',
        'ov.id as voucher_id', 'ov.voucher_no', 'ov.voucher_type', 'ov.reference_no',
        'je.entry_date as voucher_date', 'ov.created_at as sort_key',
        'jl.account_id', 'jl.debit', 'jl.credit', 'jl.description',
        'p.name as party_name',
      )
      .select(db.raw(`(ov.metadata->'ledger_correction'->>'active_entry_voucher_id') IS NOT NULL AS was_edited`))

    // `is_edited: false` → mergeAndPaginateLedgerRows() takes rows as-is (they
    // are already the current figures); `was_edited` carries the "Edited"
    // badge through to the response.
    const originalRows = rows.map(r => ({ ...r, is_edited: false }))
    const result = mergeAndPaginateLedgerRows({
      originalRows, movedIn: [],
      currentByVoucher: new Map(), voucherPartyIdById: new Map(), partyNameById: new Map(),
      dateFrom, dateTo, page, limit,
    })
    result.rows = result.rows.map(({ was_edited, ...r }) => ({ ...r, is_edited: !!was_edited }))
    return { account, ...result }
  }

  /**
   * Party Balance — outstanding balance per customer/supplier, derived the
   * same way every other report here is: from journal_lines, never a
   * stored counter.
   *
   * Note: no route currently calls this static method — GET
   * /reports/party-balance (routes/reports.js) has its own, near-identical
   * implementation instead, kept in sync with the same edited-voucher fix
   * applied here (amount/party re-derived from current voucher_lines) but
   * using `vouchers.voucher_date` for date-range filtering rather than
   * `journal_entries.entry_date` — see that file for why.
   *
   *   customer (AR control account): balance = opening + invoiced(debit) − collected(credit)
   *   supplier (AP control account): balance = opening + invoiced(credit) − paid(debit)
   *
   * @param {string} companyId
   * @param {object} [opts]
   * @param {'customer'|'supplier'} [opts.partyType] - omit for both types
   * @param {string} [opts.dateFrom] - inclusive, filters on journal_entries.entry_date
   * @param {string} [opts.dateTo]   - inclusive
   * @param {import('knex').Knex}  [opts.db] - injectable for tests; defaults to the real connection
   */
  static async partyBalance(companyId, { partyType, dateFrom, dateTo, db: dbOverride } = {}) {
    const conn = dbOverride || db

    let partyQuery = conn('parties').where({ company_id: companyId, is_active: true })
    if (partyType) partyQuery = partyQuery.where({ type: partyType })
    const parties = await partyQuery
    if (!parties.length) return []

    // Resolve this company's AR / AP control accounts (same sub_type
    // convention voucherBuilder.js uses to post sales/purchases/receipts/payments).
    const controlAccounts = await conn('accounts')
      .where({ company_id: companyId, is_active: true })
      .whereIn('sub_type', ['accounts_receivable', 'accounts_payable'])
    const arAccountIds = controlAccounts.filter(a => a.sub_type === 'accounts_receivable').map(a => a.id)
    const apAccountIds = controlAccounts.filter(a => a.sub_type === 'accounts_payable').map(a => a.id)

    const partyIds = parties.map(p => p.id)
    const controlAccountIds = [...arAccountIds, ...apAccountIds]

    let linesQuery = conn('journal_lines as jl')
      .join('journal_entries as je', 'jl.journal_entry_id', 'je.id')
      .leftJoin('vouchers as v', 'je.voucher_id', 'v.id')
      .where('je.company_id', companyId)
      .whereIn('jl.account_id', controlAccountIds)
      .whereIn('jl.party_id', partyIds)
      // Exclude internal system-generated correction/reversal vouchers (see
      // voucherEditService.js) — same filter used by ReportingEngine.ledger()
      // and the party/account ledger routes, for the same reason: without
      // it, editing a posted Receipt/Payment/etc. shows up here as an extra,
      // duplicate-looking line.
      .andWhere(b => b.whereNull('v.metadata').orWhereRaw(`v.metadata->>'system_correction' IS DISTINCT FROM 'true'`))
      .andWhere(b => b.whereNull('v.reversal_of').orWhereNotExists(
        conn('vouchers as orig').whereRaw('orig.id = v.reversal_of').andWhere('orig.status', 'POSTED')
      ))

    // Date-range filter stays on `je.entry_date` here (this function has no
    // live caller currently — see partyBalance()'s docblock; the real,
    // traffic-serving fix for this same bug is GET /reports/party-balance
    // in routes/reports.js, which uses `v.voucher_date` as ledger() does).
    if (dateFrom) linesQuery = linesQuery.where('je.entry_date', '>=', dateFrom)
    if (dateTo)   linesQuery = linesQuery.where('je.entry_date', '<=', dateTo)

    let lines = await linesQuery
      .select('jl.party_id', 'jl.account_id', 'jl.debit', 'jl.credit', 'v.id as voucher_id')

    // Which of these vouchers have ever been edited — a separate query
    // (rather than an inline EXISTS subquery in the SELECT above) so this
    // works against any plain query-builder-style connection, not just a
    // full Postgres one.
    const voucherIdsOnLines = [...new Set(lines.map(l => l.voucher_id).filter(Boolean))]
    const editedVoucherIdSet = voucherIdsOnLines.length
      ? new Set(await conn('audit_log').where('action', 'EDIT_VOUCHER').whereIn('entity_id', voucherIdsOnLines).pluck('entity_id'))
      : new Set()
    lines = lines.map(l => ({ ...l, is_edited: editedVoucherIdSet.has(l.voucher_id) }))

    // For an edited voucher, the journal_lines row just fetched is frozen at
    // whatever it looked like the moment it was FIRST posted (append-only
    // ledger). Re-derive party/account/amount from the voucher's CURRENT
    // voucher_lines so a Receipt edit (amount, or a re-bill to a different
    // party — which can also move the contra line onto a different party's
    // own control account) is reflected here immediately, same as the
    // account/party ledgers above.
    const editedVoucherIds = [...editedVoucherIdSet]
    if (editedVoucherIds.length) {
      const currentLines = await conn('voucher_lines')
        .whereIn('voucher_id', editedVoucherIds)
        .whereIn('account_id', controlAccountIds)
        .select('voucher_id', 'account_id', 'party_id', 'debit', 'credit')
      const currentByVoucher = new Map(currentLines.map(l => [l.voucher_id, l]))
      lines = lines
        // No current line on ANY control account means the edit moved this
        // voucher's contra entry off AR/AP entirely — it no longer belongs
        // in anyone's party balance.
        .filter(l => !l.is_edited || currentByVoucher.has(l.voucher_id))
        .map(l => {
          if (!l.is_edited) return l
          const current = currentByVoucher.get(l.voucher_id)
          return { ...l, account_id: current.account_id, party_id: current.party_id, debit: current.debit, credit: current.credit }
        })
    }

    return parties.map(party => {
      const isCustomer = party.type === 'customer'
      const relevantAccountIds = isCustomer ? arAccountIds : apAccountIds
      const partyLines = lines.filter(l => l.party_id === party.id && relevantAccountIds.includes(l.account_id))

      const sumDebit  = partyLines.reduce((s, l) => s + (Number(l.debit)  || 0), 0)
      const sumCredit = partyLines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
      const opening   = Number(party.opening_balance) || 0

      const total_invoiced  = isCustomer ? sumDebit  : sumCredit
      const total_collected = isCustomer ? sumCredit : 0
      const total_paid      = isCustomer ? 0         : sumDebit
      const balance = isCustomer
        ? opening + total_invoiced - total_collected
        : opening + total_invoiced - total_paid

      return {
        id: party.id,
        code: party.code,
        name: party.name,
        type: party.type,
        opening_balance: opening,
        total_invoiced,
        total_paid,
        total_collected,
        balance,
      }
    })
  }

  /**
   * Trial Balance — all accounts with opening / period / closing debit-credit split.
   *
   * Column contract (matches frontend TrialBalanceRow interface exactly):
   *   account_id, account_code, name, account_type,
   *   opening_debit, opening_credit,
   *   period_debit,  period_credit,
   *   closing_debit, closing_credit
   *
   * Rules:
   *   • Reads ONLY from journal_lines — no separate voucher-type filter.
   *   • Includes ALL account types: asset, liability, equity, income, expense.
   *   • Includes ALL non-group leaf accounts, regardless of sub_type.
   *   • Accounts with zero closing balance are included in the raw result;
   *     the UI filters them out when "Show Zero Balances" is off.
   *   • closing_debit  = max(0,  cumulative_debit  - cumulative_credit)  for debit-normal accounts
   *     closing_credit = max(0,  cumulative_credit - cumulative_debit)   for credit-normal accounts
   *     Accounts with no normal_balance default to raw cumulative totals.
   *
   * Guaranteed: SUM(closing_debit) = SUM(closing_credit) when books are balanced.
   */
  static async trialBalance(companyId, { asOfDate, dateFrom, periodId } = {}) {
    const toDate = asOfDate || new Date().toISOString().split('T')[0]

    // ── Opening-balance bindings (everything BEFORE dateFrom) ──────────────
    // Opening exists only when dateFrom is supplied; otherwise it's zero.
    const hasOpening  = !!dateFrom
    const openingBindings = hasOpening ? [companyId, dateFrom] : []
    const openingCTE = hasOpening
      ? `
        opening_balances AS (
          SELECT
            jl.account_id,
            SUM(jl.debit)  AS ob_debit,
            SUM(jl.credit) AS ob_credit
          FROM journal_lines jl
          JOIN journal_entries je ON jl.journal_entry_id = je.id
          WHERE je.company_id = ?
            AND je.entry_date < ?::date
          GROUP BY jl.account_id
        ),`
      : `
        opening_balances AS (
          SELECT NULL::uuid AS account_id, 0::numeric AS ob_debit, 0::numeric AS ob_credit
          WHERE false
        ),`

    // ── Period bindings (dateFrom..toDate, or all up to toDate) ───────────
    const periodBindings = [companyId, toDate]
    let periodDateFromClause = ''
    if (dateFrom) {
      periodDateFromClause = 'AND je.entry_date >= ?::date'
      periodBindings.push(dateFrom)
    }
    let periodClause = ''
    if (periodId) {
      periodClause = 'AND je.period_id = ?'
      periodBindings.push(periodId)
    }

    // ── Accounts binding ───────────────────────────────────────────────────
    const accountsBindings = [companyId]

    // Combine all bindings in CTE declaration order
    const bindings = [...openingBindings, ...periodBindings, ...accountsBindings]

    const result = await db.raw(`
      WITH
        ${openingCTE}
        period_balances AS (
          SELECT
            jl.account_id,
            SUM(jl.debit)  AS pb_debit,
            SUM(jl.credit) AS pb_credit
          FROM journal_lines jl
          JOIN journal_entries je ON jl.journal_entry_id = je.id
          WHERE je.company_id = ?
            AND je.entry_date <= ?::date
            ${periodDateFromClause}
            ${periodClause}
          GROUP BY jl.account_id
        )
      SELECT
        a.id                                        AS account_id,
        a.code                                      AS account_code,
        a.name                                      AS name,
        a.type                                      AS account_type,
        a.sub_type                                  AS sub_type,
        a.normal_balance                            AS normal_balance,

        -- Opening debit / credit (before dateFrom; zero when no dateFrom)
        COALESCE(ob.ob_debit,  0)                   AS opening_debit,
        COALESCE(ob.ob_credit, 0)                   AS opening_credit,

        -- Period movement
        COALESCE(pb.pb_debit,  0)                   AS period_debit,
        COALESCE(pb.pb_credit, 0)                   AS period_credit,

        -- Closing debit / credit split.
        --
        -- closing_debit:
        --   debit-normal (asset, expense)     → net = cum_dr - cum_cr, shown in Dr column
        --   credit-normal (liability, equity, income) → 0 (they carry Cr balance, not Dr)
        --   no normal_balance set             → raw cumulative debit total
        --
        -- closing_credit:
        --   credit-normal                     → net = cum_cr - cum_dr, shown in Cr column
        --   debit-normal                      → 0
        --   no normal_balance set             → raw cumulative credit total
        --
        -- GREATEST(...,0) prevents negative values from appearing in the wrong column.
        -- When books are balanced: SUM(closing_debit) = SUM(closing_credit).
        CASE
          WHEN a.normal_balance = 'debit' THEN
            -- Asset / Expense: net debit balance goes in Dr column
            GREATEST(
              COALESCE(ob.ob_debit, 0) + COALESCE(pb.pb_debit, 0)
              - COALESCE(ob.ob_credit,0) - COALESCE(pb.pb_credit,0),
              0
            )
          WHEN a.normal_balance = 'credit' THEN
            -- Liability / Equity / Income: Dr column is 0 (balance lives in Cr column)
            0
          ELSE
            -- Unclassified: show raw cumulative debit
            COALESCE(ob.ob_debit, 0) + COALESCE(pb.pb_debit, 0)
        END                                         AS closing_debit,

        CASE
          WHEN a.normal_balance = 'credit' THEN
            -- Liability / Equity / Income: net credit balance goes in Cr column
            GREATEST(
              COALESCE(ob.ob_credit,0) + COALESCE(pb.pb_credit,0)
              - COALESCE(ob.ob_debit, 0) - COALESCE(pb.pb_debit, 0),
              0
            )
          WHEN a.normal_balance = 'debit' THEN
            -- Asset / Expense: Cr column is 0 (balance lives in Dr column)
            0
          ELSE
            -- Unclassified: show raw cumulative credit
            COALESCE(ob.ob_credit,0) + COALESCE(pb.pb_credit,0)
        END                                         AS closing_credit

      FROM accounts a
      LEFT JOIN opening_balances ob ON ob.account_id = a.id
      LEFT JOIN period_balances  pb ON pb.account_id = a.id
      WHERE a.company_id = ?
        AND a.is_active  = true
        AND a.is_group   = false
      ORDER BY a.code
    `, bindings)

    const rows = result.rows

    // Totals are part of the RESPONSE, so they must be computed unconditionally.
    // (They used to be declared inside the dev-only diagnostic block below but
    // read by the `return` outside it → ReferenceError on every call.)
    const nonZero      = rows.filter(r => Number(r.closing_debit) + Number(r.closing_credit) > 0)
    const grandTotalDr = nonZero.reduce((s, r) => s + Number(r.closing_debit),  0)
    const grandTotalCr = nonZero.reduce((s, r) => s + Number(r.closing_credit), 0)

    // ── Diagnostic log — dev/staging only. Skipped entirely in production so
    // every Trial Balance request doesn't pay for extra regex filtering,
    // array reduces, and console output it never uses. Purely diagnostic;
    // does not affect the returned report data below.
    if (!config.isProd) {
      const arRows      = rows.filter(r => /receivable|debtor/i.test(r.name + r.sub_type))
      const apRows      = rows.filter(r => /payable|creditor/i.test(r.name + r.sub_type))

      console.log('[TrialBalance] ── Diagnostic ──────────────────────────────')
      console.log(`  Total accounts loaded   : ${rows.length}`)
      console.log(`  Non-zero balance accts  : ${nonZero.length}`)
      console.log(`  Accounts Receivable (${arRows.length}): ${arRows.map(r => `${r.name} Dr=${r.closing_debit} Cr=${r.closing_credit}`).join(', ') || 'none found'}`)
      console.log(`  Accounts Payable    (${apRows.length}): ${apRows.map(r => `${r.name} Dr=${r.closing_debit} Cr=${r.closing_credit}`).join(', ') || 'none found'}`)
      console.log(`  Grand Total Debit   : ${grandTotalDr.toFixed(2)}`)
      console.log(`  Grand Total Credit  : ${grandTotalCr.toFixed(2)}`)
      console.log(`  Variance            : ${Math.abs(grandTotalDr - grandTotalCr).toFixed(2)}`)
      console.log('[TrialBalance] ──────────────────────────────────────────────')
    }

    return {
      as_of_date:         toDate,
      date_from:          dateFrom || null,
      // Return the full rows array directly — the route wraps it in { success, data }
      // The frontend unwraps res.data.data to get this array.
      rows,
      grand_total_debit:  grandTotalDr,
      grand_total_credit: grandTotalCr,
      is_balanced:        Math.abs(grandTotalDr - grandTotalCr) < 0.01,
      variance:           Math.abs(grandTotalDr - grandTotalCr),
    }
  }

  /**
   * Profit & Loss Statement.
   * Revenue - Expenses = Net Profit/Loss
   * Uses recursive CTE for account hierarchy aggregation.
   */
  static async profitAndLoss(companyId, { dateFrom, dateTo, compareFrom, compareTo } = {}) {
    const from = dateFrom || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]
    const to   = dateTo   || new Date().toISOString().split('T')[0]

    const pnlQuery = `
      WITH RECURSIVE account_tree AS (
        -- Leaf accounts
        SELECT id, code, name, type, sub_type, parent_id, is_group, 0 AS depth
        FROM accounts
        WHERE company_id = ? AND is_active = true AND parent_id IS NULL

        UNION ALL

        SELECT a.id, a.code, a.name, a.type, a.sub_type, a.parent_id, a.is_group, at.depth + 1
        FROM accounts a
        JOIN account_tree at ON a.parent_id = at.id
        WHERE a.company_id = ? AND a.is_active = true
      ),
      period_balances AS (
        SELECT
          jl.account_id,
          SUM(jl.credit - jl.debit) AS net_credit
        FROM journal_lines jl
        JOIN journal_entries je ON jl.journal_entry_id = je.id
        WHERE je.company_id = ?
          AND je.entry_date BETWEEN ?::date AND ?::date
        GROUP BY jl.account_id
      ),
      income_expense AS (
        SELECT
          at.id, at.code, at.name, at.type, at.sub_type, at.depth, at.is_group,
          COALESCE(pb.net_credit, 0) AS amount
        FROM account_tree at
        LEFT JOIN period_balances pb ON at.id = pb.account_id
        WHERE at.type IN ('income', 'expense')
      )
      SELECT
        ie.*,
        CASE ie.type WHEN 'income' THEN ie.amount ELSE -ie.amount END AS signed_amount
      FROM income_expense ie
      ORDER BY ie.type DESC, ie.code
    `

    const result = await db.raw(pnlQuery, [companyId, companyId, companyId, from, to])
    const rows = result.rows

    const incomeRows  = rows.filter(r => r.type === 'income')
    const expenseRows = rows.filter(r => r.type === 'expense')

    const totalRevenue  = incomeRows.reduce((s, r) => s + Number(r.amount), 0)
    const totalExpenses = expenseRows.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
    const netProfit     = totalRevenue - totalExpenses

    // Compare period (optional)
    let compare = null
    if (compareFrom && compareTo) {
      const cResult = await db.raw(pnlQuery, [companyId, companyId, companyId, compareFrom, compareTo])
      const cRows = cResult.rows
      compare = {
        date_from: compareFrom, date_to: compareTo,
        total_revenue:  cRows.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0),
        total_expenses: cRows.filter(r => r.type === 'expense').reduce((s, r) => s + Math.abs(Number(r.amount)), 0),
      }
      compare.net_profit = compare.total_revenue - compare.total_expenses
    }

    return {
      date_from: from, date_to: to,
      income:  { rows: incomeRows,  total: totalRevenue },
      expense: { rows: expenseRows, total: totalExpenses },
      net_profit:    netProfit,
      net_profit_pct: totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : null,
      compare,
    }
  }

  /**
   * Balance Sheet — Assets = Liabilities + Equity (at a point in time).
   * Uses recursive CTE for hierarchy with subtotals.
   */
  static async balanceSheet(companyId, { asOfDate } = {}) {
    const toDate = asOfDate || new Date().toISOString().split('T')[0]

    const bsQuery = `
      WITH RECURSIVE account_tree AS (
        SELECT id, code, name, type, sub_type, parent_id, normal_balance, is_group, 0 AS depth
        FROM accounts
        WHERE company_id = ? AND parent_id IS NULL AND is_active = true

        UNION ALL

        SELECT a.id, a.code, a.name, a.type, a.sub_type, a.parent_id, a.normal_balance, a.is_group, at.depth + 1
        FROM accounts a
        JOIN account_tree at ON a.parent_id = at.id
        WHERE a.company_id = ? AND a.is_active = true
      ),
      cumulative_balances AS (
        SELECT
          jl.account_id,
          SUM(jl.debit)  AS total_debit,
          SUM(jl.credit) AS total_credit
        FROM journal_lines jl
        JOIN journal_entries je ON jl.journal_entry_id = je.id
        WHERE je.company_id = ?
          AND je.entry_date <= ?::date
        GROUP BY jl.account_id
      ),
      account_balances AS (
        SELECT
          at.id, at.code, at.name, at.type, at.sub_type, at.depth, at.is_group, at.normal_balance,
          COALESCE(cb.total_debit, 0)  AS total_debit,
          COALESCE(cb.total_credit, 0) AS total_credit,
          CASE at.normal_balance
            WHEN 'debit'  THEN COALESCE(cb.total_debit, 0)  - COALESCE(cb.total_credit, 0)
            WHEN 'credit' THEN COALESCE(cb.total_credit, 0) - COALESCE(cb.total_debit,  0)
          END AS balance
        FROM account_tree at
        LEFT JOIN cumulative_balances cb ON at.id = cb.account_id
        WHERE at.type IN ('asset', 'liability', 'equity') AND at.is_group = false
      )
      SELECT * FROM account_balances
      ORDER BY type, code
    `

    const result = await db.raw(bsQuery, [companyId, companyId, companyId, toDate])
    const rows = result.rows

    const assets      = rows.filter(r => r.type === 'asset')
    const liabilities = rows.filter(r => r.type === 'liability')
    const equity      = rows.filter(r => r.type === 'equity')

    const totalAssets      = assets.reduce((s, r) => s + Number(r.balance), 0)
    const totalLiabilities = liabilities.reduce((s, r) => s + Number(r.balance), 0)
    const totalEquity      = equity.reduce((s, r) => s + Number(r.balance), 0)

    // Include net profit in equity for balance sheet balance
    const pnl = await this.profitAndLoss(companyId, {
      dateFrom: new Date(new Date(toDate).getFullYear(), 0, 1).toISOString().split('T')[0],
      dateTo:   toDate,
    })

    const retainedEarnings   = pnl.net_profit
    const adjustedEquity     = totalEquity + retainedEarnings
    const totalLiabEquity    = totalLiabilities + adjustedEquity

    return {
      as_of_date:       toDate,
      assets:           { rows: assets,      total: totalAssets },
      liabilities:      { rows: liabilities, total: totalLiabilities },
      equity:           { rows: equity,      total: totalEquity },
      retained_earnings: retainedEarnings,
      total_assets:            totalAssets,
      total_liabilities_equity: totalLiabEquity,
      is_balanced:      Math.abs(totalAssets - totalLiabEquity) < 0.01,
      variance:         Math.abs(totalAssets - totalLiabEquity),
    }
  }

  /**
   * Cash Flow summary (simplified — operating activities).
   */
  static async cashFlow(companyId, { dateFrom, dateTo } = {}) {
    const from = dateFrom || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]
    const to   = dateTo   || new Date().toISOString().split('T')[0]

    const result = await db.raw(`
      SELECT
        a.sub_type,
        a.name,
        SUM(jl.debit - jl.credit) AS net_movement
      FROM journal_lines jl
      JOIN journal_entries je ON jl.journal_entry_id = je.id
      JOIN accounts a ON jl.account_id = a.id
      WHERE je.company_id = ?
        AND a.sub_type IN ('cash', 'bank')
        AND je.entry_date BETWEEN ?::date AND ?::date
      GROUP BY a.sub_type, a.name
      ORDER BY a.name
    `, [companyId, from, to])

    const rows = result.rows
    const totalCashChange = rows.reduce((s, r) => s + Number(r.net_movement), 0)
    return { date_from: from, date_to: to, rows, total_cash_change: totalCashChange }
  }
}

module.exports = ReportingEngine
module.exports.mergeAndPaginateLedgerRows = mergeAndPaginateLedgerRows
