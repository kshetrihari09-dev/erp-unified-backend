/**
 * Migration 009 — Voucher Posting Engine
 *
 * Changes (all additive / backward-compatible):
 *
 * 1. vouchers.voucher_type check constraint: add REVERSAL value.
 *    Knex t.enum() on PostgreSQL creates a CHECK constraint, NOT a named TYPE.
 *    So we DROP the old check constraint and ADD a new one that includes REVERSAL.
 *
 * 2. sales.voucher_id    — nullable FK → vouchers (guard: skip if exists)
 * 3. purchases.voucher_id — nullable FK → vouchers (guard: skip if exists)
 * 4. receives.voucher_id  — nullable FK → vouchers (new column)
 *
 * 5. New table: voucher_postings
 *    Cross-reference: every operational record → its voucher + journal entry.
 *    Used for idempotency checks and the posting audit trail.
 *
 * 6. New table: account_defaults
 *    Company-level COA role mapping (accounts_receivable, sales_revenue, …).
 *    PostingEngine reads this instead of hardcoded sub_type lookups.
 *
 * Nothing drops or modifies existing data columns.
 */

exports.up = async (knex) => {

  // ── 1. Fix voucher_type check constraint to include REVERSAL ─────────────
  // Find the name of the existing check constraint on vouchers.voucher_type.
  const constraintRows = await knex.raw(`
    SELECT conname
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'vouchers'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%voucher_type%'
    LIMIT 1
  `)

  const existingConstraint = constraintRows.rows[0]?.conname

  if (existingConstraint) {
    // Check if REVERSAL is already in the constraint definition
    const defRow = await knex.raw(`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      WHERE r.relname = 'vouchers' AND c.conname = ?
    `, [existingConstraint])

    const def = defRow.rows[0]?.def || ''
    if (!def.includes('REVERSAL')) {
      // Drop old constraint, add new one with REVERSAL included
      await knex.raw(`ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS "${existingConstraint}"`)
      await knex.raw(`
        ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
        CHECK (voucher_type IN (
          'SALES','PURCHASE','PAYMENT','RECEIPT',
          'JOURNAL','CONTRA','DEBIT_NOTE','CREDIT_NOTE',
          'OPENING','CLOSING','REVERSAL'
        ))
      `)
    }
    // else REVERSAL already present — nothing to do
  } else {
    // No constraint found (maybe dropped earlier) — add a fresh one
    await knex.raw(`
      ALTER TABLE vouchers ADD CONSTRAINT IF NOT EXISTS vouchers_voucher_type_check
      CHECK (voucher_type IN (
        'SALES','PURCHASE','PAYMENT','RECEIPT',
        'JOURNAL','CONTRA','DEBIT_NOTE','CREDIT_NOTE',
        'OPENING','CLOSING','REVERSAL'
      ))
    `).catch(() => {
      // IF NOT EXISTS syntax not supported on all PG versions — ignore if constraint already exists
    })
  }

  // ── 2. sales.voucher_id guard ─────────────────────────────────────────────
  const hasSalesVoucherId = await knex.schema.hasColumn('sales', 'voucher_id')
  if (!hasSalesVoucherId) {
    await knex.schema.table('sales', t => {
      t.uuid('voucher_id').nullable().references('id').inTable('vouchers').onDelete('SET NULL')
      t.index('voucher_id', 'idx_sales_voucher_id')
    })
  }

  // ── 3. purchases.voucher_id guard ─────────────────────────────────────────
  const hasPurchasesVoucherId = await knex.schema.hasColumn('purchases', 'voucher_id')
  if (!hasPurchasesVoucherId) {
    await knex.schema.table('purchases', t => {
      t.uuid('voucher_id').nullable().references('id').inTable('vouchers').onDelete('SET NULL')
      t.index('voucher_id', 'idx_purchases_voucher_id')
    })
  }

  // ── 4. receives.voucher_id ────────────────────────────────────────────────
  const hasReceivesVoucherId = await knex.schema.hasColumn('receives', 'voucher_id')
  if (!hasReceivesVoucherId) {
    await knex.schema.table('receives', t => {
      t.uuid('voucher_id').nullable().references('id').inTable('vouchers').onDelete('SET NULL')
      t.index('voucher_id', 'idx_receives_voucher_id')
    })
  }

  // ── 5. voucher_postings ───────────────────────────────────────────────────
  const hasVoucherPostings = await knex.schema.hasTable('voucher_postings')
  if (!hasVoucherPostings) {
    await knex.schema.createTable('voucher_postings', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('voucher_id').notNullable().references('id').inTable('vouchers').onDelete('CASCADE')
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('sale_id').nullable().references('id').inTable('sales').onDelete('SET NULL')
      t.uuid('purchase_id').nullable().references('id').inTable('purchases').onDelete('SET NULL')
      t.uuid('receive_id').nullable().references('id').inTable('receives').onDelete('SET NULL')
      t.string('source_type', 50).notNullable()
      t.string('source_ref', 100).nullable()
      t.timestamp('posted_at').nullable()
      t.timestamps(true, true)
      t.index(['company_id', 'voucher_id'])
      t.index(['company_id', 'source_type'])
      t.index('sale_id')
      t.index('purchase_id')
      t.index('receive_id')
    })
  }

  // ── 6. account_defaults ───────────────────────────────────────────────────
  const hasAccountDefaults = await knex.schema.hasTable('account_defaults')
  if (!hasAccountDefaults) {
    await knex.schema.createTable('account_defaults', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
      t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
      t.uuid('account_id').notNullable().references('id').inTable('accounts').onDelete('RESTRICT')
      t.string('role', 60).notNullable()
      t.text('description').nullable()
      t.boolean('is_active').defaultTo(true)
      t.timestamps(true, true)
      t.unique(['company_id', 'role'])
      t.index(['company_id', 'role'])
    })
  }
}

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('account_defaults')
  await knex.schema.dropTableIfExists('voucher_postings')

  const hasReceivesVoucherId = await knex.schema.hasColumn('receives', 'voucher_id')
  if (hasReceivesVoucherId) {
    await knex.schema.table('receives', t => t.dropColumn('voucher_id'))
  }

  // Restore original check constraint (without REVERSAL)
  await knex.raw(`ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check`)
  await knex.raw(`
    ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
    CHECK (voucher_type IN (
      'SALES','PURCHASE','PAYMENT','RECEIPT',
      'JOURNAL','CONTRA','DEBIT_NOTE','CREDIT_NOTE','OPENING','CLOSING'
    ))
  `).catch(() => {})
}
