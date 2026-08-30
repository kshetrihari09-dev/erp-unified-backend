/**
 * routes/creditRisk.js — Credit-Risk & Bad-Debt Scoring API
 *
 *   GET  /credit-risk/dashboard
 *   GET  /credit-risk/customers                       (filter/paginate)
 *   GET  /credit-risk/customers/:customerId
 *   GET  /credit-risk/customers/:customerId/history
 *   POST /credit-risk/customers/:customerId/recalculate
 *   GET  /credit-risk/customers/:customerId/check      (billing-time check — requirement #10)
 *   POST /credit-risk/customers/:customerId/write-off   (bad-debt record + real journal voucher)
 *   GET  /credit-risk/settings
 *   PUT  /credit-risk/settings
 *
 * All routes are company-scoped (req.companyId, set by `authenticate`) and
 * permission-gated per migration 032 / middleware/index.js requirePermission.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate, requirePermission } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { withDefaults, mergeSettings } = require('../utils/settingsDefaults')
const { recalcCustomer } = require('../services/creditRiskRecalc')
const VoucherService = require('../services/voucherService')
const PostingEngine  = require('../engines/postingEngine')
const { resolveAccount } = require('../services/voucherBuilder')
const AuditLogger = require('../utils/auditLogger')

router.use(authenticate)

function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }

/** req.user (from `authenticate`) only carries {id, email, role} — permission
 * flags are never trusted from the request, always re-read from the DB. */
async function hasOverridePermission(companyId, userId) {
  const u = await db('users').where({ id: userId }).first('can_override_credit_risk_warning', 'can_approve_high_risk_credit_sale')
  return !!(u?.can_override_credit_risk_warning || u?.can_approve_high_risk_credit_sale)
}

function pickCustomerSummary(p) {
  return {
    customer_id: p.customer_id, customer_name: p.customer_name, customer_code: p.customer_code,
    risk_score: p.current_risk_score, risk_category: p.risk_category,
    outstanding_amount: p.outstanding_amount, overdue_amount: p.overdue_amount,
    bad_debt_probability: p.bad_debt_probability, expected_credit_loss: p.expected_credit_loss,
    payment_trend: p.payment_trend, recommended_action: p.recommended_action,
  }
}

/* ── GET /credit-risk/dashboard ──────────────────────────────────────────── */
router.get('/dashboard', requirePermission('view_credit_risk_dashboard'), async (req, res, next) => {
  try {
    // Dashboard reads the CACHE (customer_credit_profiles), never
    // recalculates on load (requirement #21).
    const profiles = await db('customer_credit_profiles as cp')
      .join('parties as p', 'cp.customer_id', 'p.id')
      .where('cp.company_id', req.companyId)
      .select('cp.*', 'p.name as customer_name', 'p.code as customer_code', 'p.is_active')

    const byCategory = { low: 0, medium: 0, high: 0, insufficient_data: 0 }
    let totalOutstanding = 0, atRiskOutstanding = 0, estimatedCreditLoss = 0
    const trend = { improving: 0, stable: 0, worsening: 0 }
    for (const p of profiles) {
      byCategory[p.risk_category] = (byCategory[p.risk_category] || 0) + 1
      totalOutstanding += Number(p.outstanding_amount) || 0
      if (p.risk_category === 'medium' || p.risk_category === 'high') atRiskOutstanding += Number(p.outstanding_amount) || 0
      estimatedCreditLoss += Number(p.expected_credit_loss) || 0
      trend[p.payment_trend] = (trend[p.payment_trend] || 0) + 1
    }

    const highRiskCustomers = profiles
      .filter(p => p.risk_category === 'high')
      .sort((a, b) => (b.expected_credit_loss || 0) - (a.expected_credit_loss || 0))
      .slice(0, 20)
      .map(pickCustomerSummary)

    const highestPotentialLoss = [...profiles]
      .sort((a, b) => (b.expected_credit_loss || 0) - (a.expected_credit_loss || 0))
      .slice(0, 10)
      .map(pickCustomerSummary)

    return successResponse(res, {
      summary: {
        total_customers: profiles.length,
        low_risk_customers: byCategory.low,
        medium_risk_customers: byCategory.medium,
        high_risk_customers: byCategory.high,
        insufficient_data_customers: byCategory.insufficient_data,
        total_outstanding: round2(totalOutstanding),
        at_risk_outstanding: round2(atRiskOutstanding),
        estimated_credit_loss: round2(estimatedCreditLoss),
      },
      risk_distribution: byCategory,
      payment_risk_trend: trend,
      high_risk_customers: highRiskCustomers,
      highest_potential_loss: highestPotentialLoss,
    })
  } catch (err) { next(err) }
})

/* ── GET /credit-risk/customers ──────────────────────────────────────────── */
router.get('/customers', requirePermission('view_customer_credit_risk'), async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { risk_category, payment_trend, search, min_score, max_score, min_outstanding, min_overdue, min_bad_debt_probability } = req.query

    let q = db('customer_credit_profiles as cp')
      .join('parties as p', 'cp.customer_id', 'p.id')
      .where('cp.company_id', req.companyId)
      .select('cp.*', 'p.name as customer_name', 'p.code as customer_code', 'p.phone', 'p.is_active')

    if (risk_category)   q = q.where('cp.risk_category', risk_category)
    if (payment_trend)   q = q.where('cp.payment_trend', payment_trend)
    if (search)          q = q.where(b => b.whereILike('p.name', `%${search}%`).orWhereILike('p.code', `%${search}%`))
    if (min_score)       q = q.where('cp.current_risk_score', '>=', Number(min_score))
    if (max_score)       q = q.where('cp.current_risk_score', '<=', Number(max_score))
    if (min_outstanding) q = q.where('cp.outstanding_amount', '>=', Number(min_outstanding))
    if (min_overdue)     q = q.where('cp.overdue_amount', '>=', Number(min_overdue))
    if (min_bad_debt_probability) q = q.where('cp.bad_debt_probability', '>=', Number(min_bad_debt_probability))

    const [{ count }] = await q.clone().clearSelect().count('cp.id as count')
    const data = await q.orderBy('cp.current_risk_score', 'asc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /credit-risk/customers/:customerId ──────────────────────────────── */
router.get('/customers/:customerId', requirePermission('view_customer_credit_risk'), async (req, res, next) => {
  try {
    const customer = await db('parties').where({ id: req.params.customerId, company_id: req.companyId }).first()
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' })

    let profile = await db('customer_credit_profiles').where({ company_id: req.companyId, customer_id: customer.id }).first()
    if (!profile) profile = await recalcCustomer(req.companyId, customer.id, { trigger: 'first_view', userId: req.user.id })

    return successResponse(res, {
      customer: { id: customer.id, name: customer.name, code: customer.code, credit_limit: customer.credit_limit, credit_days: customer.credit_days },
      profile,
    })
  } catch (err) { next(err) }
})

/* ── GET /credit-risk/customers/:customerId/history ──────────────────────── */
router.get('/customers/:customerId/history', requirePermission('view_customer_credit_risk'), async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const q = db('customer_risk_history')
      .where({ company_id: req.companyId, customer_id: req.params.customerId })
    const [{ count }] = await q.clone().count('id as count')
    const data = await q.orderBy('calculated_at', 'desc').limit(limit).offset(offset)

    // "Risk score dropped by N points in 30 days" callout (requirement #14)
    let significantChange = null
    if (data.length >= 2) {
      const latest = data[0], monthAgo = data.find(h => h.calculated_at <= new Date(Date.now() - 30 * 86400000))
      if (monthAgo && latest.risk_score != null && monthAgo.risk_score != null) {
        const delta = monthAgo.risk_score - latest.risk_score
        if (Math.abs(delta) >= 10) significantChange = { delta, direction: delta > 0 ? 'dropped' : 'improved', days: 30 }
      }
    }

    return paginatedResponse(res, { data, total: Number(count), page, limit, meta: { significant_change: significantChange } })
  } catch (err) { next(err) }
})

/* ── POST /credit-risk/customers/:customerId/recalculate ─────────────────── */
router.post('/customers/:customerId/recalculate', requirePermission('recalculate_credit_risk'), async (req, res, next) => {
  try {
    const customer = await db('parties').where({ id: req.params.customerId, company_id: req.companyId }).first()
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' })
    const profile = await recalcCustomer(req.companyId, customer.id, { trigger: 'manual', userId: req.user.id })
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'RECALCULATE_CREDIT_RISK', entityType: 'customer_credit_profiles', entityId: customer.id, payloadAfter: { score: profile.current_risk_score, category: profile.risk_category }, ipAddress: req.ip })
    return successResponse(res, profile, 'Credit risk recalculated')
  } catch (err) { next(err) }
})

/* ── GET /credit-risk/customers/:customerId/check ─────────────────────────
 * Billing-time credit check (requirement #10). Called by the sale-creation
 * screen when a credit sale is selected, with the proposed invoice amount.
 * ────────────────────────────────────────────────────────────────────── */
router.get('/customers/:customerId/check', requirePermission('view_customer_credit_risk'), async (req, res, next) => {
  try {
    const customer = await db('parties').where({ id: req.params.customerId, company_id: req.companyId }).first()
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' })

    let profile = await db('customer_credit_profiles').where({ company_id: req.companyId, customer_id: customer.id }).first()
    if (!profile) profile = await recalcCustomer(req.companyId, customer.id, { trigger: 'billing_check', userId: req.user.id })

    const settings = withDefaults((await db('companies').where({ id: req.companyId }).first('settings'))?.settings || {}).creditRisk
    const invoiceAmount = Number(req.query.invoice_amount) || 0
    const availableCredit = customer.credit_limit != null ? round2(Number(customer.credit_limit) - Number(profile.outstanding_amount)) : null
    const exceedsAvailable = availableCredit != null && invoiceAmount > availableCredit
    const exceedsRecommended = profile.recommended_credit_limit != null
      && (Number(profile.outstanding_amount) + invoiceAmount) > Number(profile.recommended_credit_limit)

    const blocked = settings.automaticActions === 'block_high_risk'
      && profile.risk_category === 'high'
      && exceedsAvailable
      && !(await hasOverridePermission(req.companyId, req.user.id))

    return successResponse(res, {
      customer_id: customer.id, customer_name: customer.name,
      risk_score: profile.current_risk_score, risk_category: profile.risk_category,
      credit_limit: customer.credit_limit, outstanding: profile.outstanding_amount,
      available_credit: availableCredit, invoice_amount: invoiceAmount,
      exceeds_available_credit: exceedsAvailable,
      exceeds_recommended_exposure: exceedsRecommended,
      recommended_action: profile.recommended_action,
      blocked, // true only under block_high_risk + High Risk + over limit + caller lacks override permission
      requires_approval: (exceedsAvailable || exceedsRecommended) && !blocked,
    })
  } catch (err) { next(err) }
})

/* ── POST /credit-risk/customers/:customerId/write-off ────────────────────
 * Records a bad-debt / write-off. Posts a real JOURNAL voucher
 * (Dr Bad Debt Expense, Cr Accounts Receivable for this customer) through
 * the existing double-entry engine — this is the only part of the feature
 * that touches accounting records, and it does so exactly the way a
 * manual write-off journal entry would (never automatically; always an
 * explicit user action with a reason). The customer_bad_debt_records row
 * persists independently of the voucher (requirement #3F).
 * ────────────────────────────────────────────────────────────────────── */
router.post('/customers/:customerId/write-off', requirePermission('configure_credit_risk_settings'), async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { amount, reason, sale_id } = req.body
    if (!amount || Number(amount) <= 0) { await trx.rollback(); return res.status(400).json({ success: false, message: 'A positive amount is required' }) }
    if (!reason?.trim())               { await trx.rollback(); return res.status(400).json({ success: false, message: 'A reason is required' }) }

    const customer = await trx('parties').where({ id: req.params.customerId, company_id: req.companyId }).first()
    if (!customer) { await trx.rollback(); return res.status(404).json({ success: false, message: 'Customer not found' }) }

    let voucher = null
    try {
      const badDebtAccount = await resolveAccount(trx, req.companyId, 'bad_debt_expense')
      const arAccount = customer.control_account_id || (await resolveAccount(trx, req.companyId, 'accounts_receivable')).id

      const { voucher: v } = await VoucherService.createInTransaction({
        trx, companyId: req.companyId, userId: req.user.id,
        voucherType: 'JOURNAL', voucherDate: new Date().toISOString().split('T')[0],
        partyId: customer.id,
        narration: `Bad debt write-off — ${customer.name}: ${reason}`,
        lines: [
          { account_id: badDebtAccount.id, debit: Number(amount), credit: 0, description: reason },
          { account_id: arAccount, debit: 0, credit: Number(amount), description: reason, party_id: customer.id },
        ],
      })
      await PostingEngine.postInTransaction({ trx, voucherId: v.id, userId: req.user.id, ipAddress: req.ip, companyId: req.companyId })
      voucher = v
    } catch (acctErr) {
      if (acctErr.status !== 422) throw acctErr
      // No Bad Debt Expense account configured — still record the bad-debt
      // history (the analytical record), just without the journal entry.
      console.warn(`[creditRisk] write-off saved without journal — ${acctErr.message}`)
    }

    const [record] = await trx('customer_bad_debt_records').insert({
      company_id: req.companyId, customer_id: customer.id, sale_id: sale_id || null,
      voucher_id: voucher?.id || null, amount: Number(amount), reason: reason.trim(), recorded_by: req.user.id,
    }).returning('*')

    await AuditLogger.log(trx, { companyId: req.companyId, userId: req.user.id, action: 'RECORD_BAD_DEBT', entityType: 'customer_bad_debt_records', entityId: record.id, payloadAfter: { amount, reason, customer_id: customer.id }, ipAddress: req.ip })
    await trx.commit()

    const profile = await recalcCustomer(req.companyId, customer.id, { trigger: 'bad_debt_recorded', userId: req.user.id })
    return successResponse(res, { record, voucher, profile }, 'Bad debt recorded', 201)
  } catch (err) { await trx.rollback(); next(err) }
})

/* ── GET /credit-risk/settings ────────────────────────────────────────────── */
router.get('/settings', requirePermission('view_credit_risk_dashboard'), async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first('settings')
    return successResponse(res, withDefaults(company?.settings || {}).creditRisk)
  } catch (err) { next(err) }
})

/* ── PUT /credit-risk/settings ────────────────────────────────────────────── */
router.put('/settings', requirePermission('configure_credit_risk_settings'), async (req, res, next) => {
  try {
    const incoming = req.body || {}
    if (incoming.weights) {
      const total = Object.values(incoming.weights).reduce((s, n) => s + Number(n || 0), 0)
      if (Math.round(total) !== 100) {
        return res.status(400).json({ success: false, message: `Risk weights must total 100% (got ${total}%)` })
      }
    }
    const company = await db('companies').where({ id: req.companyId }).first('settings')
    const merged  = mergeSettings(company?.settings || {}, { creditRisk: incoming })
    await db('companies').where({ id: req.companyId }).update({ settings: JSON.stringify(merged), updated_at: new Date() })
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'UPDATE', entityType: 'credit_risk_settings', entityId: req.companyId, payloadAfter: Object.keys(incoming), ipAddress: req.ip })
    return successResponse(res, merged.creditRisk, 'Credit risk settings saved')
  } catch (err) { next(err) }
})

module.exports = router
