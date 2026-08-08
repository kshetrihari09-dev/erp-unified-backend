/**
 * Migration 022 — Step-up authentication (Security PIN)
 *
 * Adds what's needed for a second verification layer on sensitive
 * operations, on top of the EXISTING login/JWT/role/permission system —
 * nothing here replaces or duplicates that architecture (see
 * middleware/index.js requireSensitiveConfirm, already in place before
 * this migration).
 *
 *   pin_hash            — bcrypt hash of a 6-digit PIN. NULL until the
 *                          user sets one (see POST /auth/security-pin).
 *                          Never plaintext, never returned to the client.
 *   pin_set_at          — when the current PIN was created/changed.
 *   pin_failed_attempts — consecutive failed step-up attempts (PIN OR
 *                          password re-entry both count against this —
 *                          they're the same gate). Resets to 0 on any
 *                          success.
 *   pin_locked_until    — set after too many consecutive failures;
 *                          step-up is refused until this timestamp
 *                          passes, regardless of which credential is
 *                          tried. This is a temporary, self-clearing
 *                          lock scoped to step-up only — it never
 *                          touches `is_active` or blocks normal login.
 *
 * Purely additive — no existing column changed, all new columns
 * nullable/defaulted so existing rows and existing login flow are
 * completely unaffected until a user actively sets a PIN.
 */
exports.up = async (knex) => {
  const hasTable = await knex.schema.hasTable('users')
  if (!hasTable) return

  await knex.schema.alterTable('users', t => {
    t.string('pin_hash', 255).nullable()
    t.timestamp('pin_set_at').nullable()
    t.integer('pin_failed_attempts').notNullable().defaultTo(0)
    t.timestamp('pin_locked_until').nullable()
  })
}

exports.down = async (knex) => {
  const hasTable = await knex.schema.hasTable('users')
  if (!hasTable) return

  await knex.schema.alterTable('users', t => {
    t.dropColumn('pin_hash')
    t.dropColumn('pin_set_at')
    t.dropColumn('pin_failed_attempts')
    t.dropColumn('pin_locked_until')
  })
}
