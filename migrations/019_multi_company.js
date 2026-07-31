/**
 * Migration 019 — Multi-Company Support
 *
 * Adds the ability for a single user account to belong to (and switch
 * between) multiple companies, while reusing the existing `company_id`
 * scoping architecture for all business data (sales, purchases, vouchers,
 * accounts, parties, etc.) — nothing about how those tables are isolated
 * changes.
 *
 * New tables/columns:
 *   - user_companies:  many-to-many bridge between users and companies.
 *                       `is_default` marks the company that should load
 *                       first after login for that user.
 *   - users.last_active_company_id:  remembers the last company a user
 *                       had selected, so a page refresh / re-login can
 *                       restore it (falls back to the default company,
 *                       then to `users.company_id`, if unset or stale).
 *
 * Backward compatibility:
 *   Every existing user gets exactly one membership row pointing at their
 *   current `users.company_id`, marked as default. This reproduces
 *   today's single-company behavior exactly — nothing changes for users
 *   who never create a second company. `users.company_id` itself is left
 *   untouched (still the user's original/home company) so nothing that
 *   reads it elsewhere breaks.
 */
exports.up = async (knex) => {
  await knex.schema.createTable('user_companies', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.boolean('is_default').notNullable().defaultTo(false)
    t.timestamps(true, true)
    t.unique(['user_id', 'company_id'])
    t.index('user_id')
    t.index('company_id')
  })

  const hasCol = await knex.schema.hasColumn('users', 'last_active_company_id')
  if (!hasCol) {
    await knex.schema.alterTable('users', (t) => {
      t.uuid('last_active_company_id').references('id').inTable('companies').onDelete('SET NULL')
    })
  }

  // Backfill — give every existing user membership to their current home
  // company, marked as default. ON CONFLICT guards re-running safely.
  await knex.raw(`
    INSERT INTO user_companies (user_id, company_id, is_default)
    SELECT id, company_id, true FROM users
    ON CONFLICT (user_id, company_id) DO NOTHING
  `)

  await knex.raw(`
    UPDATE users SET last_active_company_id = company_id
    WHERE last_active_company_id IS NULL
  `)
}

exports.down = async (knex) => {
  const hasCol = await knex.schema.hasColumn('users', 'last_active_company_id')
  if (hasCol) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('last_active_company_id')
    })
  }
  await knex.schema.dropTableIfExists('user_companies')
}
