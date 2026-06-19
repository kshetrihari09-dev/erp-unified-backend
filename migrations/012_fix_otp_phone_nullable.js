/**
 * Migration 012 — Fix otp_codes.phone NOT NULL constraint
 *
 * Bug history:
 *   Migration 006 created otp_codes.phone as varchar(20) NOT NULL.
 *   Migration 007 added otp_codes.destination (varchar 255) to hold
 *   either a phone number OR an email address, and its header comment
 *   claimed it would "make phone nullable" — but the actual ALTER
 *   statement was never written, so `phone` stayed NOT NULL.
 *
 *   otpService.create() was unconditionally writing the full
 *   `destination` value into `phone` for backward compat. When the OTP
 *   method was 'email', `destination` held an email address — often
 *   longer than 20 characters — causing:
 *     "value too long for type character varying(20)"
 *
 *   otpService.create() has been fixed to only populate `phone` for
 *   sms/whatsapp methods (truncated defensively to 20 chars), and to
 *   leave it NULL for email-method OTPs. This migration makes that
 *   possible by actually relaxing the NOT NULL constraint.
 *
 * Safe to run multiple times — checks current nullability first.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 012] Fix otp_codes.phone NOT NULL constraint...')

  const hasTable = await knex.schema.hasTable('otp_codes')
  if (!hasTable) {
    console.log('  – otp_codes table does not exist, skipping')
    return
  }

  const col = await knex.raw(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'otp_codes' AND column_name = 'phone'
  `)

  if (col.rows.length === 0) {
    console.log('  – otp_codes.phone column does not exist, skipping')
    return
  }

  if (col.rows[0].is_nullable === 'NO') {
    await knex.schema.alterTable('otp_codes', (t) => {
      t.string('phone', 20).nullable().alter()
    })
    console.log('  ✓ Made otp_codes.phone nullable')
  } else {
    console.log('  – otp_codes.phone is already nullable, nothing to do')
  }
}

exports.down = async (knex) => {
  // Intentionally not reverted — re-imposing NOT NULL would break any
  // email-method OTP rows inserted after this migration ran.
  console.log('[Migration 012] down: no-op (re-imposing NOT NULL would break existing email OTP rows)')
}
