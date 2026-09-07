/**
 * routes/customerAuth.js — Customer Product Ordering module.
 *
 * Registration creates BOTH a `parties` row (type='customer' — so the
 * customer is a first-class party the existing accounting/sales
 * architecture already understands: ledgers, vouchers, sales.party_id,
 * all work unmodified) AND a `customer_accounts` row (the login itself).
 * One party can only ever have one login (customer_accounts.party_id is
 * UNIQUE — migration 034) — a party created the old-fashioned way by
 * staff, for a walk-in/phone customer, does NOT get a login until they
 * (or staff, later) explicitly register one.
 *
 * `company_id` is required in the request body for both register and
 * login: this app is multi-tenant and there is, as of this phase, no
 * customer-facing "which store am I on" resolution yet (subdomain, store
 * slug, QR code, etc.) — that's a Phase 4 (frontend) decision. Until
 * then, the storefront is responsible for knowing/passing which
 * company's catalog it's showing.
 */
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const db     = require('../db/knex')
const { authenticateCustomer, signCustomerToken } = require('../middleware/customerAuth')
const { nextPartyCode, auditLog } = require('../utils/helpers')

/* ── POST /customer-auth/register ─────────────────────────────────────────
 * Minimal required fields (spec #21): name, phone, password. Email is
 * optional — never required just because the staff auth system happens
 * to use it, since nothing here actually depends on email. */
router.post('/register', async (req, res, next) => {
  try {
    const { company_id, name, phone, password, email, address } = req.body || {}
    if (!company_id) return res.status(400).json({ success: false, message: 'company_id is required.' })
    if (!name?.trim())  return res.status(400).json({ success: false, message: 'Name is required.' })
    if (!phone?.trim()) return res.status(400).json({ success: false, message: 'Phone number is required.' })
    if (!password || password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' })

    const company = await db('companies').where({ id: company_id }).first('id')
    if (!company) return res.status(404).json({ success: false, message: 'Store not found.' })

    const loginIdentifier = phone.trim()

    const dupe = await db('customer_accounts')
      .where({ company_id, login_identifier: loginIdentifier })
      .first('id')
    if (dupe) return res.status(400).json({ success: false, message: 'An account with this phone number already exists. Try logging in instead.' })

    const result = await db.transaction(async (trx) => {
      const code = await nextPartyCode(company_id, 'customer')
      const [party] = await trx('parties').insert({
        company_id, code, type: 'customer',
        name: name.trim(), phone: loginIdentifier,
        email: email?.trim() || null, address: address?.trim() || null,
      }).returning('*')

      const password_hash = await bcrypt.hash(password, 12)
      const [account] = await trx('customer_accounts').insert({
        company_id, party_id: party.id, login_identifier: loginIdentifier, password_hash,
      }).returning('*')

      return { party, account }
    })

    await auditLog(company_id, null, 'CREATE', 'customer_account', result.account.id, { name: name.trim(), phone: loginIdentifier }, req.ip)

    const token = signCustomerToken({ customerAccountId: result.account.id, companyId: company_id, partyId: result.party.id })
    res.status(201).json({
      success: true,
      data: {
        token,
        customer: { id: result.account.id, name: result.party.name, phone: result.party.phone, email: result.party.email },
      },
    })
  } catch (err) {
    if (err?.code === '23505') return res.status(400).json({ success: false, message: 'An account with this phone number already exists.' })
    next(err)
  }
})

/* ── POST /customer-auth/login ────────────────────────────────────────── */
router.post('/login', async (req, res, next) => {
  try {
    const { company_id, login_identifier, password } = req.body || {}
    if (!company_id || !login_identifier || !password) {
      return res.status(400).json({ success: false, message: 'Phone number and password are required.' })
    }

    const account = await db('customer_accounts as ca')
      .join('parties as p', 'p.id', 'ca.party_id')
      .where({ 'ca.company_id': company_id, 'ca.login_identifier': login_identifier.trim() })
      .select('ca.*', 'p.name', 'p.phone', 'p.email', 'p.is_active as party_is_active')
      .first()

    // Same generic message whether the account doesn't exist or the
    // password is wrong — never let a login endpoint confirm which
    // phone numbers are registered.
    const invalid = () => res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid phone number or password.' })

    if (!account || !(await bcrypt.compare(password, account.password_hash))) return invalid()
    if (!account.is_active || !account.party_is_active) {
      return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account has been disabled.' })
    }

    await db('customer_accounts').where({ id: account.id }).update({ last_login_at: new Date() })

    const token = signCustomerToken({ customerAccountId: account.id, companyId: account.company_id, partyId: account.party_id })
    res.json({
      success: true,
      data: { token, customer: { id: account.id, name: account.name, phone: account.phone, email: account.email } },
    })
  } catch (err) { next(err) }
})

/* ── GET /customer-auth/me ────────────────────────────────────────────── */
router.get('/me', authenticateCustomer, async (req, res, next) => {
  try {
    const party = await db('parties').where({ id: req.customer.partyId }).first('name', 'phone', 'email', 'address')
    res.json({ success: true, data: { id: req.customer.accountId, ...party } })
  } catch (err) { next(err) }
})

/* ── PATCH /customer-auth/profile ─────────────────────────────────────────
 * Spec #19/#35: name/phone/email/address only — never anything internal
 * (credit_limit, control_account_id, code, etc. all stay untouched;
 * writes go through this explicit whitelist, never the raw body). */
router.patch('/profile', authenticateCustomer, async (req, res, next) => {
  try {
    const { name, email, address } = req.body || {}
    const updates = {}
    if (name !== undefined)    { if (!name.trim()) return res.status(400).json({ success: false, message: 'Name cannot be empty.' }); updates.name = name.trim() }
    if (email !== undefined)   updates.email = email?.trim() || null
    if (address !== undefined) updates.address = address?.trim() || null
    // Phone doubles as the login identifier — changing it is a bigger
    // decision (re-verification, uniqueness) than a normal profile edit;
    // deliberately out of scope for this endpoint.

    const [party] = await db('parties').where({ id: req.customer.partyId }).update({ ...updates, updated_at: new Date() }).returning(['name', 'phone', 'email', 'address'])
    await auditLog(req.companyId, null, 'UPDATE', 'customer_account', req.customer.accountId, updates, req.ip)
    res.json({ success: true, data: { id: req.customer.accountId, ...party } })
  } catch (err) { next(err) }
})

/* ── PATCH /customer-auth/password ────────────────────────────────────── */
router.patch('/password', authenticateCustomer, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {}
    if (!new_password || new_password.length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' })

    const account = await db('customer_accounts').where({ id: req.customer.accountId }).first('password_hash')
    if (!current_password || !(await bcrypt.compare(current_password, account.password_hash))) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' })
    }

    await db('customer_accounts').where({ id: req.customer.accountId }).update({ password_hash: await bcrypt.hash(new_password, 12) })
    res.json({ success: true, message: 'Password updated.' })
  } catch (err) { next(err) }
})

module.exports = router
