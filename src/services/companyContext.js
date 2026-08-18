/**
 * companyContext.js — company resolution for the login/token-issuing flows
 *
 * One user belongs to exactly one company: users.company_id. This is the
 * single source of truth for every token issued (login, OTP-login,
 * refresh) — there is no multi-company membership or switching to resolve.
 */

/**
 * The company a freshly-issued token should point at: always the user's
 * own company_id, straight from the database row that was already loaded
 * for authentication. Kept as its own function (rather than inlining
 * `user.company_id` at each call site) so every login path stays in
 * agreement even if this ever needs to change.
 */
async function resolveActiveCompanyId(user) {
  return user.company_id
}

module.exports = { resolveActiveCompanyId }
