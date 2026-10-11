/**
 * Migration 040 — Online shopping removal (NON-DESTRUCTIVE).
 *
 * The online storefront, customer ordering and delivery-partner modules were
 * removed from the application code. This migration deliberately does NOT
 * drop any table or column and does not delete a single row:
 *
 *   customer_accounts, customer_orders, customer_order_items,
 *   customer_cart_items, products.is_online / online_* columns,
 *   companies.storefront_code
 *
 * all stay in place (unused by the application) so historical order data is
 * preserved and nothing irreversible happens without explicit authorization.
 * Sales, invoices, stock movements and parties created from past online
 * orders are core billing records and are untouched.
 *
 * The one thing it does: rider accounts (users.role = 'delivery_partner')
 * have no back-office access any more, so they are DEACTIVATED (is_active =
 * false). They are NOT demoted — a 'viewer' role would grant read access to
 * billing data. The affected user ids are recorded in
 * `shopping_removal_backup` so `down` can re-activate exactly those users.
 *
 * To physically drop the obsolete tables/columns (after a verified backup and
 * explicit sign-off), see scripts/optional/drop_online_shopping_tables.sql.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 040] Online shopping removal (non-destructive)...')

  if (!(await knex.schema.hasTable('shopping_removal_backup'))) {
    await knex.schema.createTable('shopping_removal_backup', (t) => {
      t.uuid('user_id').primary()
      t.string('previous_role', 50).notNullable()
      t.boolean('was_active').notNullable()
      t.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now())
    })
  }

  const riders = await knex('users').where({ role: 'delivery_partner' }).select('id', 'role', 'is_active')
  for (const r of riders) {
    await knex('shopping_removal_backup')
      .insert({ user_id: r.id, previous_role: r.role, was_active: r.is_active })
      .onConflict('user_id').ignore()
  }
  if (riders.length) {
    await knex('users').whereIn('id', riders.map(r => r.id)).update({ is_active: false })
  }
  console.log(`  + ${riders.length} delivery_partner account(s) deactivated`)
  console.log('[Migration 040] done. No tables/columns/rows were deleted.\n')
}

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('shopping_removal_backup'))) return
  const rows = await knex('shopping_removal_backup').select('user_id', 'was_active')
  const reactivate = rows.filter(r => r.was_active).map(r => r.user_id)
  if (reactivate.length) {
    await knex('users').whereIn('id', reactivate).update({ is_active: true })
  }
  await knex.schema.dropTableIfExists('shopping_removal_backup')
}
