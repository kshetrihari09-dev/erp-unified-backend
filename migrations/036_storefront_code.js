/**
 * Migration 036 — Storefront slug (Company-Owned Customer architecture, Phase 5)
 *
 * Adds companies.storefront_code: a short, URL-safe slug ("chandrauta")
 * that lets the customer storefront identify its company WITHOUT putting
 * the company UUID in the URL (spec §3/§4 — "the customer should see the
 * store identity, not the database UUID").
 *
 * Purely additive, backward compatible:
 *   - Nullable + unique. Existing `?company=<uuid>` links and the
 *     VITE_STOREFRONT_COMPANY_ID build-time fallback keep working exactly
 *     as before (routes/storefront.js and useStorefrontCompany/StorefrontContext
 *     both still accept a raw UUID as a fallback) — this only ADDS a second,
 *     preferred resolution path.
 *   - Backfilled for every existing company from its name, so every store
 *     gets a working slug (`GET /storefront/config?store=<slug>`) with zero
 *     admin action required; an admin can change it later via
 *     PUT /settings/company or PUT /companies/:id (routes/settings.js,
 *     routes/companies.js).
 */

function slugify(name) {
  return String(name || 'store')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'store'
}

exports.up = async (knex) => {
  console.log('\n[Migration 036] Storefront slug...')

  const hasCol = await knex.schema.hasColumn('companies', 'storefront_code')
  if (!hasCol) {
    await knex.schema.alterTable('companies', (t) => {
      // 60 chars is generous headroom over slugify()'s cap above — kept
      // separate constants on purpose (schema limit vs. generation policy)
      // so tightening the generated length later never requires a migration.
      t.string('storefront_code', 80)
      t.unique(['storefront_code'])
    })
    console.log('  + companies.storefront_code added')
  } else {
    console.log('  = companies.storefront_code already exists, skipping')
  }

  // ── Backfill existing companies ─────────────────────────────────────────
  const companies = await knex('companies').whereNull('storefront_code').select('id', 'name')
  for (const company of companies) {
    const base = slugify(company.name)
    let candidate = base
    let suffix = 1
    // Uniqueness loop: two companies named "Example Pharmacy" would
    // otherwise collide on the unique index above. Rare in practice (a
    // handful of companies per instance), so a simple retry loop is fine —
    // no need for a batched/clever allocation scheme.
    // eslint-disable-next-line no-await-in-loop
    while (await knex('companies').where({ storefront_code: candidate }).first('id')) {
      suffix += 1
      candidate = `${base}-${suffix}`
    }
    // eslint-disable-next-line no-await-in-loop
    await knex('companies').where({ id: company.id }).update({ storefront_code: candidate })
  }
  if (companies.length) console.log(`  + backfilled storefront_code for ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`)
}

exports.down = async (knex) => {
  const hasCol = await knex.schema.hasColumn('companies', 'storefront_code')
  if (hasCol) {
    await knex.schema.alterTable('companies', (t) => {
      t.dropUnique(['storefront_code'])
      t.dropColumn('storefront_code')
    })
  }
}
