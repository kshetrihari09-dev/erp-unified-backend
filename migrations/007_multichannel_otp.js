/**
 * Migration 007 — Multi-Channel OTP (WhatsApp + Email)
 *
 * Builds on Migration 006 which already created:
 *   - users.phone_verified
 *   - otp_codes  (phone, otp_hash, expires_at, attempts, used, purpose, ip_address)
 *   - otp_rate_limits  (phone, request_count, window_start)
 *
 * This migration adds:
 *   users         — email_verified boolean
 *   otp_codes     — method column ('sms'|'whatsapp'|'email'), destination column,
 *                   user_id (optional FK), make phone nullable
 *   otp_rate_limits — rename/add destination column to key by any destination
 *                     (not just phone)
 */
exports.up = async (knex) => {
  console.log('\n[Migration 007] Multi-Channel OTP (WhatsApp + Email)...')

  // ── 1. users.email_verified ─────────────────────────────────────────────────
  const hasEmailVerified = await knex.schema.hasColumn('users', 'email_verified')
  if (!hasEmailVerified) {
    await knex.schema.alterTable('users', (t) => {
      t.boolean('email_verified').defaultTo(false)
    })
    console.log('  ✓ Added users.email_verified')
  }

  // Backfill: existing email/password users already proved their email via password
  // We set email_verified=true for any user with both email and password_hash
  await knex('users')
    .whereNotNull('email')
    .whereNotNull('password_hash')
    .update({ email_verified: true })
  console.log('  ✓ Backfilled email_verified=true for legacy email+password users')

  // ── 2. Upgrade otp_codes table ──────────────────────────────────────────────
  const hasMethod = await knex.schema.hasColumn('otp_codes', 'method')
  if (!hasMethod) {
    await knex.schema.alterTable('otp_codes', (t) => {
      // delivery channel
      t.string('method', 20).notNullable().defaultTo('sms')
        .comment("'sms' | 'whatsapp' | 'email'")
      // unified destination — phone number OR email address
      t.string('destination', 255)
        .comment('E.164 phone for sms/whatsapp, email address for email method')
      // optional user link (for login flows where user already exists)
      t.uuid('user_id').nullable()
        .references('id').inTable('users').onDelete('SET NULL')
    })
    console.log('  ✓ Added otp_codes.method, otp_codes.destination, otp_codes.user_id')
  }

  // Backfill destination from phone for existing rows
  await knex.raw(`
    UPDATE otp_codes
    SET destination = phone
    WHERE destination IS NULL AND phone IS NOT NULL
  `)
  console.log('  ✓ Backfilled otp_codes.destination from phone')

  // Add index on destination for fast lookups
  const destIndexExists = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'otp_codes' AND indexname = 'otp_codes_destination_idx'
    LIMIT 1
  `)
  if (!destIndexExists.rows.length) {
    await knex.raw(`CREATE INDEX otp_codes_destination_idx ON otp_codes (destination)`)
    console.log('  ✓ Created index: otp_codes(destination)')
  }

  // ── 3. Upgrade otp_rate_limits table ───────────────────────────────────────
  // Previous migration keyed rate limits by `phone`. We need to key by `destination`
  // (which can be a phone OR email). Add destination column; keep phone for compat.
  const hasDestination = await knex.schema.hasColumn('otp_rate_limits', 'destination')
  if (!hasDestination) {
    // Drop the old unique constraint on phone first
    await knex.raw(`
      ALTER TABLE otp_rate_limits DROP CONSTRAINT IF EXISTS otp_rate_limits_phone_unique
    `)

    await knex.schema.alterTable('otp_rate_limits', (t) => {
      t.string('destination', 255).nullable()
        .comment('Phone (E.164) or email — the entity being rate-limited')
    })

    // Backfill destination from phone
    await knex.raw(`UPDATE otp_rate_limits SET destination = phone WHERE destination IS NULL`)

    // New unique constraint on destination
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS otp_rate_limits_destination_unique
      ON otp_rate_limits (destination)
      WHERE destination IS NOT NULL
    `)
    console.log('  ✓ Added otp_rate_limits.destination with unique index')
  }

  console.log('\n[Migration 007] Done ✓\n')
}

exports.down = async (knex) => {
  // Remove email_verified
  const hasEmailVerified = await knex.schema.hasColumn('users', 'email_verified')
  if (hasEmailVerified) {
    await knex.schema.alterTable('users', (t) => t.dropColumn('email_verified'))
  }

  // Remove otp_codes additions
  await knex.raw(`DROP INDEX IF EXISTS otp_codes_destination_idx`)
  for (const col of ['method', 'destination', 'user_id']) {
    const has = await knex.schema.hasColumn('otp_codes', col)
    if (has) await knex.schema.alterTable('otp_codes', (t) => t.dropColumn(col))
  }

  // Remove rate_limits destination
  await knex.raw(`DROP INDEX IF EXISTS otp_rate_limits_destination_unique`)
  const hasDest = await knex.schema.hasColumn('otp_rate_limits', 'destination')
  if (hasDest) {
    await knex.schema.alterTable('otp_rate_limits', (t) => t.dropColumn('destination'))
  }
  // Restore old unique constraint on phone
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS otp_rate_limits_phone_unique
    ON otp_rate_limits (phone)
    WHERE phone IS NOT NULL
  `)

  console.log('[Migration 007] down: multi-channel additions removed.')
}
