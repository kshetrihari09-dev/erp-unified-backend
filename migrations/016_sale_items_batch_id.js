/**
 * Migration 016 — sale_items.batch_id
 *
 * Adds a nullable `batch_id` FK on sale_items pointing at the exact
 * inventory_batches row a line item was sold from.
 *
 * Why: sale_items already stores `batch_no` (text), but batch_no alone
 * cannot uniquely identify a batch — purchases/receives insert a new
 * inventory_batches row per lot even when the batch number repeats, so
 * two rows for the same product can share the same batch_no. Recording
 * the exact batch_id lets the Sale flow deduct stock from (and, on
 * cancel, restore stock to) the single batch the user actually picked
 * in the Batch Selection popup — never a different lot of the same
 * batch number.
 *
 * - Nullable: keeps existing sale_items rows (created before this
 *   migration) valid; those fall back to batch_no matching.
 * - ON DELETE SET NULL: never blocks deleting a batch record.
 * - Purely additive — no existing columns/constraints touched.
 * - Safe to run multiple times — checks current state first.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 016] sale_items.batch_id...')

  const hasColumn = await knex.schema.hasColumn('sale_items', 'batch_id')
  if (!hasColumn) {
    await knex.schema.alterTable('sale_items', (t) => {
      t.uuid('batch_id').references('id').inTable('inventory_batches').onDelete('SET NULL')
      t.index('batch_id')
    })
    console.log('  + added sale_items.batch_id')
  } else {
    console.log('  = sale_items.batch_id already exists, skipping')
  }
}

exports.down = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('sale_items', 'batch_id')
  if (hasColumn) {
    await knex.schema.alterTable('sale_items', (t) => {
      t.dropColumn('batch_id')
    })
  }
}
