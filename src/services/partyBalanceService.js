/**
 * partyBalanceService.js — the ONE place that knows how a party's outstanding
 * balance is built, so the party Ledger and every report agree.
 *
 *   Opening Balance at FROM  =  parties.opening_balance            (initial, never modified)
 *                             + net ledger movements dated BEFORE FROM
 *   Period movement          =  net ledger movements dated FROM … TO   (both days inclusive)
 *   Closing Balance at TO    =  Opening Balance at FROM + period movement
 *
 * Sign convention (identical to GET /parties/:id/ledger):
 *   customer  balance = opening + Σ debit − Σ credit     (receivable, + = customer owes us)
 *   supplier  balance = opening + Σ credit − Σ debit     (payable,    + = we owe supplier)
 *
 * Ledger movements (same sources and rules as the ledger route):
 *   sales (status active)        debit  net_total                     customer
 *   inline cash/card sale pay.   credit paid_amount   (payment_mode <> 'credit', paid_amount > 0)
 *   purchases (status active)    credit net_total                     supplier
 *   inline cash purchase pay.    debit  paid_amount
 *   POSTED vouchers (RECEIPT, PAYMENT, CREDIT_NOTE, DEBIT_NOTE; JOURNAL/CONTRA net to 0 as in the ledger):
 *        RECEIPT / CREDIT_NOTE → credit total_amount      PAYMENT / DEBIT_NOTE → debit total_amount
 *     – RECEIPT/PAYMENT whose voucher_no equals one of the party's own invoice numbers is the
 *       invoice's own payment (already counted inline) → skipped, exactly as in the ledger
 *     – system-correction vouchers and vouchers reversed by a POSTED reversal are excluded
 *
 * Everything is aggregated in SQL per party (no history is loaded into memory) and every
 * value is bound as a parameter.
 */
const db = require('../db/knex')

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

let _hasJournal
async function hasJournal() {
  if (_hasJournal === undefined) {
    try { _hasJournal = await db.schema.hasTable('journal_entries') } catch { _hasJournal = false }
  }
  return _hasJournal
}

function checkDates({ from, to }) {
  const err = (m) => Object.assign(new Error(m), { status: 400 })
  if (from && !DATE_RE.test(from)) throw err('from must be YYYY-MM-DD')
  if (to   && !DATE_RE.test(to))   throw err('to must be YYYY-MM-DD')
  if (from && to && from > to)     throw err('From date cannot be after To date')
}

/** SQL for the `mv` CTE: (party_id, dt, kind, debit, credit) for the bound :cid / optional :pid. */
async function movementsSQL() {
  const PID = (col) => `(CAST(:pid AS uuid) IS NULL OR ${col} = CAST(:pid AS uuid))`
  const parts = [`
    SELECT s.party_id, s.date_ad AS dt, 'SALES'::text AS kind, s.net_total::numeric AS debit, 0::numeric AS credit
      FROM sales s JOIN parties p ON p.id = s.party_id AND p.type = 'customer'
     WHERE s.company_id = :cid AND s.status = 'active' AND ${PID('s.party_id')}
    UNION ALL
    SELECT s.party_id, s.date_ad, 'RECEIPT', 0, s.paid_amount::numeric
      FROM sales s JOIN parties p ON p.id = s.party_id AND p.type = 'customer'
     WHERE s.company_id = :cid AND s.status = 'active' AND s.payment_mode <> 'credit' AND s.paid_amount > 0 AND ${PID('s.party_id')}
    UNION ALL
    SELECT u.party_id, u.date_ad, 'PURCHASE', 0, u.net_total::numeric
      FROM purchases u JOIN parties p ON p.id = u.party_id AND p.type = 'supplier'
     WHERE u.company_id = :cid AND u.status = 'active' AND ${PID('u.party_id')}
    UNION ALL
    SELECT u.party_id, u.date_ad, 'PAYMENT', u.paid_amount::numeric, 0
      FROM purchases u JOIN parties p ON p.id = u.party_id AND p.type = 'supplier'
     WHERE u.company_id = :cid AND u.status = 'active' AND u.payment_mode <> 'credit' AND u.paid_amount > 0 AND ${PID('u.party_id')}`]
  if (await hasJournal()) parts.push(`
    UNION ALL
    SELECT v.party_id, v.voucher_date, v.voucher_type::text,
           CASE WHEN v.voucher_type IN ('PAYMENT','DEBIT_NOTE')  THEN v.total_amount ELSE 0 END::numeric,
           CASE WHEN v.voucher_type IN ('RECEIPT','CREDIT_NOTE') THEN v.total_amount ELSE 0 END::numeric
      FROM vouchers v
     WHERE v.company_id = :cid AND v.status = 'POSTED' AND v.party_id IS NOT NULL AND ${PID('v.party_id')}
       AND v.voucher_type IN ('RECEIPT','PAYMENT','CREDIT_NOTE','DEBIT_NOTE')
       AND EXISTS (SELECT 1 FROM journal_entries je WHERE je.voucher_id = v.id)
       AND (v.metadata IS NULL OR v.metadata->>'system_correction' IS DISTINCT FROM 'true')
       AND (v.reversal_of IS NULL OR NOT EXISTS (SELECT 1 FROM vouchers o WHERE o.id = v.reversal_of AND o.status = 'POSTED'))
       AND NOT (v.voucher_type IN ('RECEIPT','PAYMENT') AND (
             EXISTS (SELECT 1 FROM sales sx     WHERE sx.company_id = v.company_id AND sx.party_id = v.party_id AND sx.status = 'active' AND sx.invoice_no = v.voucher_no)
          OR EXISTS (SELECT 1 FROM purchases ux WHERE ux.company_id = v.company_id AND ux.party_id = v.party_id AND ux.status = 'active' AND ux.bill_no    = v.voucher_no)))`)
  return parts.join('\n')
}

/**
 * Balances per party for the window FROM…TO (either end optional).
 * @returns Map<party_id, { type, initial_opening, before_movement, opening_balance,
 *                          period_debit, period_credit, period_movement, receipts, closing_balance }>
 *   opening_balance = balance immediately BEFORE `from` (initial opening + earlier movements)
 *   receipts        = customers: money received in the window / suppliers: payments made
 */
async function getBalances(companyId, { from, to, partyId, partyType } = {}) {
  checkDates({ from, to })
  const mv = await movementsSQL()
  const res = await db.raw(`
    WITH mv AS (${mv})
    SELECT p.id AS party_id, p.type, p.opening_balance,
      COALESCE(SUM(CASE WHEN CAST(:from AS date) IS NOT NULL AND mv.dt <  CAST(:from AS date) THEN mv.debit  END), 0) AS pre_debit,
      COALESCE(SUM(CASE WHEN CAST(:from AS date) IS NOT NULL AND mv.dt <  CAST(:from AS date) THEN mv.credit END), 0) AS pre_credit,
      COALESCE(SUM(CASE WHEN (CAST(:from AS date) IS NULL OR mv.dt >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR mv.dt <= CAST(:to AS date)) THEN mv.debit  END), 0) AS per_debit,
      COALESCE(SUM(CASE WHEN (CAST(:from AS date) IS NULL OR mv.dt >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR mv.dt <= CAST(:to AS date)) THEN mv.credit END), 0) AS per_credit,
      COALESCE(SUM(CASE WHEN (CAST(:from AS date) IS NULL OR mv.dt >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR mv.dt <= CAST(:to AS date))
                        THEN CASE WHEN p.type = 'customer' AND mv.kind = 'RECEIPT' THEN mv.credit
                                  WHEN p.type = 'supplier' AND mv.kind = 'PAYMENT' THEN mv.debit END END), 0) AS receipts
      FROM parties p
      LEFT JOIN mv ON mv.party_id = p.id
     WHERE p.company_id = :cid AND (CAST(:ptype AS text) IS NULL OR p.type = CAST(:ptype AS text))
       AND (CAST(:pid AS uuid) IS NULL OR p.id = CAST(:pid AS uuid))
     GROUP BY p.id, p.type, p.opening_balance`,
    { cid: companyId, from: from || null, to: to || null, pid: partyId || null, ptype: partyType || null })

  const out = new Map()
  for (const r of (res.rows ?? res)) {
    const sign = r.type === 'customer' ? 1 : -1            // customer: debit − credit · supplier: credit − debit
    const initial  = r2(r.opening_balance)
    const before   = r2(sign * (Number(r.pre_debit) - Number(r.pre_credit)))
    const opening  = r2(initial + before)
    const movement = r2(sign * (Number(r.per_debit) - Number(r.per_credit)))
    out.set(r.party_id, {
      type: r.type, initial_opening: initial, before_movement: before, opening_balance: opening,
      period_debit: r2(r.per_debit), period_credit: r2(r.per_credit), period_movement: movement,
      receipts: r2(r.receipts), closing_balance: r2(opening + movement),
    })
  }
  return out
}

module.exports = { getBalances, movementsSQL, r2 }
