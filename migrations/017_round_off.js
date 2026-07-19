/**
 * Migration 017 — sales.round_off / purchases.round_off
 *
 * Adds the "Round Off" feature: after subtotal, discount, tax (cc_amount)
 * etc. are computed, the invoice's net_total is rounded to the nearest
 * whole number and the (rounded - unrounded) difference is stored here.
 *
 * - Nullable-safe: NOT NULL with DEFAULT 0, so every pre-existing sale/
 *   purchase row is automatically backfilled with round_off = 0 — i.e.
 *   "no rounding was applied", which is the correct, backward-compatible
 *   value for invoices posted before this feature existed.
 * - Purely additive — no existing column, constraint, or index touched.
 * - Does not change subtotal/discount_amount/cc_amount/vat_amount or any
 *   other existing column; net_total keeps meaning "grand total actually
 *   charged" (now inclusive of round_off, same as before this migration
 *   net_total was just the unrounded grand total).
 * - Safe to run multiple times — checks current state first.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 017] round_off...')

  const salesHasCol = await knex.schema.hasColumn('sales', 'round_off')
  if (!salesHasCol) {
    await knex.schema.alterTable('sales', (t) => {
      t.decimal('round_off', 10, 2).notNullable().defaultTo(0)
    })
    console.log('  + added sales.round_off')
  } else {
    console.log('  = sales.round_off already exists, skipping')
  }

  const purchasesHasCol = await knex.schema.hasColumn('purchases', 'round_off')
  if (!purchasesHasCol) {
    await knex.schema.alterTable('purchases', (t) => {
      t.decimal('round_off', 10, 2).notNullable().defaultTo(0)
    })
    console.log('  + added purchases.round_off')
  } else {
    console.log('  = purchases.round_off already exists, skipping')
  }
}

exports.down = async (knex) => {
  const salesHasCol = await knex.schema.hasColumn('sales', 'round_off')
  if (salesHasCol) {
    await knex.schema.alterTable('sales', (t) => t.dropColumn('round_off'))
  }
  const purchasesHasCol = await knex.schema.hasColumn('purchases', 'round_off')
  if (purchasesHasCol) {
    await knex.schema.alterTable('purchases', (t) => t.dropColumn('round_off'))
  }
}
