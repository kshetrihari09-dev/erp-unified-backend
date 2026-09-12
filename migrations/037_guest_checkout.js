/**
 * Migration 037 — Guest checkout (Customer Product Ordering, spec §14).
 *
 * "Browse → Cart → Checkout → Guest OR Login/Register" — a guest never
 * gets a `customer_accounts` row (no login, no password), but every
 * order still needs a `parties` row so the rest of the system (staff
 * order confirmation → routes/sales.js's createSaleHandler, the ledger,
 * adminCustomerOrders.js's existing join to `parties`) keeps working
 * completely unmodified: a guest checkout auto-creates an ordinary
 * `parties` row (type='customer') at order time, exactly the same shape
 * routes/customerAuth.js's /register already creates — it simply never
 * gets a matching `customer_accounts` login attached.
 *
 * That means the ONLY schema change actually needed is making
 * `customer_orders.customer_account_id` nullable (a guest order has no
 * account to point at) plus a small `is_guest` flag so staff can tell
 * the two apart at a glance without inferring it from a null column.
 * `party_id` stays NOT NULL — no relaxation needed there at all.
 */

exports.up = async (knex) => {
  console.log('\n[Migration 037] Guest checkout...')

  const hasIsGuest = await knex.schema.hasColumn('customer_orders', 'is_guest')
  if (!hasIsGuest) {
    await knex.schema.alterTable('customer_orders', (t) => {
      t.boolean('is_guest').notNullable().defaultTo(false)
      t.index(['company_id', 'is_guest'])
    })
    console.log('  + customer_orders.is_guest added')
  } else {
    console.log('  = customer_orders.is_guest already exists, skipping')
  }

  // customer_account_id was NOT NULL (migration 034) — every order until
  // now belonged to a logged-in customer. Relaxing it, not dropping/
  // recreating the column, so every existing row's value is untouched.
  // Same raw information_schema check + .alter() pattern as migrations
  // 012/013 (the codebase's own precedent for this exact kind of change).
  const col = await knex.raw(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'customer_orders' AND column_name = 'customer_account_id'
  `)
  if (col.rows.length && col.rows[0].is_nullable === 'NO') {
    await knex.schema.alterTable('customer_orders', (t) => {
      t.uuid('customer_account_id').nullable().alter()
    })
    console.log('  + customer_orders.customer_account_id relaxed to nullable')
  } else {
    console.log('  = customer_orders.customer_account_id already nullable, skipping')
  }
}

exports.down = async (knex) => {
  // Deliberately not reversed: by the time anyone would run `down`, real
  // guest orders (customer_account_id IS NULL) may already exist, and
  // silently restoring NOT NULL would break them (same reasoning as
  // migration 012's down being a no-op). Reversing this cleanly requires
  // a data decision (delete guest orders? backfill a dummy account?)
  // that belongs to whoever runs the rollback, not to this migration.
  const hasIsGuest = await knex.schema.hasColumn('customer_orders', 'is_guest')
  if (hasIsGuest) {
    await knex.schema.alterTable('customer_orders', (t) => {
      t.dropColumn('is_guest')
    })
  }
}
