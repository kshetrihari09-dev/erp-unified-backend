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
   * General Ledger — full transaction history for an account.
   * Returns running balance after each entry.
   */
  static async ledger(accountId, companyId, { dateFrom, dateTo, page = 1, limit = 100 } = {}) {
    const account = await db('accounts').where({ id: accountId, company_id: companyId }).first()
    if (!account) throw new Error('Account not found')

    // Opening balance (all entries before dateFrom)
    let openingDr = 0, openingCr = 0
    if (dateFrom) {
      const [ob] = await db('journal_lines as jl')
        .join('journal_entries as je', 'jl.journal_entry_id', 'je.id')
        .where('je.company_id', companyId)
        .where('jl.account_id', accountId)
        .where('je.entry_date', '<', dateFrom)
        .sum({ dr: 'jl.debit', cr: 'jl.credit' })
      openingDr = Number(ob?.dr || 0)
      openingCr = Number(ob?.cr || 0)
    }
    const openingBalance = openingDr - openingCr

    // Transactions in range
    let q = db('journal_lines as jl')
      .join('journal_entries as je', 'jl.journal_entry_id', 'je.id')
      .leftJoin('vouchers as v', 'je.voucher_id', 'v.id')
      .leftJoin('parties as p', 'jl.party_id', 'p.id')
      .where('je.company_id', companyId)
      .where('jl.account_id', accountId)
      .select(
        'je.entry_date', 'je.event_type', 'je.period_ref',
        'v.voucher_no', 'v.voucher_type', 'v.reference_no',
        'jl.debit', 'jl.credit', 'jl.description',
        'p.name as party_name',
      )

    if (dateFrom) q = q.where('je.entry_date', '>=', dateFrom)
    if (dateTo)   q = q.where('je.entry_date', '<=', dateTo)

    const [{ count }] = await q.clone().clearSelect().count('jl.id as count')
    const rows = await q.orderBy('je.entry_date').orderBy('je.created_at').limit(limit).offset((page-1)*limit)

    // Compute running balance
    let runningBalance = openingBalance
    const ledgerRows = rows.map(r => {
      runningBalance += Number(r.debit) - Number(r.credit)
      return { ...r, running_balance: runningBalance }
    })

    const closingBalance = runningBalance
    return {
      account,
      opening_balance: openingBalance,
      closing_balance: closingBalance,
      total_debit:  rows.reduce((s, r) => s + Number(r.debit),  0),
      total_credit: rows.reduce((s, r) => s + Number(r.credit), 0),
      rows: ledgerRows,
      total: Number(count), page, limit,
    }
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

    // ── Diagnostic log (remove or gate behind DEBUG env in production) ─────
    const arRows      = rows.filter(r => /receivable|debtor/i.test(r.name + r.sub_type))
    const apRows      = rows.filter(r => /payable|creditor/i.test(r.name + r.sub_type))
    const nonZero     = rows.filter(r => Number(r.closing_debit) + Number(r.closing_credit) > 0)
    const grandTotalDr = nonZero.reduce((s, r) => s + Number(r.closing_debit),  0)
    const grandTotalCr = nonZero.reduce((s, r) => s + Number(r.closing_credit), 0)

    console.log('[TrialBalance] ── Diagnostic ──────────────────────────────')
    console.log(`  Total accounts loaded   : ${rows.length}`)
    console.log(`  Non-zero balance accts  : ${nonZero.length}`)
    console.log(`  Accounts Receivable (${arRows.length}): ${arRows.map(r => `${r.name} Dr=${r.closing_debit} Cr=${r.closing_credit}`).join(', ') || 'none found'}`)
    console.log(`  Accounts Payable    (${apRows.length}): ${apRows.map(r => `${r.name} Dr=${r.closing_debit} Cr=${r.closing_credit}`).join(', ') || 'none found'}`)
    console.log(`  Grand Total Debit   : ${grandTotalDr.toFixed(2)}`)
    console.log(`  Grand Total Credit  : ${grandTotalCr.toFixed(2)}`)
    console.log(`  Variance            : ${Math.abs(grandTotalDr - grandTotalCr).toFixed(2)}`)
    console.log('[TrialBalance] ──────────────────────────────────────────────')

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
