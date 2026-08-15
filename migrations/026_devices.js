/**
 * Migration 026 — devices
 *
 * One row per installed app instance (phone/tablet/POS terminal) that has
 * registered for offline billing + LAN/cloud sync. This is the server-side
 * half of the client's existing `getDeviceId()` (offline/idGen.ts) — the
 * client already generates and persists a stable UUID locally; this table
 * is what turns that anonymous UUID into something the server actually
 * knows about: which company/branch/user it belongs to, whether it's
 * still authorized, and when it was last seen.
 *
 * Respects existing company/account isolation exactly like every other
 * tenant-scoped table here (company_id FK + CASCADE, matching e.g.
 * `backups` in migration 018). branch_id is nullable because not every
 * deployment of this ERP uses branches (single-location shops are the
 * common case) — see routes/devices.js for how it's resolved when absent.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 026] devices...')

  const hasTable = await knex.schema.hasTable('devices')
  if (!hasTable) {
    await knex.schema.createTable('devices', (t) => {
      // Deliberately NOT server-generated (no defaultTo uuid_generate_v4()):
      // this id IS the client's already-persisted device_id (see
      // offline/idGen.ts getDeviceId()), supplied at registration time.
      // That's what makes /devices/register idempotent — registering the
      // same device twice (e.g. app reinstall reusing the same stored id,
      // or a retried request) updates this same row instead of creating a
      // second one for what is physically one device.
      t.uuid('id').primary()
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      // branches table may not exist in every deployment of this schema —
      // stored as a plain uuid column (no FK) so this migration never
      // fails on a database that predates/lacks a branches table; the app
      // layer treats it as "unbranched" when null.
      t.uuid('branch_id').nullable()
      // Nullable and best-effort, not a strict "owner": a shared shop
      // tablet can be used by more than one staff login over its life.
      // Set at pairing time to whoever generated the QR, then kept
      // current by every authenticated request that carries this
      // device's id (see middleware/index.js identifyDevice) — so it
      // always reflects "most recently seen with", not a fixed owner.
      t.uuid('user_id').nullable().references('id').inTable('users').onDelete('SET NULL')

      t.string('device_name', 120).notNullable()
      t.string('platform', 40)        // 'android' | 'ios' | 'web' | ...
      t.string('app_version', 40)
      t.enum('status', ['active', 'revoked']).notNullable().defaultTo('active')

      t.timestamp('registered_at').notNullable().defaultTo(knex.fn.now())
      t.timestamp('last_seen_at')
      t.timestamp('last_synced_at')

      t.uuid('revoked_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('revoked_at')

      t.timestamps(true, true)

      t.index(['company_id', 'status'])
      t.index(['company_id', 'user_id'])
    })
    console.log('  + created devices table')
  } else {
    console.log('  = devices table already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('devices')
}
