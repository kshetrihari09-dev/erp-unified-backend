/**
 * companyContext.js — multi-company resolution helpers
 *
 * Centralizes the logic for "which company should this user's session be
 * scoped to". Used by auth.js (login/register/refresh) and routes/companies.js
 * (list/create/switch) so the resolution rule lives in exactly one place.
 *
 * Does NOT change how any business table is scoped — everything downstream
 * still filters strictly by `req.companyId`, exactly as before. This module
 * only decides which company_id value that is for a given user/session.
 */
const db = require('../db/knex')

/**
 * Determine which company a freshly-issued token should point at.
 * Order of preference:
 *   1. The user's last-active company — IF they still have access to it.
 *   2. Their membership marked is_default.
 *   3. Any membership at all (oldest first, for determinism).
 *   4. Fallback to the legacy users.company_id column (should only be hit
 *      for rows that somehow have no user_companies membership yet).
 */
async function resolveActiveCompanyId(user) {
  if (user.last_active_company_id) {
    const stillMember = await db('user_companies')
      .where({ user_id: user.id, company_id: user.last_active_company_id })
      .first()
    if (stillMember) return user.last_active_company_id
  }

  const def = await db('user_companies')
    .where({ user_id: user.id, is_default: true })
    .first()
  if (def) return def.company_id

  const any = await db('user_companies')
    .where({ user_id: user.id })
    .orderBy('created_at', 'asc')
    .first()
  if (any) return any.company_id

  // No membership rows at all for this user (should only happen for an
  // account created outside the normal signup/registration path, or one
  // whose membership row was lost some other way). Falling back to the
  // legacy `users.company_id` column alone is NOT enough — every route
  // is guarded by `authenticate`, which re-checks `user_companies` on
  // every request, so a token minted for a company with no membership
  // row would pass login and then 403 on the very next request. Self-heal
  // by creating the missing membership so the session that's about to be
  // issued is actually usable.
  if (user.company_id) {
    const company = await db('companies').where({ id: user.company_id }).first('id')
    if (company) {
      await db('user_companies')
        .insert({ user_id: user.id, company_id: user.company_id, is_default: true })
        .onConflict(['user_id', 'company_id']).ignore()
      return user.company_id
    }
  }

  return null
}

/**
 * Throws-free membership check — returns the membership row or null.
 * Use this (not a role/permission check) to answer "can this user even
 * see this company at all".
 */
async function getMembership(userId, companyId) {
  return db('user_companies').where({ user_id: userId, company_id: companyId }).first()
}

module.exports = { resolveActiveCompanyId, getMembership }
