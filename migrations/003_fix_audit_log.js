/**
 * Migration 003 — Fix audit_log schema
 *
 * If this database ran the broken helpers.js before the fix was applied,
 * it may have stale columns (resource, resource_id, changes) instead of
 * the correct ones (entity_type, entity_id, payload_after).
 *
 * This migration is fully idempotent — safe to run multiple times.
 */
exports.config = { transaction: false }

exports.up = async (knex) => {
  console.log('\n[Migration 003] Repairing audit_log schema...\n')

  async function addCol(table, col, fn) {
    if (!await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, t => fn(t))
      console.log(`  ✓ Added ${table}.${col}`)
    }
  }

  if (!await knex.schema.hasTable('audit_log')) {
    console.log('  ✓ audit_log does not exist yet — skipped')
    return
  }

  // Add correct columns
  await addCol('audit_log', 'entity_type',    t => t.string('entity_type', 50))
  await addCol('audit_log', 'entity_id',      t => t.uuid('entity_id'))
  await addCol('audit_log', 'payload_before', t => t.jsonb('payload_before'))
  await addCol('audit_log', 'payload_after',  t => t.jsonb('payload_after'))
  await addCol('audit_log', 'voucher_no',     t => t.string('voucher_no', 50))
  await addCol('audit_log', 'ip_address',     t => t.string('ip_address', 50))
  await addCol('audit_log', 'user_agent',     t => t.string('user_agent', 500))
  await addCol('audit_log', 'is_suspicious',  t => t.boolean('is_suspicious').defaultTo(false))
  await addCol('audit_log', 'entry_hash',     t => t.string('entry_hash', 64))
  await addCol('audit_log', 'prev_hash',      t => t.string('prev_hash', 64))

  // Remove stale columns from broken helpers.js
  for (const stale of ['resource', 'resource_id', 'changes']) {
    if (await knex.schema.hasColumn('audit_log', stale)) {
      await knex.schema.alterTable('audit_log', t => t.dropColumn(stale))
      console.log(`  ✓ Dropped stale audit_log.${stale}`)
    }
  }

  console.log('\n[Migration 003] Done ✓\n')
}

exports.down = async () => {
  console.log('[Migration 003] down: no destructive rollback')
}
