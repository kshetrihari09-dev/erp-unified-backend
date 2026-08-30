/**
 * Migration 032 — Credit-Risk & Bad-Debt Scoring
 *
 * Purely additive. Adds:
 *
 *  1. customer_credit_profiles — one cached row per customer, holding the
 *     LATEST calculated risk snapshot. This is what the dashboard/customer
 *     profile read from (see requirement #21: don't recalc on every page
 *     load). Recalculation (event/scheduled/manual — see
 *     services/creditRiskEngine.js) overwrites this row and appends to...
 *
 *  2. customer_risk_history — an immutable snapshot per calculation, so
 *     "Risk History" (score over time) can be shown and trends detected.
 *
 *  3. customer_bad_debt_records — this codebase had no write-off/bad-debt
 *     concept at all before this feature. A write-off clears the specific
 *     AR amount via a real JOURNAL voucher (Dr Bad Debt Expense, Cr AR —
 *     see routes/creditRisk.js POST .../write-off), but the *record* of
 *     it happening lives here permanently, independent of that voucher,
 *     satisfying "historical bad-debt records must remain available even
 *     after invoices are written off" (requirement #3F).
 *
 *  4. approvals — this codebase had no generic Approval Management module
 *     either (see IMPLEMENTATION_NOTES.md from the Purchase Suggestions
 *     feature, migration 031, for the same situation with Purchase
 *     Orders). Minimal, generic, reusable: a `type` + jsonb `payload`
 *     rather than a bespoke table per approval kind.
 *
 *  5. notifications — likewise, no notification module existed. Minimal
 *     per-user (or company-wide, when user_id is null) notification feed.
 *
 *  6. vouchers.due_date is NOT newly added here — it already exists
 *     (migration 001) but was never populated for SALES vouchers. See the
 *     additive change in services/voucherBuilder.js buildSaleVoucher()
 *     that now sets it. No schema change needed for that part.
 *
 *  7. users: 7 new boolean permission flags, following the exact
 *     established pattern (can_post_vouchers, can_view_purchase_suggestions,
 *     etc. — migrations 001 and 031).
 */
exports.up = async (knex) => {
  console.log('\n[Migration 032] Credit-Risk & Bad-Debt Scoring...')

  // ── 1. customer_credit_profiles ─────────────────────────────────────────
  const hasProfiles = await knex.schema.hasTable('customer_credit_profiles')
  if (!hasProfiles) {
    await knex.schema.createTable('customer_credit_profiles', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('customer_id').notNullable().references('id').inTable('parties').onDelete('CASCADE')

      // null score/category = "Insufficient Credit History" (requirement #25) —
      // never coerced to a numeric Low-Risk score for lack of data.
      t.integer('current_risk_score')
      t.enum('risk_category', ['low', 'medium', 'high', 'insufficient_data']).notNullable().defaultTo('insufficient_data')
      t.decimal('bad_debt_probability', 6, 2) // percentage, e.g. 68.00
      t.decimal('expected_credit_loss', 14, 2)
      t.enum('payment_trend', ['improving', 'stable', 'worsening']).notNullable().defaultTo('stable')

      t.decimal('outstanding_amount', 14, 2).notNullable().defaultTo(0)
      t.decimal('overdue_amount', 14, 2).notNullable().defaultTo(0)
      t.decimal('credit_utilization', 6, 2) // percentage; null when no credit_limit configured

      t.decimal('recommended_credit_limit', 14, 2)
      t.integer('recommended_payment_terms_days')
      t.string('recommended_action', 200)

      // Full transparent breakdown (see requirement #4/#13) — factor scores,
      // weights used, raw inputs, and the human-readable explanation lines.
      // Kept as jsonb rather than dozens of columns; it's read-heavy,
      // display-only data, not something queried by individual factor.
      t.jsonb('factors').notNullable().defaultTo('{}')

      t.timestamp('last_calculated_at')
      t.timestamps(true, true)

      t.unique(['company_id', 'customer_id']) // "no duplicate customer/company risk profiles"
      t.index(['company_id', 'risk_category'])
      t.index(['company_id', 'current_risk_score'])
    })
    console.log('  + created customer_credit_profiles')
  } else {
    console.log('  = customer_credit_profiles already exists, skipping')
  }

  // ── 2. customer_risk_history ────────────────────────────────────────────
  const hasHistory = await knex.schema.hasTable('customer_risk_history')
  if (!hasHistory) {
    await knex.schema.createTable('customer_risk_history', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('customer_id').notNullable().references('id').inTable('parties').onDelete('CASCADE')
      t.integer('risk_score')
      t.enum('risk_category', ['low', 'medium', 'high', 'insufficient_data']).notNullable()
      t.decimal('bad_debt_probability', 6, 2)
      t.decimal('expected_credit_loss', 14, 2)
      t.enum('payment_trend', ['improving', 'stable', 'worsening']).notNullable().defaultTo('stable')
      t.jsonb('factors').notNullable().defaultTo('{}')
      // What triggered this snapshot — event-based / scheduled / manual
      // (requirement #21) — shown in the Risk History table for context.
      t.string('trigger', 40).notNullable().defaultTo('manual')
      t.timestamp('calculated_at').notNullable().defaultTo(knex.fn.now())
      t.index(['company_id', 'customer_id', 'calculated_at'])
    })
    console.log('  + created customer_risk_history')
  } else {
    console.log('  = customer_risk_history already exists, skipping')
  }

  // ── 3. customer_bad_debt_records ────────────────────────────────────────
  const hasBadDebt = await knex.schema.hasTable('customer_bad_debt_records')
  if (!hasBadDebt) {
    await knex.schema.createTable('customer_bad_debt_records', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('customer_id').notNullable().references('id').inTable('parties').onDelete('CASCADE')
      t.uuid('sale_id').references('id').inTable('sales').onDelete('SET NULL') // nullable: may write off a general balance, not one invoice
      t.uuid('voucher_id').references('id').inTable('vouchers').onDelete('SET NULL') // the JOURNAL voucher that actually cleared the AR balance, if any
      t.decimal('amount', 14, 2).notNullable()
      t.text('reason').notNullable()
      t.uuid('recorded_by').references('id').inTable('users').onDelete('SET NULL')
      t.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now())
      t.index(['company_id', 'customer_id'])
    })
    console.log('  + created customer_bad_debt_records')
  } else {
    console.log('  = customer_bad_debt_records already exists, skipping')
  }

  // ── 4. approvals (generic — see file header) ────────────────────────────
  const hasApprovals = await knex.schema.hasTable('approvals')
  if (!hasApprovals) {
    await knex.schema.createTable('approvals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.string('type', 60).notNullable() // e.g. 'reduce_credit_limit', 'override_risk_warning', 'allow_blocked_credit_sale', 'approve_high_value_credit_sale'
      t.enum('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending')
      t.uuid('customer_id').references('id').inTable('parties').onDelete('CASCADE')
      t.uuid('related_sale_id').references('id').inTable('sales').onDelete('SET NULL')
      t.text('reason') // why the system/user is requesting this
      t.jsonb('payload').notNullable().defaultTo('{}') // proposed change details (e.g. { from_limit, to_limit })
      t.uuid('requested_by').references('id').inTable('users').onDelete('SET NULL')
      t.uuid('decided_by').references('id').inTable('users').onDelete('SET NULL')
      t.text('decision_reason')
      t.timestamp('decided_at')
      t.timestamps(true, true)
      t.index(['company_id', 'status'])
      t.index(['company_id', 'customer_id'])
      t.index(['company_id', 'type'])
    })
    console.log('  + created approvals')
  } else {
    console.log('  = approvals already exists, skipping')
  }

  // ── 5. notifications (generic — see file header) ────────────────────────
  const hasNotifications = await knex.schema.hasTable('notifications')
  if (!hasNotifications) {
    await knex.schema.createTable('notifications', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('user_id').references('id').inTable('users').onDelete('CASCADE') // null = visible to all users of the company with the relevant permission
      t.string('category', 40).notNullable().defaultTo('general') // 'credit_risk', etc. — lets the UI filter/route without a new table per feature
      t.string('severity', 20).notNullable().defaultTo('info') // info | warning | critical
      t.string('title', 200).notNullable()
      t.text('message').notNullable()
      t.uuid('related_customer_id').references('id').inTable('parties').onDelete('CASCADE')
      t.jsonb('metadata').notNullable().defaultTo('{}')
      t.boolean('is_read').notNullable().defaultTo(false)
      t.timestamps(true, true)
      t.index(['company_id', 'user_id', 'is_read'])
      t.index(['company_id', 'category'])
    })
    console.log('  + created notifications')
  } else {
    console.log('  = notifications already exists, skipping')
  }

  // ── 6. users: Credit-Risk permission flags ──────────────────────────────
  const hasPermCol = await knex.schema.hasColumn('users', 'can_view_credit_risk_dashboard')
  if (!hasPermCol) {
    await knex.schema.alterTable('users', (t) => {
      t.boolean('can_view_credit_risk_dashboard').notNullable().defaultTo(true)
      t.boolean('can_view_customer_credit_risk').notNullable().defaultTo(true)
      t.boolean('can_recalculate_credit_risk').notNullable().defaultTo(false)
      t.boolean('can_configure_credit_risk_settings').notNullable().defaultTo(false)
      t.boolean('can_override_credit_risk_warning').notNullable().defaultTo(false)
      t.boolean('can_approve_high_risk_credit_sale').notNullable().defaultTo(false)
      t.boolean('can_view_expected_credit_loss').notNullable().defaultTo(true)
    })
    // Same trust-tier backfill used in migration 031: owner/admin/manager
    // get the elevated actions out of the box.
    await knex('users')
      .whereIn('role', ['owner', 'admin', 'manager'])
      .update({
        can_recalculate_credit_risk: true,
        can_configure_credit_risk_settings: true,
        can_override_credit_risk_warning: true,
        can_approve_high_risk_credit_sale: true,
      })
    console.log('  + users: credit-risk permission flags added + backfilled by role')
  } else {
    console.log('  = users credit-risk permission flags already exist, skipping')
  }

  console.log('[Migration 032] done.\n')
}

exports.down = async (knex) => {
  const hasPermCol = await knex.schema.hasColumn('users', 'can_view_credit_risk_dashboard')
  if (hasPermCol) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('can_view_credit_risk_dashboard')
      t.dropColumn('can_view_customer_credit_risk')
      t.dropColumn('can_recalculate_credit_risk')
      t.dropColumn('can_configure_credit_risk_settings')
      t.dropColumn('can_override_credit_risk_warning')
      t.dropColumn('can_approve_high_risk_credit_sale')
      t.dropColumn('can_view_expected_credit_loss')
    })
  }

  await knex.schema.dropTableIfExists('notifications')
  await knex.schema.dropTableIfExists('approvals')
  await knex.schema.dropTableIfExists('customer_bad_debt_records')
  await knex.schema.dropTableIfExists('customer_risk_history')
  await knex.schema.dropTableIfExists('customer_credit_profiles')
}
