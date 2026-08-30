/**
 * creditRiskEngine.js — rule-based, transparent Credit-Risk & Bad-Debt
 * Scoring engine.
 *
 * IMPORTANT — read before changing the queries below:
 *
 *   This schema has no per-invoice payment-allocation table. A customer's
 *   payment (routes/accounting.js POST /accounting/receipts, voucher_type
 *   RECEIPT) is posted as one lump sum against their AR control account —
 *   it is never linked to which specific invoice(s) it settles. The same
 *   is true of sales returns (CREDIT_NOTE).
 *
 *   To calculate "was invoice X paid on time" and "average payment delay"
 *   (both required by the spec), this engine reconstructs the most
 *   plausible allocation itself, in memory, using a standard FIFO
 *   assumption (oldest invoice gets paid first) — `allocateFifo()` below.
 *   This is read-only analytics: it NEVER writes back to sales/vouchers/
 *   journal tables (requirement #26 — "must not change accounting
 *   records directly"). If a business doesn't actually collect FIFO,
 *   individual invoice delay figures may be approximate, but the
 *   customer-level aggregates (total outstanding, total overdue, overall
 *   delay trend) are exact, because they only depend on total debits vs.
 *   total credits and true due dates — not on which specific invoice a
 *   given payment happened to settle.
 *
 *   Due dates: vouchers.due_date exists in the schema but was never
 *   populated for SALES vouchers before this feature (see the additive
 *   change in services/voucherBuilder.js buildSaleVoucher()). For sales
 *   created before that change, due_date is null here and we fall back to
 *   `sale.date_ad + party.credit_days` (current credit_days, since the
 *   historical value at time of sale isn't recorded anywhere).
 *
 *   Reversals/cancellations: a cancelled or reversed voucher's status
 *   becomes 'CANCELLED'/'REVERSED' (see engines/postingEngine.js) and its
 *   reversal counter-entry is posted as voucher_type 'JOURNAL' — so
 *   filtering `voucher_type IN (SALES, RECEIPT, CREDIT_NOTE, DEBIT_NOTE)
 *   AND status = 'POSTED'` (exactly what routes/reports.js party-balance
 *   already does) naturally and correctly excludes both sides of a
 *   reversal without any special-case code.
 */
const db = require('../db/knex')
const { withDefaults } = require('../utils/settingsDefaults')

const AR_DEBIT_TYPES  = ['SALES', 'DEBIT_NOTE']
const AR_CREDIT_TYPES = ['RECEIPT', 'CREDIT_NOTE']

function todayISO() { return new Date().toISOString().split('T')[0] }
function addDays(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}
function diffDays(fromISO, toISO) {
  return Math.round((new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')) / 86400000)
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const round2 = (n) => Math.round(n * 100) / 100

async function loadSettings(companyId) {
  const company = await db('companies').where({ id: companyId }).first('settings')
  return withDefaults(company?.settings || {}).creditRisk
}

/**
 * FIFO virtual allocation. See file header for why this exists.
 * `debits` = invoices (each { id, date, due_date, amount }), oldest first.
 * `credits` = payments/returns (each { date, amount }), any order.
 * Returns the debits array, each annotated with `remaining` and, if it was
 * fully cleared, `cleared_date`.
 */
function allocateFifo(debits, credits) {
  const queue = debits.map(d => ({ ...d, remaining: d.amount, cleared_date: null }))
  const sortedCredits = [...credits].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  for (const credit of sortedCredits) {
    let left = credit.amount
    for (const inv of queue) {
      if (left <= 0) break
      if (inv.remaining <= 0.004) continue
      const applied = Math.min(inv.remaining, left)
      inv.remaining = round2(inv.remaining - applied)
      left = round2(left - applied)
      if (inv.remaining <= 0.004 && !inv.cleared_date) inv.cleared_date = credit.date
    }
    // Any leftover (overpayment/advance) is not attributed to a future
    // invoice — a rare edge case, and irrelevant to current risk (it can
    // only ever reduce risk, never increase it, by undercounting available credit).
  }
  return queue
}

/**
 * Computes a full risk profile for one customer, given their AR events
 * (already fetched — see computeForCustomers for the batched query).
 */
function scoreCustomer({ customer, arVouchers, badDebtCount, settings }) {
  const today = todayISO()

  const debits = arVouchers
    .filter(v => AR_DEBIT_TYPES.includes(v.voucher_type))
    .map(v => ({
      id: v.id,
      date: v.voucher_date,
      due_date: v.due_date || addDays(v.voucher_date, Number(customer.credit_days) || 0),
      amount: Number(v.total_amount),
    }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)

  const credits = arVouchers
    .filter(v => AR_CREDIT_TYPES.includes(v.voucher_type))
    .map(v => ({ date: v.voucher_date, amount: Number(v.total_amount) }))

  const opening = Number(customer.opening_balance) || 0
  if (opening > 0) {
    // Treated as always-already-due — the earliest possible obligation —
    // so it's first in the FIFO queue and, if unpaid, counts as overdue.
    debits.unshift({ id: 'opening', date: '1970-01-01', due_date: '1970-01-01', amount: opening })
  }

  // ── "Insufficient Credit History" gate (requirement #25) — a customer
  // who has never had a single credit-side AR event gets no numeric score,
  // ever, regardless of how good their (nonexistent) record looks.
  if (!debits.length) {
    return {
      current_risk_score: null,
      risk_category: 'insufficient_data',
      bad_debt_probability: null,
      expected_credit_loss: null,
      payment_trend: 'stable',
      outstanding_amount: 0,
      overdue_amount: 0,
      credit_utilization: null,
      recommended_credit_limit: null,
      recommended_payment_terms_days: null,
      recommended_action: 'Insufficient Credit History — no credit sales on record yet',
      factors: { explanation: ['This customer has no credit sales history yet.'], breakdown: [] },
    }
  }

  const allocated = allocateFifo(debits, credits)
  const outstandingAmount = round2(allocated.reduce((s, i) => s + i.remaining, 0))
  const overdueAmount = round2(allocated
    .filter(i => i.remaining > 0.004 && i.due_date < today)
    .reduce((s, i) => s + i.remaining, 0))

  const scoringWindowStart = addDays(today, -settings.scoringPeriodDays)
  const closed = allocated.filter(i => i.cleared_date && i.due_date >= scoringWindowStart)
  const closedWithDelay = closed.map(i => ({ ...i, delay: Math.max(0, diffDays(i.due_date, i.cleared_date)) }))
  const onTimeGrace = settings.onTimeGraceDays || 0
  const lateClosed = closedWithDelay.filter(i => i.delay > onTimeGrace)

  // Partially-paid, still-open invoices contribute to average delay too
  // (weighted by how much of them has actually been paid) — requirement
  // #3B: "For partially paid invoices, use appropriate weighted calculations."
  const openPartials = allocated.filter(i => i.remaining > 0.004 && i.remaining < i.amount && i.due_date >= scoringWindowStart)
  const openPartialWeighted = openPartials.map(i => ({
    delay: Math.max(0, diffDays(i.due_date, today)),
    weight: round2((i.amount - i.remaining) / i.amount),
  }))

  const totalClosed = closedWithDelay.length
  const onTimeCount = totalClosed - lateClosed.length

  const weightedDelaySum = closedWithDelay.reduce((s, i) => s + i.delay, 0)
    + openPartialWeighted.reduce((s, i) => s + i.delay * i.weight, 0)
  const weightedDelayCount = totalClosed + openPartialWeighted.reduce((s, i) => s + i.weight, 0)

  // ── Payment trend: recent window vs. the rest of the scoring period ────
  const recentStart = addDays(today, -settings.trendRecentWindowDays)
  const recentDelays = closedWithDelay.filter(i => i.due_date >= recentStart).map(i => i.delay)
  const olderDelays  = closedWithDelay.filter(i => i.due_date < recentStart).map(i => i.delay)
  const avg = (arr) => arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null
  const recentAvg = avg(recentDelays)
  const olderAvg  = avg(olderDelays)
  let paymentTrend = 'stable'
  if (recentAvg !== null && olderAvg !== null) {
    const delta = recentAvg - olderAvg
    if (delta > settings.trendChangeThresholdDays) paymentTrend = 'worsening'
    else if (delta < -settings.trendChangeThresholdDays) paymentTrend = 'improving'
  }

  // ── Raw factor values (null = insufficient data for that factor alone;
  // its weight is redistributed among the factors that do have data,
  // rather than unfairly zeroing the customer's score) ────────────────────
  const creditLimit = Number(customer.credit_limit) || 0
  const raw = {
    onTimePaymentRate:    totalClosed > 0 ? onTimeCount / totalClosed : null,
    paymentDelay:         weightedDelayCount > 0 ? weightedDelaySum / weightedDelayCount : null,
    overdueExposure:      outstandingAmount > 0 ? overdueAmount / outstandingAmount : 0,
    creditUtilization:    creditLimit > 0 ? outstandingAmount / creditLimit : (outstandingAmount > 0 ? 1 : 0),
    latePaymentFrequency: totalClosed > 0 ? lateClosed.length / totalClosed : null,
  }

  const scores = {
    onTimePaymentRate:    raw.onTimePaymentRate    !== null ? raw.onTimePaymentRate * 100 : null,
    paymentDelay:         raw.paymentDelay         !== null ? clamp(100 - raw.paymentDelay * settings.delayScorePenaltyPerDay, 0, 100) : null,
    overdueExposure:      clamp(100 - raw.overdueExposure * 100, 0, 100),
    creditUtilization:    clamp(100 - raw.creditUtilization * 100, 0, 100),
    latePaymentFrequency: raw.latePaymentFrequency !== null ? clamp(100 - raw.latePaymentFrequency * 100, 0, 100) : null,
    defaultHistory:       clamp(100 - badDebtCount * 30, 0, 100),
  }

  const weights = settings.weights
  let weightedSum = 0, totalWeight = 0
  const breakdown = []
  for (const key of Object.keys(weights)) {
    const score = scores[key]
    if (score === null) { breakdown.push({ factor: key, weight_pct: weights[key], score: null, note: 'No data — weight redistributed' }); continue }
    weightedSum += score * weights[key]
    totalWeight += weights[key]
    breakdown.push({ factor: key, weight_pct: weights[key], score: Math.round(score) })
  }
  const finalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null

  const riskCategory = finalScore === null ? 'insufficient_data'
    : finalScore >= settings.thresholds.lowRiskMin ? 'low'
    : finalScore >= settings.thresholds.mediumRiskMin ? 'medium'
    : 'high'

  const badDebtProbability = finalScore !== null
    ? clamp(round2((100 - finalScore) * settings.badDebt.probabilityMultiplier + badDebtCount * settings.badDebt.perIncidentBump), 0, 100)
    : null
  const expectedCreditLoss = badDebtProbability !== null
    ? round2(outstandingAmount * badDebtProbability / 100)
    : null

  // ── Recommendations (requirement #8/#9 — recommendation only) ──────────
  const rec = settings.recommendations
  let recommendedLimit, recommendedTermsDays, recommendedAction
  if (riskCategory === 'low') {
    recommendedLimit = creditLimit
    recommendedTermsDays = Number(customer.credit_days) || 0
    recommendedAction = 'Keep Current Terms'
  } else if (riskCategory === 'medium') {
    recommendedLimit = round2(creditLimit * rec.mediumRiskLimitPct / 100)
    recommendedTermsDays = rec.mediumRiskTermsDays
    recommendedAction = `Reduce credit limit to the recommended amount; use Net-${rec.mediumRiskTermsDays} terms`
  } else if (riskCategory === 'high') {
    recommendedLimit = rec.highRiskLowLimit
    recommendedTermsDays = rec.highRiskTermsDays
    recommendedAction = 'Require prepayment; block new credit sales pending manager approval'
  } else {
    recommendedLimit = null
    recommendedTermsDays = null
    recommendedAction = 'Insufficient Credit History — monitor closely before extending large credit'
  }

  // ── Human-readable explanation (requirement #13) ────────────────────────
  const explanation = []
  if (raw.paymentDelay !== null && raw.paymentDelay > 0) explanation.push(`Average payment delay: ${round2(raw.paymentDelay)} days`)
  if (overdueAmount > 0) explanation.push(`Rs. ${fmt(overdueAmount)} overdue (${Math.round(raw.overdueExposure * 100)}% of total outstanding)`)
  if (creditLimit > 0) explanation.push(`Credit utilization: ${Math.round(raw.creditUtilization * 100)}%`)
  if (lateClosed.length > 0) explanation.push(`${lateClosed.length} late payment${lateClosed.length > 1 ? 's' : ''} in the scoring period`)
  if (paymentTrend === 'worsening') explanation.push('Payment behavior is worsening compared to the prior period')
  if (paymentTrend === 'improving') explanation.push('Payment behavior is improving compared to the prior period')
  if (badDebtCount > 0) explanation.push(`${badDebtCount} historical bad-debt/write-off record${badDebtCount > 1 ? 's' : ''}`)
  if (!explanation.length) explanation.push('No adverse payment history found in the scoring period')

  return {
    current_risk_score: finalScore,
    risk_category: riskCategory,
    bad_debt_probability: badDebtProbability,
    expected_credit_loss: expectedCreditLoss,
    payment_trend: paymentTrend,
    outstanding_amount: outstandingAmount,
    overdue_amount: overdueAmount,
    credit_utilization: creditLimit > 0 ? round2(raw.creditUtilization * 100) : null,
    recommended_credit_limit: recommendedLimit,
    recommended_payment_terms_days: recommendedTermsDays,
    recommended_action: recommendedAction,
    factors: {
      explanation,
      breakdown,
      raw: {
        on_time_payment_rate: raw.onTimePaymentRate,
        average_payment_delay_days: raw.paymentDelay,
        overdue_ratio: raw.overdueExposure,
        credit_utilization_ratio: raw.creditUtilization,
        late_payment_frequency: raw.latePaymentFrequency,
        bad_debt_record_count: badDebtCount,
        closed_invoices_in_period: totalClosed,
        recent_avg_delay_days: recentAvg,
        older_avg_delay_days: olderAvg,
      },
    },
  }
}

function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }) }

/**
 * Batched computation for one or many customers of a company — one query
 * for AR vouchers + one for bad-debt counts, regardless of how many
 * customers are being scored (no N+1; requirement #21).
 */
async function computeForCustomers(companyId, customerIds) {
  const settings = await loadSettings(companyId)

  let custQ = db('parties').where({ company_id: companyId, type: 'customer' })
  if (customerIds?.length) custQ = custQ.whereIn('id', customerIds)
  const customers = await custQ.select('id', 'name', 'code', 'credit_limit', 'credit_days', 'opening_balance', 'is_active')
  if (!customers.length) return []
  const ids = customers.map(c => c.id)

  const vouchers = await db('vouchers')
    .where({ company_id: companyId, status: 'POSTED' })
    .whereIn('voucher_type', [...AR_DEBIT_TYPES, ...AR_CREDIT_TYPES])
    .whereIn('party_id', ids)
    .select('id', 'party_id', 'voucher_type', 'voucher_date', 'due_date', 'total_amount')
    .orderBy('voucher_date', 'asc')

  const badDebtRows = await db('customer_bad_debt_records')
    .where({ company_id: companyId })
    .whereIn('customer_id', ids)
    .groupBy('customer_id')
    .select('customer_id')
    .count('id as count')

  const vouchersByCustomer = {}
  for (const v of vouchers) (vouchersByCustomer[v.party_id] ||= []).push(v)
  const badDebtByCustomer = Object.fromEntries(badDebtRows.map(r => [r.customer_id, Number(r.count)]))

  return customers.map((customer) => {
    const profile = scoreCustomer({
      customer,
      arVouchers: vouchersByCustomer[customer.id] || [],
      badDebtCount: badDebtByCustomer[customer.id] || 0,
      settings,
    })
    return { customer_id: customer.id, customer_name: customer.name, customer_code: customer.code, ...profile }
  })
}

module.exports = { computeForCustomers, scoreCustomer, allocateFifo, loadSettings, AR_DEBIT_TYPES, AR_CREDIT_TYPES }
