/**
 * Migration 037 — customer_accounts approval workflow
 *
 * migration 034 gave customer_accounts a single `is_active` boolean,
 * which already covers exactly one of the four states this feature
 * needs — SUSPENDED (routes/customerAuth.js's existing
 * "This account has been disabled." login block, unchanged) — but has
 * no way to express PENDING vs REJECTED vs APPROVED. Reused where it
 * already fits (`is_active` keeps meaning "disabled/suspended", not
 * duplicated into the new column); a new `status` column covers the
 * three states it can't.
 *
 * Existing rows (every customer_account created before this feature
 * existed, under the old "register = immediately usable" flow) are
 * backfilled to 'approved' — this is purely additive going forward, not
 * a retroactive lockout of customers who were already ordering fine.
 */
exports.up = async (knex) => {
  const hasStatusCol = await knex.schema.hasColumn('customer_accounts', 'status')
  if (hasStatusCol) {
    console.log('[Migration 037] customer_accounts.status already exists, skipping')
    return
  }

  console.log('\n[Migration 037] customer_accounts approval workflow — schema...')

  await knex.schema.alterTable('customer_accounts', (t) => {
    t.enum('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending')
    t.text('rejection_reason')
    t.uuid('reviewed_by').references('id').inTable('users').onDelete('SET NULL')
    t.timestamp('reviewed_at')
    t.index(['company_id', 'status'])
  })

  const backfilled = await knex('customer_accounts').update({ status: 'approved' })
  console.log(`  + customer_accounts.status added; ${backfilled} existing account(s) backfilled to 'approved'`)
}

exports.down = async (knex) => {
  const hasStatusCol = await knex.schema.hasColumn('customer_accounts', 'status')
  if (!hasStatusCol) return
  await knex.schema.alterTable('customer_accounts', (t) => {
    t.dropColumn('status')
    t.dropColumn('rejection_reason')
    t.dropColumn('reviewed_by')
    t.dropColumn('reviewed_at')
  })
}
