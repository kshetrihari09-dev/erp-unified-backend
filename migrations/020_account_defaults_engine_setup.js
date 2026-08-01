/**
 * Migration 020 — Engine Setup auto-defaults
 *
 * Adds two additive, nullable/defaulted columns to the existing
 * `account_defaults` table so the Accounting Engine Setup page can:
 *
 *   1. Tell the user which mappings were auto-assigned by the system
 *      vs. manually chosen (`is_default`).
 *   2. Offer a "Reset to Default" action that restores the original
 *      system-assigned account even after a user has changed it
 *      (`default_account_id`).
 *
 * Nothing here touches existing rows' `account_id` / `role` values,
 * PostingEngine behaviour, vouchers, or journal entries. Existing rows
 * simply get is_default=false / default_account_id=NULL (i.e. "manually
 * set, no known default to reset to") until they're touched again.
 */

exports.up = async (knex) => {
  const hasIsDefault = await knex.schema.hasColumn('account_defaults', 'is_default')
  const hasDefaultAccountId = await knex.schema.hasColumn('account_defaults', 'default_account_id')

  if (!hasIsDefault || !hasDefaultAccountId) {
    await knex.schema.table('account_defaults', (t) => {
      if (!hasIsDefault) {
        t.boolean('is_default').notNullable().defaultTo(false)
      }
      if (!hasDefaultAccountId) {
        t.uuid('default_account_id').nullable()
          .references('id').inTable('accounts').onDelete('SET NULL')
      }
    })
  }
}

exports.down = async (knex) => {
  const hasIsDefault = await knex.schema.hasColumn('account_defaults', 'is_default')
  const hasDefaultAccountId = await knex.schema.hasColumn('account_defaults', 'default_account_id')

  await knex.schema.table('account_defaults', (t) => {
    if (hasDefaultAccountId) t.dropColumn('default_account_id')
    if (hasIsDefault) t.dropColumn('is_default')
  })
}
