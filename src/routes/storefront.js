/**
 * routes/storefront.js — Company-Owned Customer architecture (Phase 5).
 *
 * Public, unauthenticated (a customer hasn't registered/logged in yet —
 * this is what lets the register/login pages know which company they're
 * even talking to). Rate-limited the same as every other /api/v1 route
 * (server.js's `app.use(API, generalLimiter)` already covers this router).
 *
 * Resolution order (mirrors spec §3), highest priority first:
 *   1. `?store=<storefront_code>` — the production mechanism. A slug, not
 *      a UUID: safe to put in a real customer-facing URL/QR code
 *      (`/customer/register?store=chandrauta`), and safe to type.
 *   2. `?company=<uuid>` — development/admin fallback ONLY (spec §16/§17).
 *      Rejected outside development unless explicitly re-enabled, so a
 *      production deployment can't have its storefront switched by
 *      editing the URL.
 *
 * Subdomain-based resolution (spec §3, option 1) is NOT implemented: this
 * deployment has no subdomain-per-tenant routing anywhere in the stack
 * (single origin, single Express app — see server.js) and inventing one
 * here would mean guessing at infrastructure that doesn't exist. Flagged
 * as a follow-up, same as it already was for company_id resolution in
 * general (see routes/customerAuth.js's docblock).
 *
 * Response is deliberately minimal — exactly what a storefront needs to
 * render its header and know which company to register/log in against
 * (spec §4: "only safe storefront information"). No settings, no
 * financial figures, no internal flags.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { normalizeStorefrontCode, isValidStorefrontCode } = require('../utils/storefrontCode')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Same "clean config error, never a raw DB error" shape as
// routes/customerAuth.js's resolveActiveCompany — a missing/invalid/
// inactive store all read as the same generic "not found" so a prober
// can't distinguish "no such slug" from "deactivated company".
function notFound(res) {
  return res.status(404).json({ success: false, message: 'This store is currently unavailable.' })
}

function toSafeStore(company) {
  return {
    company_id: company.id, // needed by the frontend to call /customer-auth/register|login — never customer-entered, see spec §4
    name: company.name,
    logo: company.logo_url || null,
    phone: company.phone || null,
    address: company.address || null,
    storefront_code: company.storefront_code || null,
  }
}

router.get('/config', async (req, res, next) => {
  try {
    const storeParam = normalizeStorefrontCode(req.query.store || '')
    const companyParam = String(req.query.company || '').trim()

    let company = null

    if (storeParam) {
      if (!isValidStorefrontCode(storeParam)) return notFound(res)
      company = await db('companies')
        .where({ storefront_code: storeParam })
        .first('id', 'name', 'logo_url', 'phone', 'address', 'storefront_code', 'is_active')
    } else if (companyParam) {
      // Dev/admin fallback (spec §16). Disabled in production unless an
      // operator has explicitly opted back in — e.g. a staging environment
      // that's technically NODE_ENV=production but still needs it. Default
      // is "off", matching spec §17 ("disable arbitrary ?company= switching
      // in production if possible").
      const allowFallback = process.env.NODE_ENV !== 'production' || process.env.ALLOW_STOREFRONT_COMPANY_FALLBACK === 'true'
      if (!allowFallback) return notFound(res)
      if (!UUID_RE.test(companyParam)) return notFound(res)
      company = await db('companies')
        .where({ id: companyParam })
        .first('id', 'name', 'logo_url', 'phone', 'address', 'storefront_code', 'is_active')
    } else {
      return res.status(400).json({ success: false, message: 'Store configuration is unavailable. Please contact the store administrator.' })
    }

    if (!company || company.is_active === false) return notFound(res)

    return res.json({ success: true, store: toSafeStore(company) })
  } catch (err) { next(err) }
})

module.exports = router
