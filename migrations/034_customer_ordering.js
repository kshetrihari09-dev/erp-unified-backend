/**
 * Migration 034 — Customer Product Ordering / Online Store (Phase 1: schema)
 *
 * Purely additive. Three pieces:
 *
 *  1. products.* online-selling columns — every field the spec's section 5
 *     asks for, with one deliberate omission: no new image STORAGE system
 *     (section 55 explicitly says not to build one if none exists — and
 *     none does here, `products` has never had an image column at all).
 *     `online_image_url` is a plain string — paste a link, nothing more.
 *
 *  2. customer_accounts — customer login is a genuinely new capability
 *     (the existing `authenticate` middleware / `users` table is
 *     internal-staff-only, and `parties` has no auth fields at all). This
 *     is a separate table, 1:1 with a `parties` row of type='customer',
 *     rather than bolting password/session columns onto `parties` itself
 *     — `parties` is load-bearing for accounting (vouchers, ledgers) and
 *     this codebase's own pattern for "auth-adjacent, not core-identity"
 *     data is a dedicated table (refresh_tokens, device_credentials —
 *     migrations 029/030), not extra columns on the core row.
 *
 *  3. customer_orders / customer_order_items — the online order itself.
 *     Deliberately NOT `sales`/`sale_items`: an order is a customer's
 *     *request*, not yet a transaction — physical stock is untouched
 *     until staff convert it to a real Sale (see customer_orders.sale_id
 *     below). This is what makes "never double-deduct stock" (spec's
 *     non-negotiable #14) structural rather than a rule to remember: the
 *     only code path that ever touches inventory_batches remains
 *     routes/sales.js's existing one, called once, at conversion time.
 *     Order items snapshot product_name/unit/unit_price at order time
 *     (spec #28) so a later price/name change never rewrites history.
 */

exports.up = async (knex) => {
  console.log('\n[Migration 034] Customer Product Ordering — schema...')

  // ── 1. products.* online-selling columns ────────────────────────────────
  const hasOnlineCol = await knex.schema.hasColumn('products', 'is_online')
  if (!hasOnlineCol) {
    await knex.schema.alterTable('products', (t) => {
      t.boolean('is_online').notNullable().defaultTo(false)
      // 'regular' = products.sales_rate (existing selling price, untouched);
      // 'online'  = online_price below. No third pricing engine — see
      // section 7's "Do NOT create a second competing pricing engine."
      t.enum('online_price_source', ['regular', 'online']).notNullable().defaultTo('regular')
      t.decimal('online_price', 12, 2) // only meaningful when source = 'online'
      // NULL online_qty + auto_sync_online_qty=false means "not manually
      // set yet" — resolved to 0 sellable at read time, never to
      // "unlimited", so a half-configured product fails safe.
      t.decimal('online_qty', 12, 4)
      t.boolean('auto_sync_online_qty').notNullable().defaultTo(false)
      t.decimal('min_order_qty', 12, 4).notNullable().defaultTo(1)
      t.decimal('max_order_qty', 12, 4) // null = no cap
      t.decimal('qty_step', 12, 4).notNullable().defaultTo(1)
      t.enum('stock_visibility', ['exact', 'range', 'available', 'hide']).notNullable().defaultTo('available')
      t.boolean('allow_backorder').notNullable().defaultTo(false)
      t.text('online_description')
      t.string('online_image_url', 500)
      t.integer('display_order').notNullable().defaultTo(0)

      t.index(['company_id', 'is_online'])
      t.index(['company_id', 'display_order'])
    })
    console.log('  + products online-selling columns added')
  } else {
    console.log('  = products online-selling columns already exist, skipping')
  }

  // ── 2. customer_accounts ─────────────────────────────────────────────────
  const hasCustomerAccounts = await knex.schema.hasTable('customer_accounts')
  if (!hasCustomerAccounts) {
    await knex.schema.createTable('customer_accounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      // One customer login per party. ON DELETE CASCADE: if the party
      // itself is ever deleted, the login is meaningless without it.
      t.uuid('party_id').notNullable().unique().references('id').inTable('parties').onDelete('CASCADE')
      // Login identifier — phone OR email, whichever the customer used to
      // register; both reuse parties.phone/parties.email as the source of
      // truth rather than duplicating contact info here (spec #35: "do
      // not expose internal business fields" cuts the other way too —
      // don't fork a second copy of the same contact fields either).
      t.string('login_identifier', 150).notNullable()
      t.string('password_hash', 255).notNullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.timestamp('last_login_at')
      t.timestamps(true, true)

      t.unique(['company_id', 'login_identifier'])
      t.index(['company_id', 'is_active'])
    })
    console.log('  + customer_accounts created')
  } else {
    console.log('  = customer_accounts already exists, skipping')
  }

  // ── 3. customer_orders ────────────────────────────────────────────────────
  const hasOrders = await knex.schema.hasTable('customer_orders')
  if (!hasOrders) {
    await knex.schema.createTable('customer_orders', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('customer_account_id').notNullable().references('id').inTable('customer_accounts').onDelete('RESTRICT')
      t.uuid('party_id').notNullable().references('id').inTable('parties').onDelete('RESTRICT')
      t.string('order_no', 30).notNullable()

      t.enum('status', ['pending', 'confirmed', 'processing', 'ready', 'completed', 'cancelled'])
        .notNullable().defaultTo('pending')
      t.enum('fulfillment_type', ['pickup', 'delivery']).notNullable().defaultTo('pickup')
      t.string('delivery_address', 500)
      t.string('delivery_phone', 50)
      t.text('delivery_notes')
      t.enum('payment_method', ['cash_on_delivery', 'pay_at_store']).notNullable().defaultTo('pay_at_store')
      t.enum('payment_status', ['unpaid', 'paid']).notNullable().defaultTo('unpaid')

      // Every total is server-computed at order time (spec #8/#24) and
      // frozen here — never recomputed from current live prices later.
      t.decimal('subtotal', 14, 2).notNullable().defaultTo(0)
      t.decimal('discount_amount', 12, 2).notNullable().defaultTo(0)
      t.decimal('tax_amount', 12, 2).notNullable().defaultTo(0)
      t.decimal('delivery_charge', 12, 2).notNullable().defaultTo(0)
      t.decimal('grand_total', 14, 2).notNullable().defaultTo(0)

      // Set once, at confirmation time, when staff convert this order into
      // a real Sale (see services/customerOrderService.js, phase 3) — the
      // one and only point stock is ever deducted for an online order.
      t.uuid('sale_id').references('id').inTable('sales').onDelete('SET NULL')
      t.uuid('confirmed_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('confirmed_at')
      t.timestamp('cancelled_at')
      t.string('cancel_reason', 500)

      t.timestamps(true, true)

      t.unique(['company_id', 'order_no'])
      t.index(['company_id', 'status'])
      t.index(['company_id', 'customer_account_id'])
      t.index(['company_id', 'created_at'])
    })
    console.log('  + customer_orders created')
  } else {
    console.log('  = customer_orders already exists, skipping')
  }

  // ── 4. customer_order_items ───────────────────────────────────────────────
  const hasOrderItems = await knex.schema.hasTable('customer_order_items')
  if (!hasOrderItems) {
    await knex.schema.createTable('customer_order_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('order_id').notNullable().references('id').inTable('customer_orders').onDelete('CASCADE')
      // RESTRICT, not CASCADE/SET NULL: an order line must never lose its
      // product reference silently — see product_name_snapshot below for
      // why that's a display concern, not a data-integrity one, but the
      // FK itself stays strict.
      t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('RESTRICT')

      // Snapshots (spec #28) — an order's history must read exactly as it
      // did the day it was placed, even after the product is renamed,
      // repriced, or taken offline.
      t.string('product_name_snapshot', 200).notNullable()
      t.string('unit_snapshot', 30)
      t.decimal('unit_price', 12, 2).notNullable() // the server-computed price at order time — never client-supplied
      t.decimal('quantity', 12, 4).notNullable()
      t.decimal('subtotal', 14, 2).notNullable()

      t.timestamps(true, true)
      t.index(['order_id'])
      t.index(['product_id'])
    })
    console.log('  + customer_order_items created')
  } else {
    console.log('  = customer_order_items already exists, skipping')
  }

  console.log('[Migration 034] done.\n')
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('customer_order_items')
  await knex.schema.dropTableIfExists('customer_orders')
  await knex.schema.dropTableIfExists('customer_accounts')

  const hasOnlineCol = await knex.schema.hasColumn('products', 'is_online')
  if (hasOnlineCol) {
    await knex.schema.alterTable('products', (t) => {
      t.dropColumn('is_online')
      t.dropColumn('online_price_source')
      t.dropColumn('online_price')
      t.dropColumn('online_qty')
      t.dropColumn('auto_sync_online_qty')
      t.dropColumn('min_order_qty')
      t.dropColumn('max_order_qty')
      t.dropColumn('qty_step')
      t.dropColumn('stock_visibility')
      t.dropColumn('allow_backorder')
      t.dropColumn('online_description')
      t.dropColumn('online_image_url')
      t.dropColumn('display_order')
    })
  }
}
