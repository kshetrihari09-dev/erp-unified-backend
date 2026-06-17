/**
 * Migration 006 — Phone OTP Authentication
 *
 * Changes:
 *   users     — add phone_verified, relax email/password constraints for phone-signup users
 *   otp_codes — new table for OTP storage (hashed, with expiry + attempt tracking)
 *
 * Preserves all existing users and login flows.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 006] Phone OTP Authentication...')

  // ── 1. Patch users table ────────────────────────────────────────────────────
  const hasPhoneVerified = await knex.schema.hasColumn('users', 'phone_verified')
  if (!hasPhoneVerified) {
    await knex.schema.alterTable('users', (t) => {
      t.boolean('phone_verified').defaultTo(false).after('phone')
    })
    console.log('  ✓ Added users.phone_verified')
  }

  // Make password_hash nullable to support phone-only signups
  await knex.raw(`
    ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL
  `)
  console.log('  ✓ Made users.password_hash nullable (phone-signup users may have no password)')

  // Unique index on phone (globally unique across tenants for OTP login)
  const phoneIndexExists = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'users' AND indexname = 'users_phone_unique'
    LIMIT 1
  `)
  if (!phoneIndexExists.rows.length) {
    // Partial unique index: only enforce uniqueness for non-null phone values
    await knex.raw(`
      CREATE UNIQUE INDEX users_phone_unique
      ON users (phone)
      WHERE phone IS NOT NULL
    `)
    console.log('  ✓ Created unique partial index: users(phone) WHERE phone IS NOT NULL')
  }

  // ── 2. Create otp_codes table ───────────────────────────────────────────────
  const otpExists = await knex.schema.hasTable('otp_codes')
  if (!otpExists) {
    await knex.schema.createTable('otp_codes', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.string('phone', 20).notNullable()
      // Store bcrypt hash of the OTP — never plain text
      t.string('otp_hash', 255).notNullable()
      t.timestamp('expires_at').notNullable()
      t.integer('attempts').defaultTo(0)
      t.boolean('used').defaultTo(false)
      t.string('purpose', 30).notNullable().defaultTo('signup') // 'signup' | 'login' | 'add_phone'
      t.string('ip_address', 45)
      t.timestamps(true, true)

      t.index('phone')
      t.index('expires_at')
    })
    console.log('  ✓ Created table: otp_codes')
  }

  // ── 3. Create otp_rate_limits table ────────────────────────────────────────
  const rateLimitExists = await knex.schema.hasTable('otp_rate_limits')
  if (!rateLimitExists) {
    await knex.schema.createTable('otp_rate_limits', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.string('phone', 20).notNullable()
      t.integer('request_count').defaultTo(0)
      t.timestamp('window_start').notNullable()
      t.timestamps(true, true)

      t.unique('phone')
      t.index('window_start')
    })
    console.log('  ✓ Created table: otp_rate_limits')
  }

  console.log('\n[Migration 006] Done ✓\n')
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('otp_rate_limits')
  await knex.schema.dropTableIfExists('otp_codes')
  await knex.raw(`DROP INDEX IF EXISTS users_phone_unique`)
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('phone_verified')
  })
  // Re-apply NOT NULL on password_hash
  await knex.raw(`ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL`)
  console.log('[Migration 006] down: phone OTP tables removed, users patched back.')
}
