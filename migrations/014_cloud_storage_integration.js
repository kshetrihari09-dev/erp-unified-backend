/**
 * Migration 014 — Cloud Storage Integration
 *
 * Adds support for connecting third-party cloud storage providers
 * (Google Drive, OneDrive, Dropbox, ...) per company, for future
 * automatic document backup (invoices, purchase bills, journal
 * entries, receipts, PDFs).
 *
 * This migration is purely additive:
 *   - creates `cloud_storage_connections` (one row per company+provider)
 *   - creates `cloud_storage_oauth_states` (short-lived CSRF state for
 *     the OAuth 2.0 authorization-code flow)
 *
 * No existing tables, columns, or constraints are touched. Nothing here
 * affects accounting, posting, or any other existing business logic.
 *
 * Safe to run multiple times — checks current state first.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 014] Cloud storage integration...')

  const hasConnections = await knex.schema.hasTable('cloud_storage_connections')
  if (!hasConnections) {
    await knex.schema.createTable('cloud_storage_connections', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')

      // Which provider this row represents, e.g. 'google_drive' | 'onedrive' | 'dropbox'.
      // Kept as a free-form string (not an enum) so new providers can be
      // registered later without a schema migration.
      t.string('provider', 50).notNullable()

      // Connection / token state. Tokens are encrypted at rest (AES-256-GCM)
      // by the application layer before being written here — this column
      // never holds plaintext tokens.
      t.text('access_token_encrypted')
      t.text('refresh_token_encrypted')
      t.timestamp('token_expires_at')

      // Account/profile info from the provider, for display in Settings.
      t.string('account_email', 255)
      t.string('account_display_name', 255)
      t.string('provider_account_id', 255) // provider's own user/account id

      // User-configurable behavior.
      t.string('folder_name', 255).defaultTo('Accounting Documents')
      t.string('folder_id', 255) // provider-specific folder id, once resolved
      t.boolean('auto_upload_enabled').notNullable().defaultTo(false)
      t.boolean('is_default').notNullable().defaultTo(false)

      // Status bookkeeping.
      t.string('status', 20).notNullable().defaultTo('disconnected') // disconnected|connected|expired|error
      t.timestamp('last_sync_at')
      t.string('last_sync_status', 20) // success|failed
      t.text('last_error_message')

      t.uuid('connected_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('connected_at')
      t.timestamps(true, true)

      t.unique(['company_id', 'provider'])
    })
    console.log('  ✓ created cloud_storage_connections')
  } else {
    console.log('  – cloud_storage_connections already exists, skipping')
  }

  const hasOauthStates = await knex.schema.hasTable('cloud_storage_oauth_states')
  if (!hasOauthStates) {
    await knex.schema.createTable('cloud_storage_oauth_states', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
      t.string('state', 128).notNullable().unique()
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      t.string('provider', 50).notNullable()
      t.string('code_verifier', 255) // for PKCE, if used by a given provider
      t.timestamp('expires_at').notNullable()
      t.timestamps(true, true)
    })
    console.log('  ✓ created cloud_storage_oauth_states')
  } else {
    console.log('  – cloud_storage_oauth_states already exists, skipping')
  }

  console.log('[Migration 014] Done.\n')
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('cloud_storage_oauth_states')
  await knex.schema.dropTableIfExists('cloud_storage_connections')
}
