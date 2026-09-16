/**
 * Migration 038 — Delivery OTP Verification.
 *
 * Purely additive. Nothing existing is dropped, renamed, or re-typed.
 *
 * Three pieces:
 *
 *  1. users.role += 'delivery_partner'
 *     A rider is a staff-side principal, not a customer: they log in
 *     through the existing `authenticate` middleware with an ordinary
 *     `users` row, scoped to one company by users.company_id exactly
 *     like every other staff member. That means company isolation,
 *     password hashing, deactivation, and the Settings → Users screen
 *     all apply to riders for free, with no second auth realm to keep
 *     in sync. knex's `t.enum()` on Postgres is varchar + CHECK (no
 *     native enum type anywhere in this codebase — see knexfile.js,
 *     which never sets useNative), so widening it is a constraint swap,
 *     the same shape as migration 011's payment_mode fix.
 *
 *  2. customer_orders.status += 'out_for_delivery', 'delivered'
 *     The existing flow (pending → confirmed → processing → ready →
 *     completed) is untouched and remains the whole story for PICKUP
 *     orders. DELIVERY orders now continue past `ready` into
 *     `out_for_delivery` → `delivered`. `delivered` is the delivery
 *     branch's terminal state, the peer of `completed` — not a stage
 *     before it — so no existing pickup order changes meaning and no
 *     existing row needs backfilling.
 *
 *  3. customer_orders.delivery_otp_* / assignment / delivery columns
 *     Added to the existing order row rather than a new table (spec
 *     §22): there is exactly one live delivery OTP per order at any
 *     time, so a side table would be a 1:1 join for no gain. History
 *     lives in `audit_log`, which this feature writes to on every OTP
 *     event (generate / resend / fail / lock / verify / override) —
 *     never with the code itself in the payload.
 *
 * On why there are TWO stored forms of the OTP (hash + secret):
 *   delivery_otp_hash   — bcrypt, and the ONLY thing verification ever
 *                         compares against. A leaked database row does
 *                         not yield a usable code from this column.
 *   delivery_otp_secret — AES-256-GCM ciphertext (utils/otpCrypto.js),
 *                         readable only by the customer who owns the
 *                         order, only while it is out for delivery.
 *
 *   The second column exists because the customer has to be able to
 *   READ their own code on the tracking page after a page refresh, and
 *   a bcrypt hash is by definition unreadable. The alternative — code
 *   shown once and never again — breaks the moment the customer closes
 *   the tab, which on a phone at a doorstep is the normal case, not the
 *   edge case. Verification never touches this column, so the weaker
 *   (reversible) form is never on the authentication path.
 */

exports.up = async (knex) => {
  console.log('\n[Migration 038] Delivery OTP Verification...')

  // ── 1. users.role += delivery_partner ───────────────────────────────────
  // DROP IF EXISTS + ADD in one statement so the table is never left
  // unconstrained between the two, even if this migration fails midway.
  await knex.raw(`
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_role_check,
      ADD CONSTRAINT users_role_check
        CHECK (role IN ('owner','admin','accountant','cashier','auditor','viewer','delivery_partner'))
  `)
  console.log('  + users.role now accepts delivery_partner')

  // ── 2. customer_orders.status += out_for_delivery, delivered ────────────
  await knex.raw(`
    ALTER TABLE customer_orders
      DROP CONSTRAINT IF EXISTS customer_orders_status_check,
      ADD CONSTRAINT customer_orders_status_check
        CHECK (status IN ('pending','confirmed','processing','ready','out_for_delivery','delivered','completed','cancelled'))
  `)
  console.log('  + customer_orders.status now accepts out_for_delivery, delivered')

  // ── 3. delivery assignment + OTP columns ────────────────────────────────
  const hasOtpHash = await knex.schema.hasColumn('customer_orders', 'delivery_otp_hash')
  if (!hasOtpHash) {
    await knex.schema.alterTable('customer_orders', (t) => {
      // — Assignment —
      // SET NULL, not CASCADE: deleting a rider's user row must never
      // delete the customer's order. The order simply becomes unassigned
      // and staff reassign it.
      t.uuid('assigned_delivery_partner_id').references('id').inTable('users').onDelete('SET NULL')
      t.uuid('delivery_assigned_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('delivery_assigned_at')
      t.timestamp('delivery_arrived_at')

      // — OTP — see this file's docblock on hash vs secret.
      t.string('delivery_otp_hash', 255)
      t.text('delivery_otp_secret')
      t.timestamp('delivery_otp_created_at')
      t.timestamp('delivery_otp_expires_at')
      t.integer('delivery_otp_attempts').notNullable().defaultTo(0)
      t.timestamp('delivery_otp_verified_at')
      t.timestamp('delivery_otp_last_sent_at')
      t.timestamp('delivery_otp_locked_until')
      t.integer('delivery_otp_resend_count').notNullable().defaultTo(0)

      // — Completion —
      // 'otp' when a rider verified the customer's code; 'override' when
      // an owner/admin completed it manually (always with a reason and
      // an audit row — see routes/adminCustomerOrders.js).
      t.enum('delivery_verification_method', ['otp', 'override'])
      t.string('delivery_override_reason', 500)
      t.uuid('delivered_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('delivered_at')

      // The rider's own "my deliveries" list is exactly this index:
      // assigned partner + status, scoped by company.
      t.index(['company_id', 'assigned_delivery_partner_id', 'status'], 'customer_orders_partner_status_idx')
    })
    console.log('  + customer_orders delivery/OTP columns added')
  } else {
    console.log('  = customer_orders delivery/OTP columns already exist, skipping')
  }

  console.log('[Migration 038] done.\n')
}

exports.down = async (knex) => {
  const hasOtpHash = await knex.schema.hasColumn('customer_orders', 'delivery_otp_hash')
  if (hasOtpHash) {
    await knex.schema.alterTable('customer_orders', (t) => {
      t.dropIndex(['company_id', 'assigned_delivery_partner_id', 'status'], 'customer_orders_partner_status_idx')
      t.dropColumn('assigned_delivery_partner_id')
      t.dropColumn('delivery_assigned_by')
      t.dropColumn('delivery_assigned_at')
      t.dropColumn('delivery_arrived_at')
      t.dropColumn('delivery_otp_hash')
      t.dropColumn('delivery_otp_secret')
      t.dropColumn('delivery_otp_created_at')
      t.dropColumn('delivery_otp_expires_at')
      t.dropColumn('delivery_otp_attempts')
      t.dropColumn('delivery_otp_verified_at')
      t.dropColumn('delivery_otp_last_sent_at')
      t.dropColumn('delivery_otp_locked_until')
      t.dropColumn('delivery_otp_resend_count')
      t.dropColumn('delivery_verification_method')
      t.dropColumn('delivery_override_reason')
      t.dropColumn('delivered_by')
      t.dropColumn('delivered_at')
    })
  }

  // Narrow the status constraint back — but only after moving any row
  // that is currently in a status the old constraint forbids, otherwise
  // ADD CONSTRAINT fails outright. An out_for_delivery order goes back
  // to 'ready' (its last pre-038 status); a delivered one becomes
  // 'completed' (the pre-038 terminal state that means the same thing).
  await knex('customer_orders').where({ status: 'out_for_delivery' }).update({ status: 'ready' })
  await knex('customer_orders').where({ status: 'delivered' }).update({ status: 'completed' })

  await knex.raw(`
    ALTER TABLE customer_orders
      DROP CONSTRAINT IF EXISTS customer_orders_status_check,
      ADD CONSTRAINT customer_orders_status_check
        CHECK (status IN ('pending','confirmed','processing','ready','completed','cancelled'))
  `)

  // Same ordering problem for roles: demote riders before narrowing.
  await knex('users').where({ role: 'delivery_partner' }).update({ role: 'viewer' })
  await knex.raw(`
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_role_check,
      ADD CONSTRAINT users_role_check
        CHECK (role IN ('owner','admin','accountant','cashier','auditor','viewer'))
  `)
}
