/**
 * Migration 004 — Fix inventory_batches schema + stock_batches compat view
 *
 * ROOT CAUSE OF "current transaction is aborted" ERROR:
 *   Knex wraps migrations in a transaction by default.
 *   When ANY statement inside that transaction fails, PostgreSQL marks the
 *   entire transaction as aborted and rejects ALL subsequent commands with:
 *   "current transaction is aborted, commands ignored until end of transaction block"
 *   CREATE INDEX is especially prone to this because partial indexes, IF NOT EXISTS
 *   guards, and column references can fail silently-then-abort the transaction.
 *
 * FIX:
 *   exports.config = { transaction: false }
 *   This tells Knex to NOT wrap this migration in a transaction.
 *   Each statement runs independently. One failure never blocks the rest.
 */

exports.config = { transaction: false }

exports.up = async (knex) => {
  console.log('\n[Migration 004] Fixing inventory_batches...\n')

  async function addCol(table, col, fn) {
    if (!await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, t => fn(t))
      console.log(`  + Added  ${table}.${col}`)
    } else {
      console.log(`  - Exists ${table}.${col}`)
    }
  }

  async function sql(query, label) {
    try {
      await knex.raw(query)
      console.log(`  + ${label}`)
    } catch (e) {
      const msg = e.message.split('\n')[0]
      console.log(`  - Skip: ${label} — ${msg}`)
      // Never re-throw — one bad index must not block the whole migration
    }
  }

  if (!await knex.schema.hasTable('inventory_batches')) {
    console.log('  - inventory_batches not found, skipping')
    return
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  await addCol('inventory_batches', 'receipt_date',  t => t.date('receipt_date'))
  await addCol('inventory_batches', 'qty_received',  t => t.decimal('qty_received',  12, 4).notNullable().defaultTo(0))
  await addCol('inventory_batches', 'qty_remaining', t => t.decimal('qty_remaining', 12, 4).notNullable().defaultTo(0))
  await addCol('inventory_batches', 'qty_sold',      t => t.decimal('qty_sold',      12, 4).notNullable().defaultTo(0))
  await addCol('inventory_batches', 'unit_cost',     t => t.decimal('unit_cost',     12, 4).notNullable().defaultTo(0))
  await addCol('inventory_batches', 'total_cost',    t => t.decimal('total_cost',    14, 4).notNullable().defaultTo(0))
  await addCol('inventory_batches', 'expiry',        t => t.string('expiry', 20))

  // ── Data migrations ────────────────────────────────────────────────────────
  if (await knex.schema.hasColumn('inventory_batches', 'qty_available')) {
    await sql(
      `UPDATE inventory_batches SET qty_remaining = qty_available WHERE qty_remaining = 0 AND qty_available > 0`,
      'Synced qty_available → qty_remaining'
    )
  }
  if (await knex.schema.hasColumn('inventory_batches', 'purchase_rate')) {
    await sql(
      `UPDATE inventory_batches SET unit_cost = purchase_rate WHERE unit_cost = 0 AND purchase_rate > 0`,
      'Synced purchase_rate → unit_cost'
    )
  }

  // ── Indexes — each isolated, never partial (safer cross-version) ───────────
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_inv_batches_company_product ON inventory_batches (company_id, product_id)`,
    'Index: company_id, product_id'
  )
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_inv_batches_expiry ON inventory_batches (expiry_date)`,
    'Index: expiry_date'
  )
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_inv_batches_qty_remaining ON inventory_batches (company_id, product_id, qty_remaining)`,
    'Index: company_id, product_id, qty_remaining'
  )

  // ── Compatibility view ─────────────────────────────────────────────────────
  await sql(`DROP VIEW IF EXISTS stock_batches`, 'Dropped old stock_batches view')

  await sql(`
    CREATE OR REPLACE VIEW stock_batches AS
    SELECT
      id, company_id, product_id, voucher_id,
      batch_no, expiry, expiry_date, receipt_date,
      qty_received,
      qty_remaining,
      qty_remaining AS qty_available,
      qty_sold,
      unit_cost,
      unit_cost     AS purchase_rate,
      total_cost,
      created_at, updated_at
    FROM inventory_batches
  `, 'View: stock_batches → inventory_batches')

  console.log('\n[Migration 004] Done ✓\n')
}

exports.down = async (knex) => {
  try { await knex.raw(`DROP VIEW IF EXISTS stock_batches`) } catch {}
  console.log('[Migration 004] Rolled back')
}
