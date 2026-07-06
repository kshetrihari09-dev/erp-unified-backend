/**
 * Migration 015 — Product Barcode
 *
 * Adds a dedicated `barcode` column to `products` so a real-world
 * manufacturer barcode (EAN/UPC/etc, scanned or typed in Product Setup)
 * can be stored separately from `item_code` (the internal, auto-generated
 * SKU used elsewhere in the system).
 *
 * - Nullable: not every product will have a barcode on hand.
 * - Unique per company when present: Postgres unique indexes treat NULLs
 *   as distinct from one another, so any number of products can have a
 *   NULL barcode while non-null barcodes stay unique per company.
 *
 * Purely additive — no existing columns/constraints touched.
 * Safe to run multiple times — checks current state first.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 015] Product barcode...')

  const hasColumn = await knex.schema.hasColumn('products', 'barcode')
  if (!hasColumn) {
    await knex.schema.alterTable('products', (t) => {
      t.string('barcode', 64)
    })
    console.log('  + added products.barcode')
  } else {
    console.log('  = products.barcode already exists, skipping')
  }

  const hasIndex = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'products' AND indexname = 'products_company_barcode_unique'
  `)
  if (hasIndex.rows.length === 0) {
    await knex.raw(`
      CREATE UNIQUE INDEX products_company_barcode_unique
      ON products (company_id, barcode)
      WHERE barcode IS NOT NULL
    `)
    console.log('  + added unique index products_company_barcode_unique')
  } else {
    console.log('  = products_company_barcode_unique already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS products_company_barcode_unique`)
  const hasColumn = await knex.schema.hasColumn('products', 'barcode')
  if (hasColumn) {
    await knex.schema.alterTable('products', (t) => {
      t.dropColumn('barcode')
    })
  }
}
