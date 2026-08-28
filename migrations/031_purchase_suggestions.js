/**
 * Migration 031 — Smart Purchase Suggestions
 *
 * Purely additive. Adds:
 *
 *  1. products: optional per-product inventory-planning columns
 *     (preferred_supplier_id, supplier_lead_time_days, safety_stock_days,
 *     safety_stock_qty, reorder_point_override, exclude_from_suggestions).
 *     All nullable / defaulted — existing products keep working unchanged.
 *
 *  2. purchase_orders / purchase_order_items — this codebase has never had
 *     a Purchase Order concept (`purchases` is an already-received bill,
 *     see migration 002). Smart Purchase Suggestions needs a real
 *     pending → approved → (partially) received document to track
 *     "incoming stock" against, so we introduce it here.
 *
 *  3. purchases.purchase_order_id — nullable link so that recording the
 *     actual supplier bill (existing POST /purchases flow, unchanged)
 *     can optionally fulfil a PO, which is how "received" quantities on
 *     a PO get updated. No existing purchases row is touched.
 *
 *  4. users: four boolean permission flags for this feature, following
 *     the exact pattern of can_post_vouchers/can_approve_vouchers/etc.
 *     (migration 001). Backfilled by role so existing accounts keep
 *     working with sensible defaults (owner/admin/manager can already
 *     manage the business; cashier/accountant get view-only by default).
 */
exports.up = async (knex) => {
  console.log('\n[Migration 031] Smart Purchase Suggestions...')

  // ── 1. products: inventory planning columns ─────────────────────────────
  const hasPreferredSupplier = await knex.schema.hasColumn('products', 'preferred_supplier_id')
  if (!hasPreferredSupplier) {
    await knex.schema.alterTable('products', (t) => {
      t.uuid('preferred_supplier_id').references('id').inTable('parties').onDelete('SET NULL')
      t.integer('supplier_lead_time_days')   // null = use company default (settings)
      t.decimal('safety_stock_days', 8, 2)   // null = use company default (settings)
      t.decimal('safety_stock_qty', 12, 2)   // manual override; takes precedence over safety_stock_days
      t.decimal('reorder_point_override', 12, 2) // manual override of the whole reorder point calc
      t.boolean('exclude_from_suggestions').notNullable().defaultTo(false)
      t.index(['company_id', 'preferred_supplier_id'])
    })
    console.log('  + products: inventory planning columns added')
  } else {
    console.log('  = products inventory planning columns already exist, skipping')
  }

  // ── 2. purchase_orders ───────────────────────────────────────────────────
  const hasPOTable = await knex.schema.hasTable('purchase_orders')
  if (!hasPOTable) {
    await knex.schema.createTable('purchase_orders', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('supplier_id').references('id').inTable('parties').onDelete('SET NULL')
      t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL')
      t.string('order_no', 50).notNullable()
      t.date('order_date').notNullable()
      t.date('expected_date')
      // 'suggestion' = generated from Smart Purchase Suggestions; 'manual' = created directly
      t.enum('source', ['manual', 'suggestion']).notNullable().defaultTo('manual')
      t.enum('status', ['pending', 'approved', 'partially_received', 'received', 'cancelled'])
        .notNullable().defaultTo('pending')
      t.decimal('estimated_total', 14, 2).defaultTo(0)
      t.text('notes')
      t.timestamps(true, true)
      t.unique(['company_id', 'order_no'])
      t.index(['company_id', 'status'])
      t.index(['company_id', 'supplier_id'])
    })
    console.log('  + created purchase_orders table')

    await knex.schema.createTable('purchase_order_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('purchase_order_id').notNullable().references('id').inTable('purchase_orders').onDelete('CASCADE')
      t.uuid('product_id').references('id').inTable('products').onDelete('SET NULL')
      t.string('product_name', 200)
      t.decimal('qty_ordered', 12, 2).notNullable().defaultTo(0)
      t.decimal('qty_received', 12, 2).notNullable().defaultTo(0)
      t.decimal('rate', 12, 2).notNullable().defaultTo(0)
      t.decimal('amount', 14, 2).notNullable().defaultTo(0)
      t.timestamps(true, true)
      t.index('purchase_order_id')
      t.index('product_id')
      t.check('"qty_received" >= 0', [], 'chk_po_items_qty_received_non_negative')
    })
    console.log('  + created purchase_order_items table')
  } else {
    console.log('  = purchase_orders / purchase_order_items already exist, skipping')
  }

  // ── 3. purchases.purchase_order_id ──────────────────────────────────────
  const hasPOLink = await knex.schema.hasColumn('purchases', 'purchase_order_id')
  if (!hasPOLink) {
    await knex.schema.alterTable('purchases', (t) => {
      t.uuid('purchase_order_id').references('id').inTable('purchase_orders').onDelete('SET NULL')
      t.index('purchase_order_id')
    })
    console.log('  + purchases.purchase_order_id added')
  } else {
    console.log('  = purchases.purchase_order_id already exists, skipping')
  }

  // ── 4. users: Smart Purchase Suggestions permission flags ──────────────
  const hasPermCol = await knex.schema.hasColumn('users', 'can_view_purchase_suggestions')
  if (!hasPermCol) {
    await knex.schema.alterTable('users', (t) => {
      t.boolean('can_view_purchase_suggestions').notNullable().defaultTo(true)
      t.boolean('can_manage_purchase_suggestions').notNullable().defaultTo(false)
      t.boolean('can_create_po_from_suggestions').notNullable().defaultTo(false)
      t.boolean('can_configure_purchase_suggestion_settings').notNullable().defaultTo(false)
    })
    // Backfill: owner/admin/manager get full access out of the box (same
    // trust tier as company settings / user management in this app);
    // everyone else keeps view-only, matching the safe default above.
    await knex('users')
      .whereIn('role', ['owner', 'admin', 'manager'])
      .update({
        can_manage_purchase_suggestions: true,
        can_create_po_from_suggestions: true,
        can_configure_purchase_suggestion_settings: true,
      })
    console.log('  + users: purchase-suggestion permission flags added + backfilled by role')
  } else {
    console.log('  = users purchase-suggestion permission flags already exist, skipping')
  }

  console.log('[Migration 031] done.\n')
}

exports.down = async (knex) => {
  const hasPOLink = await knex.schema.hasColumn('purchases', 'purchase_order_id')
  if (hasPOLink) await knex.schema.alterTable('purchases', (t) => t.dropColumn('purchase_order_id'))

  await knex.schema.dropTableIfExists('purchase_order_items')
  await knex.schema.dropTableIfExists('purchase_orders')

  const hasPermCol = await knex.schema.hasColumn('users', 'can_view_purchase_suggestions')
  if (hasPermCol) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('can_view_purchase_suggestions')
      t.dropColumn('can_manage_purchase_suggestions')
      t.dropColumn('can_create_po_from_suggestions')
      t.dropColumn('can_configure_purchase_suggestion_settings')
    })
  }

  const hasPreferredSupplier = await knex.schema.hasColumn('products', 'preferred_supplier_id')
  if (hasPreferredSupplier) {
    await knex.schema.alterTable('products', (t) => {
      t.dropColumn('preferred_supplier_id')
      t.dropColumn('supplier_lead_time_days')
      t.dropColumn('safety_stock_days')
      t.dropColumn('safety_stock_qty')
      t.dropColumn('reorder_point_override')
      t.dropColumn('exclude_from_suggestions')
    })
  }
}
