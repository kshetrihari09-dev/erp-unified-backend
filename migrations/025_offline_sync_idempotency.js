/**
 * Migration 025 — Offline sync idempotency (client_txn_id / device_id)
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * The frontend's offline queue (erp-enterprise-full/src/offline/idGen.ts)
 * already generates a `client_txn_id` UUID once per queued sale and sends
 * it on every upload attempt, including retries — but until now nothing
 * on the server stored or checked it. If a retry happened because the
 * response was lost after the server had already committed the sale
 * (flaky LAN, app killed mid-request, exponential-backoff retry racing a
 * slow success), the exact same sale would be posted a second time:
 * duplicate invoice, duplicate stock deduction, duplicate journal entry.
 *
 * This migration adds the column the idempotency check needs. The actual
 * check ("does a sale with this client_txn_id already exist for this
 * company? if so, return it instead of inserting again") lives in
 * routes/sales.js / routes/purchases.js — this migration only adds safe
 * storage for it:
 *
 *   - client_txn_id: nullable (online-created sales never had one and
 *     never will — this is purely an offline-sync concern), globally
 *     random UUID from the client, so a **partial** unique index
 *     (WHERE client_txn_id IS NOT NULL) enforces "at most one sale per
 *     client_txn_id per company" without constraining the majority of
 *     rows that don't have one.
 *   - device_id: which registered device (see migration 026) created
 *     this record — nullable for the same reason (online/legacy rows
 *     have none), and SET NULL on device deletion so a revoked/removed
 *     device never blocks or cascades into deleting historical invoices.
 *
 * Purely additive — no existing column, constraint, or row is touched.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 025] offline sync idempotency (client_txn_id, device_id)...')

  for (const table of ['sales', 'purchases']) {
    const hasClientTxnId = await knex.schema.hasColumn(table, 'client_txn_id')
    const hasDeviceId    = await knex.schema.hasColumn(table, 'device_id')

    if (!hasClientTxnId || !hasDeviceId) {
      await knex.schema.alterTable(table, (t) => {
        if (!hasClientTxnId) t.uuid('client_txn_id').nullable()
        if (!hasDeviceId)    t.uuid('device_id').nullable()
      })
      console.log(`  + added ${table}.client_txn_id / ${table}.device_id`)
    } else {
      console.log(`  = ${table}.client_txn_id / device_id already exist, skipping`)
    }

    // Partial unique index — only rows that actually have a client_txn_id
    // are constrained. Scoped to company_id as well as client_txn_id so a
    // (vanishingly unlikely, but not impossible) UUID collision across two
    // different companies' independent offline devices can never falsely
    // collide with each other.
    const idxName = `${table}_company_client_txn_id_unique`
    const exists = await knex.raw(
      `SELECT 1 FROM pg_indexes WHERE indexname = ?`, [idxName],
    )
    if (exists.rows.length === 0) {
      await knex.raw(`
        CREATE UNIQUE INDEX ${idxName}
        ON ${table} (company_id, client_txn_id)
        WHERE client_txn_id IS NOT NULL
      `)
      console.log(`  + created partial unique index ${idxName}`)
    } else {
      console.log(`  = index ${idxName} already exists, skipping`)
    }
  }
}

exports.down = async (knex) => {
  for (const table of ['sales', 'purchases']) {
    await knex.raw(`DROP INDEX IF EXISTS ${table}_company_client_txn_id_unique`)
    const hasClientTxnId = await knex.schema.hasColumn(table, 'client_txn_id')
    const hasDeviceId    = await knex.schema.hasColumn(table, 'device_id')
    if (hasClientTxnId || hasDeviceId) {
      await knex.schema.alterTable(table, (t) => {
        if (hasClientTxnId) t.dropColumn('client_txn_id')
        if (hasDeviceId)    t.dropColumn('device_id')
      })
    }
  }
}
