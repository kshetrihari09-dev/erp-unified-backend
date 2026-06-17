/**
 * Migration 008 — Product name prefix-search index
 *
 * Adds a trigram (pg_trgm) index on products.name so that
 *   WHERE name ILIKE 'prefix%'
 * executes in O(log n) rather than O(n) even with 100k+ products.
 *
 * pg_trgm supports both LIKE and ILIKE prefix patterns when the
 * gin_trgm_ops operator class is used, making it ideal for pharmacy
 * inventories where names start with drug prefixes like "Para", "Amox", etc.
 *
 * Also adds a plain btree index on (company_id, is_active, name) which
 * the query planner can use when filtering by company + active status.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 008] Product name prefix search index...')

  // ── Enable pg_trgm extension (idempotent) ─────────────────────────────────
  try {
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    console.log('  ✓ pg_trgm extension enabled')
  } catch (err) {
    console.warn('  ⚠ pg_trgm extension not available — trigram index skipped')
    console.warn('    Prefix search will still work via btree index, just slightly slower')
  }

  // ── GIN trigram index for ILIKE prefix queries ────────────────────────────
  // gin_trgm_ops supports LIKE / ILIKE patterns including prefix (abc%)
  const trigramExists = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'products'
      AND indexname  = 'products_name_trgm_idx'
    LIMIT 1
  `)
  if (!trigramExists.rows.length) {
    try {
      await knex.raw(`
        CREATE INDEX products_name_trgm_idx
        ON products USING gin (name gin_trgm_ops)
      `)
      console.log('  ✓ Created GIN trigram index: products(name)')
    } catch {
      console.warn('  ⚠ Could not create trigram index (pg_trgm unavailable) — continuing')
    }
  } else {
    console.log('  ✓ Trigram index already exists')
  }

  // ── Composite btree index: company_id + is_active + name ─────────────────
  // Covers the full WHERE clause:
  //   WHERE company_id = $1 AND is_active = true AND name ILIKE 'prefix%'
  // The name column at position 3 allows prefix range scans on btree.
  const btreeExists = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'products'
      AND indexname  = 'products_company_active_name_idx'
    LIMIT 1
  `)
  if (!btreeExists.rows.length) {
    await knex.raw(`
      CREATE INDEX products_company_active_name_idx
      ON products (company_id, is_active, name)
    `)
    console.log('  ✓ Created btree index: products(company_id, is_active, name)')
  } else {
    console.log('  ✓ Btree index already exists')
  }

  console.log('\n[Migration 008] Done ✓\n')
}

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS products_name_trgm_idx')
  await knex.raw('DROP INDEX IF EXISTS products_company_active_name_idx')
  console.log('[Migration 008] down: product search indexes dropped.')
}
