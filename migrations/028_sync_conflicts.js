/**
 * Migration 028 — sync_conflicts
 *
 * When an offline-queued sale finally reaches the server and the server's
 * atomic stock check (routes/sales.js POST /, see migration 025's sibling
 * code change) rejects it — e.g. two devices both sold the last of a
 * batch while offline — that rejection is more than a one-line error
 * toast: it's a real business event ("Device B's queued sale of Acoril
 * SYP could not be completed because stock ran out"). This table gives it
 * a durable, queryable record instead of only living transiently in the
 * client's error message, so:
 *   - Settings → Devices & Sync → "View Conflicts" has something real to
 *     show, per device and per company.
 *   - Whatever the person decides (edit quantity / cancel / pick another
 *     batch / authorized override) is itself audited (resolved_by,
 *     resolved_at, resolution_reason), not just silently fixed and
 *     forgotten.
 *   - A conflict is never auto-deleted — matches the existing "failed
 *     transactions are never silently removed" rule already documented in
 *     offline/syncQueue.ts on the client.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 028] sync_conflicts...')

  const hasTable = await knex.schema.hasTable('sync_conflicts')
  if (!hasTable) {
    await knex.schema.createTable('sync_conflicts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      // Not a hard FK to sales/purchases — the whole point is that this
      // transaction was REJECTED, so no sales/purchases row for it exists
      // to reference. It's the client's own idempotency key (see
      // migration 025) instead.
      t.uuid('transaction_id').notNullable()
      t.uuid('device_id').nullable()
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('branch_id').nullable()
      t.uuid('user_id').nullable()

      t.string('conflict_type', 60).notNullable()   // e.g. 'STOCK_CONFLICT'
      t.string('transaction_type', 30).notNullable().defaultTo('sale')
      t.jsonb('local_state').notNullable().defaultTo('{}')   // what the client submitted
      t.jsonb('server_state').notNullable().defaultTo('{}')  // authoritative state at rejection time
      t.text('reason')

      t.enum('status', ['open', 'resolved']).notNullable().defaultTo('open')
      t.uuid('resolved_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('resolved_at')
      t.text('resolution_reason')

      t.timestamps(true, true)

      t.index(['company_id', 'status'])
      t.index(['transaction_id'])
    })
    console.log('  + created sync_conflicts table')
  } else {
    console.log('  = sync_conflicts table already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('sync_conflicts')
}
