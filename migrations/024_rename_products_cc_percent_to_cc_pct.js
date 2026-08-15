/**
 * Migration 024 — Rename products.cc_percent → products.cc_pct
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `sale_items`, `purchase_items`, and `manufacturers` have always used
 * `cc_pct` as the column name for the C.C% field (see migration 002).
 * Only `products` was the odd one out, still called `cc_percent` — the
 * backend and frontend both had to alias it (`cc_percent as cc_pct`) in
 * every read path just to keep the field name consistent for callers.
 * This migration renames the column itself so `cc_pct` is the single real
 * name everywhere, and the alias hacks can be removed.
 *
 * A plain column rename (not drop + add) is used so every existing row's
 * C.C% value is preserved exactly as-is — no data loss, no duplicate
 * column, no backfill needed.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 024] Rename products.cc_percent -> products.cc_pct...')

  const hasOld = await knex.schema.hasColumn('products', 'cc_percent')
  const hasNew = await knex.schema.hasColumn('products', 'cc_pct')

  if (hasOld && !hasNew) {
    await knex.schema.alterTable('products', (t) => {
      t.renameColumn('cc_percent', 'cc_pct')
    })
    console.log('  + renamed products.cc_percent -> products.cc_pct')
  } else if (hasNew) {
    console.log('  = products.cc_pct already exists, skipping')
  } else {
    console.log('  ! products.cc_percent not found, nothing to rename')
  }
}

exports.down = async (knex) => {
  const hasNew = await knex.schema.hasColumn('products', 'cc_pct')
  const hasOld = await knex.schema.hasColumn('products', 'cc_percent')

  if (hasNew && !hasOld) {
    await knex.schema.alterTable('products', (t) => {
      t.renameColumn('cc_pct', 'cc_percent')
    })
  }
}
