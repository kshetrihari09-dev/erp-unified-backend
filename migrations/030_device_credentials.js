/**
 * Migration 030 — device credentials
 *
 * Closes a device-hijacking gap: previously `POST /devices/register` and
 * `POST /devices/heartbeat` accepted a client-supplied `device_id` as the
 * only proof of identity, and (via the register route's `onConflict('id')
 * .merge()`) an authenticated user who merely guessed/knew another
 * device's UUID could overwrite its `user_id`/name/branch — no proof
 * they actually control that physical device was ever required.
 *
 * `device_secret_hash` is a per-device credential, generated server-side
 * the first time a device is ever created (via /register or the pairing
 * claim), returned to the client ONCE, and required (as `X-Device-Secret`)
 * on every subsequent register/heartbeat call for that same device_id —
 * this is what separates "device identity" from "user identity/session"
 * per the security audit. Only the hash is stored, matching the same
 * never-store-raw-secrets rule as refresh_tokens.
 *
 * Nullable, not backfilled: existing already-registered devices predate
 * this credential and keep working (routes/devices.js falls back to the
 * pre-existing company-scoped behavior when no secret is set yet, and
 * mints one lazily on next register/heartbeat) — see routes/devices.js
 * for the exact compatibility behavior and the report for the residual
 * risk window this implies until every existing device has checked in
 * once post-deploy.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 030] device credentials...')

  const hasColumn = await knex.schema.hasColumn('devices', 'device_secret_hash')
  if (!hasColumn) {
    await knex.schema.alterTable('devices', (t) => {
      t.string('device_secret_hash', 64) // SHA-256 hex digest — never the raw secret
    })
    console.log('  + added devices.device_secret_hash')
  } else {
    console.log('  = devices.device_secret_hash already exists, skipping')
  }
}

exports.down = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('devices', 'device_secret_hash')
  if (hasColumn) {
    await knex.schema.alterTable('devices', (t) => { t.dropColumn('device_secret_hash') })
  }
}
