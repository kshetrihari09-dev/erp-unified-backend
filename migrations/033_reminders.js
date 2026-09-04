/**
 * Migration 033 — Smart Business Reminder & Follow-up Module
 *
 * Purely additive — no existing table, column, or route is touched.
 *
 *  1. reminders — one row per reminder. Deliberately generic: nullable
 *     link columns (customer_id/invoice_id/purchase_id) so one reminder
 *     can reference an existing record without duplicating any of its
 *     data (requirement: "Do not duplicate existing customer, invoice,
 *     payment, or product data").
 *
 *     Two link columns — quotation_id and order_id — are intentionally
 *     plain uuid columns with NO foreign key. This codebase has no
 *     quotations module and no sales-order module (checked: routes/,
 *     modules/ — neither exists, only purchase orders). Adding a real FK
 *     to a table that doesn't exist isn't possible, and inventing one
 *     just for reminders would be exactly the "introduce unnecessary
 *     scope" this feature is warned against. The columns are kept
 *     nullable and unenforced so the data model is ready the day either
 *     module is actually built, without another migration.
 *
 *     payment_id is likewise a plain uuid — this codebase records
 *     payments as vouchers (type RECEIPT/PAYMENT), not a dedicated
 *     `payments` table, so there is no single table to reference.
 *
 *  2. `snoozed_until` + keeping status as pending/completed only (no
 *     separate 'snoozed' status) is what makes "snoozing updates the
 *     existing reminder instead of creating another one" (requirement
 *     #9) trivial: a snooze is just `snoozed_until = <new time>` on the
 *     same row. The effective due time for sorting/dashboard buckets is
 *     always `snoozed_until ?? reminder_at` (see services/reminderService.js).
 *
 *  3. `notified_at` is NOT in the spec's field list but is required to
 *     implement requirement #21 ("prevent duplicate notifications")
 *     without a separate notification-log table — cleared back to null
 *     whenever reminder_at/snoozed_until moves (edit, snooze,
 *     reschedule), so the scheduler notifies again for the new time.
 *
 *  4. users.can_manage_reminders — one boolean flag, following the exact
 *     established pattern (can_post_vouchers, can_view_credit_risk_dashboard,
 *     etc. — migrations 001/031/032). Gates only "assign/delete someone
 *     ELSE's reminder"; every user can always create/view/edit/complete/
 *     snooze their own and reminders assigned to them. Defaulted to TRUE
 *     for every existing user (same "additive, default-open, an admin
 *     can restrict later in Settings → Users" choice migration 032 made
 *     for its own flags) so no existing account loses functionality the
 *     moment this ships.
 */

exports.up = async (knex) => {
  console.log('\n[Migration 033] Smart Reminder & Follow-up Module...')

  // ── 1. reminders ──────────────────────────────────────────────────────────
  const hasReminders = await knex.schema.hasTable('reminders')
  if (!hasReminders) {
    await knex.schema.createTable('reminders', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')

      t.string('title', 200).notNullable()
      t.text('description')

      t.enum('reminder_type', [
        'CUSTOM', 'CUSTOMER_FOLLOW_UP', 'INVOICE_FOLLOW_UP', 'PAYMENT_DUE',
        'OVERDUE_PAYMENT', 'QUOTATION_FOLLOW_UP', 'PURCHASE_FOLLOW_UP',
        'SUPPLIER_PAYMENT', 'ORDER_FOLLOW_UP', 'DELIVERY_FOLLOW_UP',
        'LOW_STOCK_FOLLOW_UP', 'TAX_DEADLINE', 'LICENSE_RENEWAL', 'GENERAL',
      ]).notNullable().defaultTo('CUSTOM')

      t.enum('status', ['pending', 'completed']).notNullable().defaultTo('pending')
      t.enum('priority', ['low', 'medium', 'high', 'urgent']).notNullable().defaultTo('medium')

      t.timestamp('reminder_at').notNullable()

      t.enum('repeat_rule', ['daily', 'weekly', 'monthly', 'yearly', 'custom']) // null = does not repeat
      t.integer('repeat_interval_days') // only meaningful when repeat_rule = 'custom'
      t.date('repeat_until')

      t.uuid('assigned_user_id').references('id').inTable('users').onDelete('SET NULL')
      // Nullable, not notNullable: automatic reminders (invoice-overdue,
      // low-stock — see services/reminderScheduler.js) are system-
      // generated and have no natural "created by" user.
      t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL')

      // Linked existing records — nullable, never a copy of their data.
      t.uuid('customer_id').references('id').inTable('parties').onDelete('CASCADE')
      t.uuid('invoice_id').references('id').inTable('sales').onDelete('CASCADE')
      t.uuid('purchase_id').references('id').inTable('purchases').onDelete('CASCADE')
      t.uuid('quotation_id') // no quotations module exists yet — see docblock
      t.uuid('payment_id')   // payments are vouchers, not a dedicated table — see docblock
      t.uuid('order_id')     // no sales-order module exists yet — see docblock

      t.timestamp('completed_at')
      t.timestamp('snoozed_until')
      t.timestamp('notified_at') // internal — last time the scheduler notified for the CURRENT due time

      t.timestamps(true, true)

      t.index(['company_id', 'status'])
      t.index(['company_id', 'reminder_at'])
      t.index(['company_id', 'assigned_user_id'])
      t.index(['company_id', 'customer_id'])
      t.index(['company_id', 'invoice_id'])
      t.index(['company_id', 'priority'])
      // The dashboard's single most common query: "my company's pending
      // reminders, in due-time order" — one composite index covers it
      // instead of relying on the planner to combine two single-column ones.
      t.index(['company_id', 'status', 'reminder_at'])
    })
    console.log('  + created reminders')
  } else {
    console.log('  = reminders already exists, skipping')
  }

  // ── 2. users.can_manage_reminders ────────────────────────────────────────
  const hasPermCol = await knex.schema.hasColumn('users', 'can_manage_reminders')
  if (!hasPermCol) {
    await knex.schema.alterTable('users', (t) => {
      t.boolean('can_manage_reminders').notNullable().defaultTo(true)
    })
    console.log('  + users.can_manage_reminders added (defaulted true for all existing users)')
  } else {
    console.log('  = users.can_manage_reminders already exists, skipping')
  }

  console.log('[Migration 033] done.\n')
}

exports.down = async (knex) => {
  const hasPermCol = await knex.schema.hasColumn('users', 'can_manage_reminders')
  if (hasPermCol) {
    await knex.schema.alterTable('users', (t) => { t.dropColumn('can_manage_reminders') })
  }
  await knex.schema.dropTableIfExists('reminders')
}
