/**
 * Migration 042 — link stock_register_entries to the customer and the
 * accounting voucher of a return.
 *
 * Needed by the Company vs Customer report: a sales return (SRN) must know
 * WHICH customer returned it, and the report must not count the same return
 * twice (once from this table, once from its CREDIT_NOTE voucher). The voucher
 * link lets the report treat vouchers WITHOUT a linked entry as legacy returns
 * made before this feature existed.
 * Additive only — no existing column or row is changed.
 */
exports.up = async (knex) => {
  if (!await knex.schema.hasTable('stock_register_entries')) return
  if (!await knex.schema.hasColumn('stock_register_entries', 'party_id')) {
    await knex.schema.alterTable('stock_register_entries', t => {
      t.uuid('party_id').references('id').inTable('parties').onDelete('SET NULL')
      t.uuid('voucher_id').references('id').inTable('vouchers').onDelete('SET NULL')
      t.index(['company_id', 'entry_type', 'entry_date'], 'idx_sre_company_type_date')
    })
  }
}
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('stock_register_entries', 'party_id')) {
    await knex.schema.alterTable('stock_register_entries', t => {
      t.dropIndex([], 'idx_sre_company_type_date'); t.dropColumn('voucher_id'); t.dropColumn('party_id')
    })
  }
}
