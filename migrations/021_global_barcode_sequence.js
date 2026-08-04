/**
 * Migration 021 — Global barcode sequence (fixes cross-company collisions)
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * `autoBarcode()` (src/utils/helpers.js) used to derive a product's
 * auto-generated barcode from the numeric tail of its `item_code`
 * (MED-001 → seq 1 → "2000000000001..."). `item_code` is only unique
 * *within* a company (`unique(['company_id', 'item_code'])`, migration
 * 002) — every company's first product is MED-001. So two different
 * companies' first products generated the *exact same* auto-barcode
 * value. The existing `products_company_barcode_unique` index
 * (migration 015) never caught this because it's scoped to
 * `(company_id, barcode)` — it only stops one company reusing a barcode
 * twice, not two different companies independently generating the same
 * one. Scanning was already company-scoped (`WHERE company_id = ...`)
 * so this normally didn't cause visible cross-account mix-ups, but any
 * code path, report, or integration that looks up a product by barcode
 * alone (without the company filter) could return the wrong company's
 * product — e.g. CETOPHEN SYP (Company A's MED-001) vs LOMOPLEX
 * (Company B's MED-001) both encoding to the same barcode.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * Auto-generated barcodes are now drawn from `product_auto_barcode_seq`,
 * a single Postgres SEQUENCE shared by every company. A DB sequence's
 * values never repeat, by definition, so two companies' auto-generated
 * barcodes can no longer collide — this isn't "very unlikely to
 * collide", it's structurally impossible. See helpers.js
 * `nextAutoBarcodeSeq()` / `buildAutoBarcode()`.
 *
 * This migration also:
 *  1. Backfills any already-colliding auto-generated barcodes in
 *     existing data (regenerates them from the new global sequence),
 *     so data corrupted by the old bug gets repaired automatically.
 *  2. Adds a *global* unique index — but only over rows whose barcode
 *     matches the recognizable auto-generated pattern (GS1 restricted-
 *     circulation prefix "20" + 13 digits). This is deliberately NOT a
 *     blanket global-unique constraint on `barcode`: real manufacturer
 *     barcodes (typed in or scanned from the physical product) are
 *     legitimately shared across companies — two different pharmacies
 *     both stocking the same branded medicine will scan the same
 *     real-world EAN, and that must stay allowed. Only the internal,
 *     auto-generated codes need (and now get) a global guarantee.
 *
 * Purely additive/corrective — no existing columns dropped, no barcode
 * values changed except ones already colliding across companies.
 * Safe to run multiple times.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 021] Global barcode sequence...')

  // ── 1. Global sequence for auto-generated barcodes ───────────────────
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS product_auto_barcode_seq START WITH 1`)
  console.log('  + ensured product_auto_barcode_seq')

  // ── 2. Backfill: find + repair existing cross-company collisions ─────
  // "Auto-generated pattern" = starts with GS1 internal-use prefix "20",
  // 13 digits total, nothing else (matches buildAutoBarcode()'s output
  // exactly) — never matches a real scanned/typed manufacturer barcode.
  const AUTO_PATTERN = `^20\\d{11}$`

  const colliding = await knex.raw(`
    SELECT barcode
    FROM products
    WHERE barcode ~ ?
    GROUP BY barcode
    HAVING COUNT(DISTINCT company_id) > 1
  `, [AUTO_PATTERN])

  if (colliding.rows.length > 0) {
    console.log(`  ! found ${colliding.rows.length} auto-barcode value(s) shared across companies — repairing`)
    for (const { barcode } of colliding.rows) {
      // Leave exactly one holder of the old value untouched (arbitrary but
      // deterministic: lowest id), regenerate the barcode for every other
      // row currently sharing it.
      const holders = await knex('products')
        .where({ barcode })
        .whereRaw('barcode ~ ?', [AUTO_PATTERN])
        .orderBy('id', 'asc')
        .select('id')

      for (let i = 1; i < holders.length; i++) {
        const { rows } = await knex.raw(`SELECT nextval('product_auto_barcode_seq') AS seq`)
        const seq  = Number(rows[0].seq)
        const body = '20' + String(seq).padStart(10, '0')
        const newBarcode = body + String(ean13CheckDigit(body))
        await knex('products').where({ id: holders[i].id }).update({ barcode: newBarcode })
      }
    }
    console.log('  + repaired colliding auto-generated barcodes')
  } else {
    console.log('  = no cross-company auto-barcode collisions found')
  }

  // ── 3. Global unique index, scoped to the auto-generated pattern only ─
  const hasIndex = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'products' AND indexname = 'products_autobarcode_global_unique'
  `)
  if (hasIndex.rows.length === 0) {
    await knex.raw(`
      CREATE UNIQUE INDEX products_autobarcode_global_unique
      ON products (barcode)
      WHERE barcode ~ '${AUTO_PATTERN}'
    `)
    console.log('  + added global unique index products_autobarcode_global_unique')
  } else {
    console.log('  = products_autobarcode_global_unique already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS products_autobarcode_global_unique`)
  await knex.raw(`DROP SEQUENCE IF EXISTS product_auto_barcode_seq`)
}

// Local copy of the same check-digit function as helpers.js — migrations
// must not depend on application source (they need to stay runnable
// standalone against any historical DB state).
function ean13CheckDigit(digits12) {
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const d = Number(digits12[i])
    sum += (i % 2 === 0) ? d : d * 3
  }
  const mod = sum % 10
  return mod === 0 ? 0 : 10 - mod
}
