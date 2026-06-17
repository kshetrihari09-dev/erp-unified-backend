/**
 * Migration 002 — Pharma ERP Tables
 *
 * Tables: products, inventory_batches, inventory_movements,
 *         sales, sale_items, purchases, purchase_items,
 *         receives, receive_items, invoice_templates, fiscal_years
 */
exports.up = async (knex) => {
  // ── products ──────────────────────────────────────────────────────────
  await knex.schema.createTable('products', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('inventory_account_id').references('id').inTable('accounts').onDelete('SET NULL')
    t.uuid('cogs_account_id').references('id').inTable('accounts').onDelete('SET NULL')
    t.uuid('sales_account_id').references('id').inTable('accounts').onDelete('SET NULL')
    t.uuid('purchase_account_id').references('id').inTable('accounts').onDelete('SET NULL')
    t.string('item_code', 50)
    t.string('name', 200).notNullable()
    t.string('generic_name', 200)
    t.string('company_name', 150)
    t.string('category', 100)
    t.string('unit', 30).defaultTo('Strip')
    t.enum('valuation_method', ['FIFO', 'AVG', 'SPECIFIC']).defaultTo('FIFO')
    t.decimal('purchase_rate', 12, 2).defaultTo(0)
    t.decimal('sales_rate', 12, 2).notNullable().defaultTo(0)
    t.decimal('mrp', 12, 2).defaultTo(0)
    t.decimal('cc_percent', 5, 2).defaultTo(0)
    t.decimal('tax_rate', 5, 2).defaultTo(0)
    t.integer('min_stock').defaultTo(50)
    t.boolean('is_active').defaultTo(true)
    t.timestamps(true, true)
    t.unique(['company_id', 'item_code'])
    t.index(['company_id', 'name'])
  })

  // ── inventory_batches (FIFO) ───────────────────────────────────────────
  await knex.schema.createTable('inventory_batches', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE')
    t.uuid('voucher_id').references('id').inTable('vouchers')
    t.string('batch_no', 100)
    t.date('expiry_date')
    t.string('expiry', 20)
    t.date('receipt_date').notNullable()
    t.decimal('qty_received', 12, 4).notNullable()
    t.decimal('qty_remaining', 12, 4).notNullable()
    t.decimal('unit_cost', 14, 6).notNullable().defaultTo(0)
    t.decimal('total_cost', 14, 2).notNullable().defaultTo(0)
    t.timestamps(true, true)
    t.index(['company_id', 'product_id'])
    t.check('"qty_remaining" >= 0', [], 'chk_inventory_batches_qty_non_negative')
  })

  // ── inventory_movements (immutable stock ledger) ───────────────────────
  await knex.schema.createTable('inventory_movements', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE')
    t.uuid('batch_id').references('id').inTable('inventory_batches')
    t.uuid('voucher_id').references('id').inTable('vouchers')
    t.uuid('journal_entry_id').references('id').inTable('journal_entries')
    t.enum('movement_type', ['IN','OUT','ADJUSTMENT','TRANSFER']).notNullable()
    t.decimal('qty', 12, 4).notNullable()
    t.decimal('unit_cost', 14, 6).notNullable().defaultTo(0)
    t.decimal('total_cost', 14, 2).notNullable().defaultTo(0)
    t.date('movement_date').notNullable()
    t.text('description')
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    t.index(['company_id', 'product_id', 'movement_date'])
  })

  // ── sales ─────────────────────────────────────────────────────────────
  await knex.schema.createTable('sales', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('party_id').references('id').inTable('parties').onDelete('SET NULL')
    t.uuid('voucher_id').references('id').inTable('vouchers').onDelete('SET NULL')
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL')
    t.string('invoice_no', 50).notNullable()
    t.date('date_ad').notNullable()
    t.string('date_bs', 20)
    t.enum('payment_mode', ['cash','credit','bank','cheque','upi']).defaultTo('cash')
    t.string('reference_no', 100)
    t.decimal('subtotal', 14, 2).defaultTo(0)
    t.decimal('discount_amount', 12, 2).defaultTo(0)
    t.decimal('cc_amount', 12, 2).defaultTo(0)
    t.decimal('vat_amount', 12, 2).defaultTo(0)
    t.decimal('net_total', 14, 2).defaultTo(0)
    t.decimal('paid_amount', 14, 2).defaultTo(0)
    t.decimal('due_amount', 14, 2).defaultTo(0)
    t.enum('status', ['active','cancelled']).defaultTo('active')
    t.text('notes')
    t.timestamps(true, true)
    t.unique(['company_id', 'invoice_no'])
    t.index(['company_id', 'date_ad'])
    t.index(['company_id', 'party_id'])
  })

  // ── sale_items ────────────────────────────────────────────────────────
  await knex.schema.createTable('sale_items', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('sale_id').notNullable().references('id').inTable('sales').onDelete('CASCADE')
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL')
    t.string('product_name', 200)
    t.string('batch_no', 100)
    t.date('expiry_date')
    t.string('expiry', 20)
    t.decimal('qty', 10, 2).defaultTo(1)
    t.decimal('bonus', 10, 2).defaultTo(0)
    t.decimal('rate', 12, 2).notNullable()
    t.decimal('discount_pct', 5, 2).defaultTo(0)
    t.decimal('cc_pct', 5, 2).defaultTo(0)
    t.decimal('cc_amount', 12, 2).defaultTo(0)
    t.decimal('amount', 14, 2).notNullable()
    t.index('sale_id')
  })

  // ── purchases ─────────────────────────────────────────────────────────
  await knex.schema.createTable('purchases', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('party_id').references('id').inTable('parties').onDelete('SET NULL')
    t.uuid('voucher_id').references('id').inTable('vouchers').onDelete('SET NULL')
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL')
    t.string('bill_no', 50).notNullable()
    t.string('supplier_bill_no', 100)
    t.date('date_ad').notNullable()
    t.string('date_bs', 20)
    t.enum('payment_mode', ['cash','credit','bank','cheque','upi']).defaultTo('credit')
    t.decimal('subtotal', 14, 2).defaultTo(0)
    t.decimal('cc_amount', 12, 2).defaultTo(0)
    t.decimal('vat_amount', 12, 2).defaultTo(0)
    t.decimal('net_total', 14, 2).defaultTo(0)
    t.decimal('paid_amount', 14, 2).defaultTo(0)
    t.decimal('due_amount', 14, 2).defaultTo(0)
    t.enum('status', ['active','cancelled']).defaultTo('active')
    t.text('notes')
    t.timestamps(true, true)
    t.unique(['company_id', 'bill_no'])
    t.index(['company_id', 'date_ad'])
  })

  // ── purchase_items ────────────────────────────────────────────────────
  await knex.schema.createTable('purchase_items', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('purchase_id').notNullable().references('id').inTable('purchases').onDelete('CASCADE')
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL')
    t.string('product_name', 200)
    t.string('batch_no', 100)
    t.date('expiry_date')
    t.string('expiry', 20)
    t.decimal('qty', 10, 2).defaultTo(1)
    t.decimal('bonus', 10, 2).defaultTo(0)
    t.decimal('rate', 12, 2).notNullable()
    t.decimal('cc_pct', 5, 2).defaultTo(0)
    t.decimal('cc_amount', 12, 2).defaultTo(0)
    t.decimal('amount', 14, 2).notNullable()
    t.index('purchase_id')
  })

  // ── receives ──────────────────────────────────────────────────────────
  await knex.schema.createTable('receives', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL')
    t.string('receive_no', 50)
    t.date('date_ad').notNullable()
    t.string('date_bs', 20)
    t.text('notes')
    t.timestamps(true, true)
    t.index('company_id')
  })

  // ── receive_items ─────────────────────────────────────────────────────
  await knex.schema.createTable('receive_items', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('receive_id').notNullable().references('id').inTable('receives').onDelete('CASCADE')
    t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL')
    t.string('product_name', 200)
    t.string('batch_no', 100)
    t.date('expiry_date')
    t.string('expiry', 20)
    t.decimal('qty', 10, 2).defaultTo(1)
    t.decimal('rate', 12, 2).defaultTo(0)
  })

  // ── invoice_templates ─────────────────────────────────────────────────
  await knex.schema.createTable('invoice_templates', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.string('name', 100).notNullable()
    t.jsonb('config').defaultTo('{}')
    t.boolean('is_default').defaultTo(false)
    t.timestamps(true, true)
  })

  // ── fiscal_years ──────────────────────────────────────────────────────
  await knex.schema.createTable('fiscal_years', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.string('name', 20).notNullable()
    t.date('start_date_ad').notNullable()
    t.date('end_date_ad').notNullable()
    t.string('start_date_bs', 20)
    t.string('end_date_bs', 20)
    t.boolean('is_active').defaultTo(false)
    t.boolean('is_closed').defaultTo(false)
    t.timestamps(true, true)
  })
}

exports.down = async (knex) => {
  const tables = [
    'fiscal_years','invoice_templates','receive_items','receives',
    'purchase_items','purchases','sale_items','sales',
    'inventory_movements','inventory_batches','products',
  ]
  for (const t of tables) await knex.schema.dropTableIfExists(t)
}
