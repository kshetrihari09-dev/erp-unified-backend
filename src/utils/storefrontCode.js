/**
 * utils/storefrontCode.js
 *
 * Shared validation for companies.storefront_code (migration 036), used
 * by both the admin-facing edit endpoints (routes/companies.js,
 * routes/settings.js) and the public resolution endpoint
 * (routes/storefront.js) so "what a valid slug looks like" is defined
 * in exactly one place.
 */

// Lowercase letters, digits, hyphens — no leading/trailing hyphen, no
// double hyphen. Matches what slugify() in migration 036 produces, so an
// admin-typed value and an auto-backfilled one are held to the same rule.
const STOREFRONT_CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function normalizeStorefrontCode(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

function isValidStorefrontCode(raw) {
  const v = normalizeStorefrontCode(raw)
  return v.length >= 2 && v.length <= 80 && STOREFRONT_CODE_RE.test(v)
}

// Used by POST /companies (new-company creation) so every company gets a
// working storefront link the moment it exists, without an admin having
// to remember to set one — same slugify+uniqueness-retry approach as
// migration 036's backfill, kept here too so both the one-time backfill
// and ongoing creation stay consistent without migrations importing
// application code (migrations should stay self-contained snapshots).
async function generateStorefrontCode(db, name) {
  const base = String(name || 'store')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'store'

  let candidate = base
  let suffix = 1
  // eslint-disable-next-line no-await-in-loop
  while (await db('companies').where({ storefront_code: candidate }).first('id')) {
    suffix += 1
    candidate = `${base}-${suffix}`
  }
  return candidate
}

module.exports = { normalizeStorefrontCode, isValidStorefrontCode, generateStorefrontCode }
