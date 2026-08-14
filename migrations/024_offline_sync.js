/**
 * Migration 024 — offline sync idempotency key
 *
 * Supports the frontend's offline-first sale flow (see erp-enterprise-full
 * src/offline/): every sale created while offline is queued locally under a
 * client-generated UUID (`client_txn_id`) BEFORE it has a real server
 * invoice number. When connectivity returns, the sync engine POSTs that
 * queued sale to the existing POST /sales endpoint, now including its
 * client_txn_id.
 *
 * Networks are unreliable — a sync POST can succeed on the server but the
 * response never reach the browser (dropped connection, tab closed mid-
 * request, etc.), in which case the client's queue still shows it as
 * "pending" and will legitimately retry the exact same request. Without
 * this column, that retry creates a SECOND sale, a second stock deduction,
 * and a second voucher for what was really one transaction. This migration
 * makes `client_txn_id` unique per company so the retry is recognized and
 * replayed against the ORIGINAL sale instead — see routes/sales.js POST /.
 *
 * - Nullable: every sale created from the normal (online) UI has no
 *   client_txn_id at all, same as before this migration — this is purely
 *   additive and only used by the offline sync path.
 * - Scoped UNIQUE(company_id, client_txn_id) rather than a bare unique
 *   constraint on client_txn_id alone, consistent with every other
 *   multi-tenant unique constraint in this schema (e.g. products
 *   UNIQUE(company_id, item_code) in migration 002) — two different
 *   companies' browsers generating the same random UUID (astronomically
 *   unlikely, but not worth relying on) must never collide with each other.
 * - Partial-unique via a WHERE clause (not a plain composite unique) so
 *   the (extremely common) NULL case — every non-offline sale — is never
 *   compared against other NULLs. Postgres treats NULL <> NULL for unique
 *   constraints by default, so a plain UNIQUE would already allow this,
 *   but the explicit partial index makes the intent unambiguous and keeps
 *   the index small (only offline-originated rows are indexed at all).
 * - Does not touch any existing column, the accounting pipeline, stock
 *   deduction, or invoice numbering — see routes/sales.js for how this
 *   column is actually consulted (idempotent replay check).
 * - Same additive, hasColumn-guarded pattern as migration 017/023 — safe
 *   to run multiple times.
 */
exports.up = async (knex) => {
  console.log('\n[Migration 024] offline sync (client_txn_id)...')

  const hasCol = await knex.schema.hasColumn('sales', 'client_txn_id')
  if (!hasCol) {
    await knex.schema.alterTable('sales', (t) => {
      t.string('client_txn_id', 100).nullable()
    })
    console.log('  + added sales.client_txn_id')
  } else {
    console.log('  = sales.client_txn_id already exists, skipping')
  }

  const hasIndex = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'sales' AND indexname = 'sales_company_client_txn_id_unique'
  `)
  if (hasIndex.rows.length === 0) {
    await knex.raw(`
      CREATE UNIQUE INDEX sales_company_client_txn_id_unique
      ON sales (company_id, client_txn_id)
      WHERE client_txn_id IS NOT NULL
    `)
    console.log('  + added unique index sales_company_client_txn_id_unique')
  } else {
    console.log('  = sales_company_client_txn_id_unique already exists, skipping')
  }

  // Same column, for the same reason, on the sync queue's other
  // transaction types this app may extend offline support to later
  // (purchases/returns/payments/stock adjustments/vouchers — see the
  // offline sync architecture note in erp-enterprise-full/src/offline/).
  // Only `purchases` is added now since it's the other operational table
  // with its own independent invoice/bill numbering and stock impact;
  // the others aren't part of this change's frontend scope yet, and
  // adding unused columns speculatively isn't worth the schema churn.
  const purchasesHasCol = await knex.schema.hasColumn('purchases', 'client_txn_id')
  if (!purchasesHasCol) {
    await knex.schema.alterTable('purchases', (t) => {
      t.string('client_txn_id', 100).nullable()
    })
    console.log('  + added purchases.client_txn_id')
  } else {
    console.log('  = purchases.client_txn_id already exists, skipping')
  }

  const purchasesHasIndex = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'purchases' AND indexname = 'purchases_company_client_txn_id_unique'
  `)
  if (purchasesHasIndex.rows.length === 0) {
    await knex.raw(`
      CREATE UNIQUE INDEX purchases_company_client_txn_id_unique
      ON purchases (company_id, client_txn_id)
      WHERE client_txn_id IS NOT NULL
    `)
    console.log('  + added unique index purchases_company_client_txn_id_unique')
  } else {
    console.log('  = purchases_company_client_txn_id_unique already exists, skipping')
  }
}

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS sales_company_client_txn_id_unique`)
  await knex.raw(`DROP INDEX IF EXISTS purchases_company_client_txn_id_unique`)
  const salesHasCol = await knex.schema.hasColumn('sales', 'client_txn_id')
  if (salesHasCol) await knex.schema.alterTable('sales', (t) => t.dropColumn('client_txn_id'))
  const purchasesHasCol = await knex.schema.hasColumn('purchases', 'client_txn_id')
  if (purchasesHasCol) await knex.schema.alterTable('purchases', (t) => t.dropColumn('client_txn_id'))
}
