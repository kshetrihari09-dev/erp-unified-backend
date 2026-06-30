/**
 * Migration 013 — Fix otp_rate_limits.phone NOT NULL constraint
 *
 * Bug history:
 *   Migration 006 created otp_rate_limits.phone as varchar(20) NOT NULL.
 *   Migration 007 added otp_rate_limits.destination (varchar 255) to key
 *   rate limits by either a phone number OR an email address — but, just
 *   like the otp_codes table before migration 012, it never relaxed the
 *   old `phone` column's NOT NULL/length constraint.
 *
 *   otpService._incrementRateLimit() was unconditionally writing the full
 *   `destination` value into `phone` for backward compat. When the OTP
 *   method was 'email', `destination` held an email address — often
 *   longer than 20 characters — causing:
 *     "value too long for type character varying(20)"
 *
 *   otpService._incrementRateLimit() has been fixed (mirroring create()'s
 *   existing guard for otp_codes.phone) to only populate `phone` for
 *   sms/whatsapp methods, and to leave it NULL for email-method requests.
 *   This migration makes that possible by actually relaxing the NOT NULL
 *   constraint on otp_rate_limits.phone.
 *
 * Safe to run multiple times — checks current nullability first.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 013] Fix otp_rate_limits.phone NOT NULL constraint...')

  const hasTable = await knex.schema.hasTable('otp_rate_limits')
  if (!hasTable) {
    console.log('  – otp_rate_limits table does not exist, skipping')
    return
  }

  const col = await knex.raw(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'otp_rate_limits' AND column_name = 'phone'
  `)

  if (col.rows.length === 0) {
    console.log('  – otp_rate_limits.phone column does not exist, skipping')
    return
  }

  if (col.rows[0].is_nullable === 'NO') {
    await knex.schema.alterTable('otp_rate_limits', (t) => {
      t.string('phone', 20).nullable().alter()
    })
    console.log('  ✓ Made otp_rate_limits.phone nullable')
  } else {
    console.log('  – otp_rate_limits.phone is already nullable, nothing to do')
  }

  console.log('\n[Migration 013] Done ✓\n')
}

exports.down = async (knex) => {
  // Intentionally not reverted — re-imposing NOT NULL would break any
  // email-method rate-limit rows inserted after this migration ran.
  console.log('[Migration 013] down: no-op (re-imposing NOT NULL would break existing email rate-limit rows)')
}
