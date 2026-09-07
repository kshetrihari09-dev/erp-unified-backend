/**
 * middleware/customerAuth.js — Customer Product Ordering module.
 *
 * Deliberately its own file, not an extension of middleware/index.js's
 * `authenticate`: that function is fundamentally about a `users` row plus
 * `user_companies` membership, and a customer is neither. Reusing it would
 * mean either bolting a `role === 'customer'` case onto staff auth (now
 * every staff-auth code path has to reason about a completely different
 * kind of principal) or silently relying on customers happening to also
 * satisfy that logic. Two clearly-separated authenticate functions is the
 * safer shape for a boundary this sensitive (spec's non-negotiable: a
 * customer token must never grant staff/admin access, in either direction).
 *
 * middleware/index.js's `authenticate` explicitly rejects any token
 * carrying `kind: 'customer'` (see the check added there) — the reverse
 * of the check this file makes below — so a token minted by one side can
 * never be replayed against the other's routes even if someone tries.
 */
const jwt    = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const db     = require('../db/knex')

const CUSTOMER_JWT_EXPIRES_IN = process.env.CUSTOMER_JWT_EXPIRES_IN || '30d'
// Longer-lived than the staff token (8h default) — this is a consumer
// shopping session, not a till/workstation login; asking a customer to
// re-login every few hours would just push them off the storefront.

function signCustomerToken({ customerAccountId, companyId, partyId }) {
  return jwt.sign(
    { customerAccountId, companyId, partyId, kind: 'customer' },
    process.env.JWT_SECRET,
    { expiresIn: CUSTOMER_JWT_EXPIRES_IN },
  )
}

async function authenticateCustomer(req, res, next) {
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'No token provided' })
    }
    const token = auth.slice(7)
    let payload
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET)
    } catch {
      return res.status(401).json({ success: false, code: 'INVALID_TOKEN', message: 'Session expired — please log in again.' })
    }

    if (payload.kind !== 'customer') {
      return res.status(401).json({ success: false, code: 'WRONG_TOKEN_TYPE', message: 'Invalid token for this endpoint.' })
    }

    // Re-resolve from the DB on every request — same reasoning as staff
    // `authenticate`: the token only proves who authenticated, never
    // trusted for current status. A deactivated customer account (or one
    // whose party was removed) loses access immediately, not just at
    // next login.
    const account = await db('customer_accounts as ca')
      .join('parties as p', 'p.id', 'ca.party_id')
      .where('ca.id', payload.customerAccountId)
      .select('ca.id', 'ca.company_id', 'ca.party_id', 'ca.is_active', 'p.is_active as party_is_active', 'p.name', 'p.phone', 'p.email')
      .first()

    if (!account) {
      return res.status(401).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' })
    }
    if (!account.is_active || !account.party_is_active) {
      return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account has been disabled.' })
    }

    req.companyId = account.company_id
    req.customer = {
      accountId: account.id,
      partyId: account.party_id,
      name: account.name,
      phone: account.phone,
      email: account.email,
    }
    next()
  } catch (err) { next(err) }
}

module.exports = { authenticateCustomer, signCustomerToken }
