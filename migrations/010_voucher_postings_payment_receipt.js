/**
 * 010_voucher_postings_payment_receipt.js
 *
 * Problem: voucher_postings had no FK columns for PAYMENT and RECEIPT
 * source types, so posting audit lookups always returned nothing for them.
 *
 * Fix: add payment_id and receipt_id nullable UUID columns + indexes.
 * These reference the vouchers table directly (payments/receipts have no
 * dedicated table — they are vouchers with type PAYMENT/RECEIPT).
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('voucher_postings', t => {
    // Payment vouchers originate from the vouchers table itself
    t.uuid('payment_id').nullable().references('id').inTable('vouchers').onDelete('SET NULL')
    t.uuid('receipt_id').nullable().references('id').inTable('vouchers').onDelete('SET NULL')
    t.index('payment_id')
    t.index('receipt_id')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('voucher_postings', t => {
    t.dropIndex('payment_id')
    t.dropIndex('receipt_id')
    t.dropColumn('payment_id')
    t.dropColumn('receipt_id')
  })
}
