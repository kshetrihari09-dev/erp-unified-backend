/**
 * 011_fix_payment_mode_constraint.js
 *
 * Problem: sales and purchases tables have a CHECK constraint that only
 * allows ['cash','credit','bank','cheque','upi'] for payment_mode, but
 * the frontend PAYMENT_MODES constant sends 'card' and 'online' — causing
 * a constraint violation on every card/online payment.
 *
 * Fix: drop the old CHECK constraint on both tables and add a new one
 * that includes all seven valid values: cash, credit, bank, cheque, upi,
 * card, online.
 *
 * The existing 'upi' and 'cheque' values are kept so existing rows are
 * not invalidated. 'online' covers the frontend's "Online/UPI" label.
 */

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE sales
      DROP CONSTRAINT IF EXISTS sales_payment_mode_check,
      ADD CONSTRAINT sales_payment_mode_check
        CHECK (payment_mode IN ('cash','credit','bank','cheque','upi','card','online'))
  `)

  await knex.raw(`
    ALTER TABLE purchases
      DROP CONSTRAINT IF EXISTS purchases_payment_mode_check,
      ADD CONSTRAINT purchases_payment_mode_check
        CHECK (payment_mode IN ('cash','credit','bank','cheque','upi','card','online'))
  `)
}

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE sales
      DROP CONSTRAINT IF EXISTS sales_payment_mode_check,
      ADD CONSTRAINT sales_payment_mode_check
        CHECK (payment_mode IN ('cash','credit','bank','cheque','upi'))
  `)

  await knex.raw(`
    ALTER TABLE purchases
      DROP CONSTRAINT IF EXISTS purchases_payment_mode_check,
      ADD CONSTRAINT purchases_payment_mode_check
        CHECK (payment_mode IN ('cash','credit','bank','cheque','upi'))
  `)
}
