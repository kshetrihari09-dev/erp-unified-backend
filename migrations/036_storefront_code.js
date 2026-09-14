/**
 * Migration 036 — companies.storefront_code
 *
 * Referenced by routes/companies.js, routes/settings.js, routes/auth.js
 * and routes/storefront.js (and documented in utils/storefrontCode.js)
 * as already existing, but the column itself was never actually created
 * in this codebase snapshot — those routes would 500 on any INSERT/UPDATE
 * touching it and GET /storefront/config?store=... could never resolve
 * anything. This migration is the missing piece, written to match
 * exactly what utils/storefrontCode.js already assumes: a lowercase
 * slug, unique across companies, 2–80 chars of [a-z0-9-].
 *
 * Purely additive — nullable column + backfill for existing rows, no
 * existing column touched, no data loss possible.
 */
exports.up = async (knex) => {
  const hasCol = await knex.schema.hasColumn('companies', 'storefront_code')
  if (hasCol) {
    console.log('[Migration 036] companies.storefront_code already exists, skipping')
    return
  }

  console.log('\n[Migration 036] companies.storefront_code — schema...')

  await knex.schema.alterTable('companies', (t) => {
    t.string('storefront_code', 80).unique()
  })

  // Backfill every existing company with a slug derived from its name,
  // same algorithm as utils/storefrontCode.js#generateStorefrontCode
  // (kept duplicated here deliberately — migrations stay self-contained
  // snapshots, independent of application code that may change later).
  const companies = await knex('companies').select('id', 'name')
  for (const company of companies) {
    const base = String(company.name || 'store')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'store'

    let candidate = base
    let suffix = 1
    // eslint-disable-next-line no-await-in-loop
    while (await knex('companies').where({ storefront_code: candidate }).whereNot({ id: company.id }).first('id')) {
      suffix += 1
      candidate = `${base}-${suffix}`
    }
    // eslint-disable-next-line no-await-in-loop
    await knex('companies').where({ id: company.id }).update({ storefront_code: candidate })
  }

  console.log(`  + companies.storefront_code added and backfilled for ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`)
}

exports.down = async (knex) => {
  const hasCol = await knex.schema.hasColumn('companies', 'storefront_code')
  if (!hasCol) return
  await knex.schema.alterTable('companies', (t) => {
    t.dropColumn('storefront_code')
  })
}
