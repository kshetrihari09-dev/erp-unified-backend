/**
 * Migration 018 — Settings Center
 *
 * Backs the new ERP Settings Center UI with real, persisted storage:
 *
 *  - companies.settings (jsonb, default '{}'): a single flexible bucket for
 *    every new preference-style setting that doesn't warrant its own typed
 *    column (number format, timezone, default payment mode, round-off,
 *    sales/purchase toggles, accounting defaults, notification toggles,
 *    and the "require password confirmation" flags for sensitive actions).
 *    Existing typed columns (name, currency, vat_percent, invoice_prefix,
 *    date_system, etc.) are untouched and remain the source of truth for
 *    the fields they already cover — this column is only for the NEW
 *    settings introduced by the Settings Center, merged with defaults at
 *    read time in src/utils/settingsDefaults.js.
 *
 *  - backups (table): history/metadata for local database backups created
 *    by the new Backup & Cloud settings panel (manual or scheduled-auto),
 *    so "Last backup status", download, and verification are real,
 *    queryable facts rather than UI-only state.
 *
 * Purely additive: no existing column, constraint, index, or table is
 * modified or dropped. Safe to run multiple times — checks current state.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 018] settings center...')

  const hasSettingsCol = await knex.schema.hasColumn('companies', 'settings')
  if (!hasSettingsCol) {
    await knex.schema.alterTable('companies', (t) => {
      t.jsonb('settings').notNullable().defaultTo('{}')
    })
    console.log('  + added companies.settings (jsonb)')
  } else {
    console.log('  = companies.settings already exists, skipping')
  }

  const hasBackups = await knex.schema.hasTable('backups')
  if (!hasBackups) {
    await knex.schema.createTable('backups', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.enum('type', ['manual', 'auto']).notNullable().defaultTo('manual')
      t.enum('status', ['pending', 'success', 'failed']).notNullable().defaultTo('pending')
      t.string('file_name', 255)
      t.string('file_path', 500)
      t.bigInteger('size_bytes')
      t.string('checksum', 128)
      t.boolean('verified').notNullable().defaultTo(false)
      t.timestamp('verified_at')
      t.text('error_message')
      t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamps(true, true)
      t.index(['company_id', 'created_at'])
    })
    console.log('  + created backups table')
  } else {
    console.log('  = backups table already exists, skipping')
  }
}

exports.down = async (knex) => {
  const hasBackups = await knex.schema.hasTable('backups')
  if (hasBackups) await knex.schema.dropTable('backups')

  const hasSettingsCol = await knex.schema.hasColumn('companies', 'settings')
  if (hasSettingsCol) {
    await knex.schema.alterTable('companies', (t) => t.dropColumn('settings'))
  }
}
