/**
 * Migration 043 — purchase_items.discount_pct
 *
 * The Purchase page now supports the same discount scopes as the Sale page
 * (Invoice / Company / Product). Whatever scope is used, it resolves to a
 * per-line discount_pct before posting — exactly how sale_items already
 * works — so purchase_items needs the same column (decimal(5,2), default 0).
 *
 * Existing rows get 0, i.e. no discount, which matches how they were saved.
 */
exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('purchase_items', 'discount_pct')
  if (!has) {
    await knex.schema.alterTable('purchase_items', (t) => {
      t.decimal('discount_pct', 5, 2).notNullable().defaultTo(0)
    })
    console.log('[Migration 043] + added purchase_items.discount_pct')
  }
}

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('purchase_items', 'discount_pct')
  if (has) await knex.schema.alterTable('purchase_items', (t) => t.dropColumn('discount_pct'))
}
