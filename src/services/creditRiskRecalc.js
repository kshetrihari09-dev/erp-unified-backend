/**
 * creditRiskRecalc.js — orchestrates one customer's recalculation:
 *   1. Run the scoring engine (services/creditRiskEngine.js)
 *   2. Upsert the cached customer_credit_profiles row (what the dashboard
 *      and customer profile read — requirement #21, no recalc-on-read)
 *   3. Append a customer_risk_history snapshot
 *   4. Raise notifications for threshold-crossing events (requirement #15)
 *   5. Surface a pending recommendation via the generic `approvals` table
 *      when automaticActions isn't 'recommendation_only' — but NEVER
 *      apply the change itself (requirement #9/#26). Approving it is a
 *      separate, explicit action (routes/approvals.js) that only then
 *      calls the existing PUT /parties/:id to actually change the limit.
 *
 * Called from:
 *   - routes/creditRisk.js POST /customers/:id/recalculate (manual)
 *   - Event hooks in routes/sales.js / routes/accounting.js (event-based —
 *     see the `hookSaleCredit`/`hookPaymentReceived` wrappers exported here)
 *   - A scheduled job (see server.js — runs recalcAllCustomers per company
 *     on an interval; safe to call repeatedly, this is a pure recompute)
 */
const db = require('../db/knex')
const { computeForCustomers, loadSettings } = require('./creditRiskEngine')

async function notify(trx, { companyId, category = 'credit_risk', severity = 'info', title, message, customerId, metadata = {} }) {
  try {
    await trx('notifications').insert({
      company_id: companyId, category, severity, title, message,
      related_customer_id: customerId || null, metadata: JSON.stringify(metadata),
    })
  } catch (err) {
    // Notifications must never block the actual recalculation.
    console.error('[creditRisk] failed to write notification:', err.message)
  }
}

/** Recalculate one customer and persist everything. Idempotent — safe to call as often as needed. */
async function recalcCustomer(companyId, customerId, { trigger = 'manual', userId = null } = {}) {
  const settings = await loadSettings(companyId)
  const [profile] = await computeForCustomers(companyId, [customerId])
  if (!profile) return null

  return db.transaction(async (trx) => {
    const previous = await trx('customer_credit_profiles').where({ company_id: companyId, customer_id: customerId }).first()

    await trx('customer_credit_profiles')
      .insert({
        company_id: companyId, customer_id: customerId,
        current_risk_score: profile.current_risk_score,
        risk_category: profile.risk_category,
        bad_debt_probability: profile.bad_debt_probability,
        expected_credit_loss: profile.expected_credit_loss,
        payment_trend: profile.payment_trend,
        outstanding_amount: profile.outstanding_amount,
        overdue_amount: profile.overdue_amount,
        credit_utilization: profile.credit_utilization,
        recommended_credit_limit: profile.recommended_credit_limit,
        recommended_payment_terms_days: profile.recommended_payment_terms_days,
        recommended_action: profile.recommended_action,
        factors: JSON.stringify(profile.factors),
        last_calculated_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict(['company_id', 'customer_id'])
      .merge()

    await trx('customer_risk_history').insert({
      company_id: companyId, customer_id: customerId,
      risk_score: profile.current_risk_score,
      risk_category: profile.risk_category,
      bad_debt_probability: profile.bad_debt_probability,
      expected_credit_loss: profile.expected_credit_loss,
      payment_trend: profile.payment_trend,
      factors: JSON.stringify(profile.factors),
      trigger,
      calculated_at: new Date(),
    })

    // ── Alerts (requirement #15) — compared against the previous cached
    // snapshot only (not a true rolling-window lookback); documented
    // simplification given recalculation is event-driven, not fixed-interval.
    const customer = await trx('parties').where({ id: customerId }).first('name', 'credit_limit')

    if (settings.alerts.highRiskEnabled && profile.risk_category === 'high' && previous?.risk_category !== 'high') {
      await notify(trx, {
        companyId, severity: 'critical', customerId,
        title: `${customer.name} became High Risk`,
        message: `Credit risk score dropped to ${profile.current_risk_score}. ${profile.recommended_action}`,
      })
    }
    if (previous?.current_risk_score != null && profile.current_risk_score != null) {
      const drop = previous.current_risk_score - profile.current_risk_score
      if (drop >= settings.alerts.scoreDropThreshold) {
        await notify(trx, {
          companyId, severity: 'warning', customerId,
          title: `${customer.name}'s risk score dropped ${drop} points`,
          message: `Score changed from ${previous.current_risk_score} to ${profile.current_risk_score}.`,
        })
      }
    }
    if (profile.bad_debt_probability != null && profile.bad_debt_probability >= settings.alerts.badDebtProbabilityThreshold) {
      await notify(trx, {
        companyId, severity: 'warning', customerId,
        title: `${customer.name}: high bad-debt risk`,
        message: `Estimated bad-debt risk is ${profile.bad_debt_probability}% (Expected Credit Loss: ${profile.expected_credit_loss}).`,
      })
    }
    if (profile.overdue_amount >= settings.alerts.criticalOverdueAmount) {
      await notify(trx, {
        companyId, severity: 'critical', customerId,
        title: `${customer.name}: critical overdue balance`,
        message: `Overdue amount is ${profile.overdue_amount}, exceeding the configured critical threshold.`,
      })
    }

    // ── Recommendation → optional formal approval request (requirement #9/#16) ──
    // Always recommendation-only unless the company has opted into a
    // formal approval queue. Either way, nothing about the customer's
    // ACTUAL credit_limit/credit_days changes here.
    if (settings.automaticActions !== 'recommendation_only'
        && profile.recommended_credit_limit != null
        && Number(profile.recommended_credit_limit) !== Number(customer.credit_limit)) {
      const existingPending = await trx('approvals')
        .where({ company_id: companyId, customer_id: customerId, type: 'reduce_credit_limit', status: 'pending' })
        .first()
      if (!existingPending) {
        await trx('approvals').insert({
          company_id: companyId, customer_id: customerId, type: 'reduce_credit_limit',
          status: 'pending', requested_by: userId,
          reason: profile.factors.explanation.join('; '),
          payload: JSON.stringify({
            from_limit: Number(customer.credit_limit), to_limit: profile.recommended_credit_limit,
            from_terms_days: null, to_terms_days: profile.recommended_payment_terms_days,
            risk_score: profile.current_risk_score, risk_category: profile.risk_category,
          }),
        })
      }
    }

    return profile
  })
}

/** Scheduled/bulk recalculation for every customer in a company. */
async function recalcAllCustomers(companyId, { trigger = 'scheduled' } = {}) {
  const customers = await db('parties').where({ company_id: companyId, type: 'customer', is_active: true }).select('id')
  const results = []
  for (const c of customers) {
    try { results.push(await recalcCustomer(companyId, c.id, { trigger })) }
    catch (err) { console.error(`[creditRisk] recalc failed for customer ${c.id}:`, err.message) }
  }
  return results
}

/**
 * Fire-and-forget event hook — call this after any financial event that
 * should trigger recalculation (requirement #2). Never throws into the
 * caller's request; a scoring failure must not fail the sale/payment/etc.
 * that triggered it.
 */
function recalcCustomerAsync(companyId, customerId, opts) {
  if (!customerId) return
  recalcCustomer(companyId, customerId, opts).catch(err => {
    console.error(`[creditRisk] event-based recalc failed for customer ${customerId}:`, err.message)
  })
}

module.exports = { recalcCustomer, recalcAllCustomers, recalcCustomerAsync }
