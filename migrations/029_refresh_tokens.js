/**
 * Migration 029 — refresh_tokens
 *
 * Server-side tracking for refresh-token sessions (security hardening —
 * see routes/auth.js and utils/refreshTokens.js). Previously refresh
 * tokens were stateless JWTs: valid until natural expiry with no way to
 * revoke a specific session, no rotation, and no reuse/theft detection.
 *
 * The raw token is NEVER stored — only its SHA-256 hash (`token_hash`),
 * so a database read (backup, dump, replica) can't be used to mint valid
 * sessions.
 *
 * `family_id` groups every token descended from one login together via
 * rotation (`POST /auth/refresh` revokes the presented token and issues
 * a new one in the same family). If a token that's already been rotated
 * (`revoked_at` set) is presented again, that's a reuse signal — likely
 * meaning it was stolen and both the legitimate client and an attacker
 * tried to use it — so the entire family is revoked, forcing a fresh
 * login everywhere that family's descendants were active.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 029] refresh_tokens...')

  const hasTable = await knex.schema.hasTable('refresh_tokens')
  if (!hasTable) {
    await knex.schema.createTable('refresh_tokens', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      t.string('token_hash', 64).notNullable() // SHA-256 hex digest — never the raw token
      t.uuid('family_id').notNullable()

      t.timestamp('expires_at').notNullable()
      t.timestamp('revoked_at')
      t.string('revoked_reason', 40) // 'rotated' | 'logout' | 'reuse_detected' | 'admin_revoked' | 'password_changed' | 'account_disabled'
      t.uuid('replaced_by') // id of the token this one was rotated into, for audit trail

      t.string('user_agent', 255)
      t.string('ip', 64)
      t.timestamp('last_used_at')

      t.timestamps(true, true)

      t.unique(['token_hash'])
      t.index(['user_id'])
      t.index(['family_id'])
    })
    console.log('  + created refresh_tokens table')
  } else {
    console.log('  = refresh_tokens table already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('refresh_tokens')
}
