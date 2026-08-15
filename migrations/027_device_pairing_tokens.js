/**
 * Migration 027 — device_pairing_tokens
 *
 * Backs the QR pairing flow (Settings → Devices → Add Device → Show QR /
 * Connect → Scan QR): an already-authenticated device requests a
 * short-lived, single-use token; the QR encodes just that token plus the
 * LAN URL to reach this server; the new device scans it and exchanges the
 * token for its own device registration. The token itself carries none of
 * the things the spec explicitly forbids in the QR payload — no DB
 * password, no long-lived JWT, no secret key — it's only ever a random
 * opaque string that this table maps back to a company/branch/user and an
 * expiry.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 027] device_pairing_tokens...')

  const hasTable = await knex.schema.hasTable('device_pairing_tokens')
  if (!hasTable) {
    await knex.schema.createTable('device_pairing_tokens', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      // The token string itself — random, opaque, shown only inside the QR
      // image (never printed as plain readable text) and never reused
      // once consumed. Deliberately separate from `id` so the primary key
      // stays a normal uuid even though the token's own format could
      // change later without an id migration.
      t.string('token', 128).notNullable()
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('branch_id').nullable()
      t.uuid('created_by').notNullable().references('id').inTable('users').onDelete('CASCADE')

      t.timestamp('expires_at').notNullable()
      t.timestamp('used_at')
      t.uuid('used_by_device_id')

      t.timestamps(true, true)

      t.unique(['token'])
      t.index(['company_id', 'expires_at'])
    })
    console.log('  + created device_pairing_tokens table')
  } else {
    console.log('  = device_pairing_tokens table already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('device_pairing_tokens')
}
