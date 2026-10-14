/**
 * Migration 041 — Stock Register support
 *
 * The Stock Register is built from the application's own documents:
 *   purchases/purchase_items  → PU (in + free)
 *   sales/sale_items          → SL (out)
 *   receives/receive_items    → RV (in + free)
 * Three kinds of stock movement have NO document table of their own, so
 * they are recorded here (append-only, one row per stock line):
 *   SRN  sales return          (stock in)
 *   PRN  purchase return       (stock out)
 *   ADJ  opening stock / adjustment / batch edit (stock in)
 *
 * Existing history is backfilled once from inventory_movements
 * (ADJ and PRN rows). Sales returns made before this migration were never
 * stored as stand-alone records, so they cannot be reconstructed.
 *
 * `source_key` is UNIQUE per company, which makes every insert idempotent
 * (no duplicate register lines on retries or when this migration re-runs).
 */
exports.config = { transaction: false }

exports.up = async (knex) => {
  if (!await knex.schema.hasTable('stock_register_entries')) {
    await knex.schema.createTable('stock_register_entries', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE')
      t.uuid('batch_id').references('id').inTable('inventory_batches').onDelete('SET NULL')
      t.string('entry_type', 3).notNullable()            // SRN | PRN | ADJ
      t.date('entry_date').notNullable()
      t.string('ref_no', 60)
      t.string('particular', 200)
      t.text('narration')
      t.string('batch_no', 100)
      t.string('expiry', 20)
      t.date('expiry_date')
      t.decimal('qty_in',   12, 4).notNullable().defaultTo(0)
      t.decimal('qty_out',  12, 4).notNullable().defaultTo(0)
      t.decimal('qty_free', 12, 4).notNullable().defaultTo(0)
      t.decimal('rate', 14, 4).notNullable().defaultTo(0)
      t.decimal('mrp',  14, 4).notNullable().defaultTo(0)
      t.string('store_name', 100).notNullable().defaultTo('Main Store')
      t.string('source_key', 160).notNullable()
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
      t.unique(['company_id', 'source_key'])
      t.index(['company_id', 'product_id', 'entry_date'], 'idx_sre_company_product_date')
    })
    await knex.raw(`ALTER TABLE stock_register_entries
      ADD CONSTRAINT chk_sre_type CHECK (entry_type IN ('SRN','PRN','ADJ'))`).catch(() => {})
    await knex.raw(`ALTER TABLE stock_register_entries
      ADD CONSTRAINT chk_sre_qty_non_negative CHECK (qty_in >= 0 AND qty_out >= 0 AND qty_free >= 0)`).catch(() => {})
  }

  // Speed up per-product register queries on large histories.
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items (product_id)',
    'CREATE INDEX IF NOT EXISTS idx_sale_items_product     ON sale_items (product_id)',
    'CREATE INDEX IF NOT EXISTS idx_receive_items_product  ON receive_items (product_id)',
  ]) { await knex.raw(sql).catch(e => console.log('  - skip index:', e.message.split('\n')[0])) }

  // ── One-time backfill from the immutable inventory_movements ledger ──────
  if (await knex.schema.hasTable('inventory_movements')) {
    // Opening stock / adjustments: only products.js writes IN rows with no voucher.
    await knex.raw(`
      INSERT INTO stock_register_entries
        (company_id, product_id, batch_id, entry_type, entry_date, ref_no, particular, narration,
         batch_no, expiry, expiry_date, qty_in, rate, source_key)
      SELECT m.company_id, m.product_id, m.batch_id, 'ADJ', m.movement_date, NULL,
             'Stock Adjustment', m.description,
             b.batch_no, b.expiry, b.expiry_date, m.qty, m.unit_cost, 'ADJ:' || m.id::text
      FROM inventory_movements m
      LEFT JOIN inventory_batches b ON b.id = m.batch_id
      WHERE m.movement_type = 'IN' AND m.voucher_id IS NULL
      ON CONFLICT (company_id, source_key) DO NOTHING`).catch(e => console.log('  - ADJ backfill skipped:', e.message.split('\n')[0]))

    // Purchase returns recorded by returns.js.
    await knex.raw(`
      INSERT INTO stock_register_entries
        (company_id, product_id, batch_id, entry_type, entry_date, particular, narration,
         batch_no, expiry, expiry_date, qty_out, rate, source_key)
      SELECT m.company_id, m.product_id, m.batch_id, 'PRN', m.movement_date,
             'Purchase Return', m.description,
             b.batch_no, b.expiry, b.expiry_date, m.qty, m.unit_cost, 'PRN:' || m.id::text
      FROM inventory_movements m
      LEFT JOIN inventory_batches b ON b.id = m.batch_id
      WHERE m.movement_type = 'OUT' AND m.description LIKE 'Purchase Return%'
      ON CONFLICT (company_id, source_key) DO NOTHING`).catch(e => console.log('  - PRN backfill skipped:', e.message.split('\n')[0]))
  }
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('stock_register_entries')
}
