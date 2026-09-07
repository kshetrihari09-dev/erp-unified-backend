/**
 * Migration 035 — Customer Product Ordering (Phase 3: cart storage)
 *
 * A persisted server-side cart (rather than client-only state) so it
 * survives across devices/app reinstalls, matching the spec's literal
 * `GET/POST/PATCH/DELETE /customer/cart` endpoints. It stores ONLY
 * product_id + quantity — never a price, subtotal, or any computed
 * total (spec #10/#25: "Do not trust prices sent from the browser" cuts
 * both ways — this table also never gives the browser anything to
 * round-trip back as if it were authoritative). Every price/availability
 * figure shown for cart contents is recomputed fresh, from the current
 * product row, on every read — see services/customerCatalogService.js.
 */
exports.up = async (knex) => {
  const hasTable = await knex.schema.hasTable('customer_cart_items')
  if (hasTable) { console.log('[Migration 035] customer_cart_items already exists, skipping'); return }

  await knex.schema.createTable('customer_cart_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    t.uuid('customer_account_id').notNullable().references('id').inTable('customer_accounts').onDelete('CASCADE')
    t.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE')
    t.decimal('quantity', 12, 4).notNullable()
    t.timestamps(true, true)

    // One row per product per customer — "add to cart" on a product
    // already in the cart increases this row's quantity rather than
    // creating a second line for the same product.
    t.unique(['customer_account_id', 'product_id'])
    t.index(['customer_account_id'])
  })
  console.log('[Migration 035] customer_cart_items created')
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('customer_cart_items')
}
