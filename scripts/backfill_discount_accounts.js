/**
 * backfill_discount_accounts.js — One-time backfill for pre-existing companies
 *
 * New companies now get two accounts + Engine Setup mappings automatically:
 *   - 'Discount Allowed'  (expense, sub_type='discount_expense') → role discount_given
 *   - 'Discount Received' (income,  sub_type='discount_income')  → role discount_received
 *
 * Companies created BEFORE this change don't have those accounts in their
 * Chart of Accounts, so `discount_given`/`discount_received` can't be
 * auto-mapped for them by /account-defaults/initialize (it only maps roles
 * to accounts that already exist).
 *
 * This script closes that gap for existing companies:
 *   1. For each target company, create the two accounts IF an account with
 *      that sub_type doesn't already exist (never creates a duplicate).
 *   2. Map discount_given / discount_received to those accounts IF the role
 *      isn't already configured (never overwrites an existing setting).
 *
 * IDEMPOTENT — safe to run multiple times, and safe to run for companies
 * that already have this fully set up (no-op for them).
 *
 * Does NOT touch: any other account, any other role, any existing
 * transaction, journal entry, or voucher. Runs each company in its own
 * transaction so a problem with one company can't affect another.
 *
 * Usage:
 *   node backfill_discount_accounts.js <company_id>   # single company
 *   node backfill_discount_accounts.js --all           # every company
 *   node backfill_discount_accounts.js --all --dry-run # preview only, no writes
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') })

const { v4: uuid } = require('uuid')
const db = require('../src/db/knex')

const DISCOUNT_ACCOUNTS = [
  {
    subType:     'discount_expense',
    role:        'discount_given',
    name:        'Discount Allowed',
    type:        'expense',
    normal:      'debit',
    parentType:  'expense',   // find/attach under the company's expense group
    startCode:   5104,
  },
  {
    subType:     'discount_income',
    role:        'discount_received',
    name:        'Discount Received',
    type:        'income',
    normal:      'credit',
    parentType:  'income',    // find/attach under the company's income group
    startCode:   4101,
  },
]

async function nextFreeCode(trx, companyId, startCode) {
  let code = startCode
  // Avoid colliding with a code the company may already be using for
  // something else (e.g. a custom account). Just count up until free.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const clash = await trx('accounts').where({ company_id: companyId, code: String(code) }).first()
    if (!clash) return String(code)
    code++
  }
}

async function backfillCompany(companyId, { dryRun = false } = {}) {
  const trx = await db.transaction()
  try {
    const results = []

    for (const cfg of DISCOUNT_ACCOUNTS) {
      // 1) Does an account for this purpose already exist?
      let account = await trx('accounts')
        .where({ company_id: companyId, sub_type: cfg.subType, is_active: true })
        .first()

      if (!account) {
        const parent = await trx('accounts')
          .where({ company_id: companyId, type: cfg.parentType, is_group: true })
          .orderBy('code')
          .first()

        const code = await nextFreeCode(trx, companyId, cfg.startCode)

        if (dryRun) {
          results.push({ action: 'would-create-account', role: cfg.role, name: cfg.name, code })
        } else {
          const id = uuid()
          await trx('accounts').insert({
            id,
            company_id:     companyId,
            code,
            name:           cfg.name,
            type:           cfg.type,
            sub_type:       cfg.subType,
            normal_balance: cfg.normal,
            is_group:       false,
            is_active:      true,
            is_system:      false,
            parent_id:      parent ? parent.id : null,
          })
          account = { id, code, name: cfg.name }
          results.push({ action: 'created-account', role: cfg.role, name: cfg.name, code })
        }
      } else {
        results.push({ action: 'account-already-exists', role: cfg.role, name: account.name, code: account.code })
      }

      // 2) Is the Engine Setup role already mapped? Never overwrite it.
      const existingDefault = await trx('account_defaults')
        .where({ company_id: companyId, role: cfg.role })
        .first()

      if (existingDefault) {
        results.push({ action: 'role-already-mapped', role: cfg.role })
        continue
      }

      if (!account) {
        // dry-run with no pre-existing account — nothing to map to yet
        results.push({ action: 'would-map-role', role: cfg.role, note: '(after account is created)' })
        continue
      }

      if (dryRun) {
        results.push({ action: 'would-map-role', role: cfg.role, account: account.code })
      } else {
        await trx('account_defaults').insert({
          company_id:          companyId,
          account_id:          account.id,
          role:                cfg.role,
          description:         'Auto-assigned by discount-accounts backfill',
          is_active:            true,
          is_default:           true,
          default_account_id:  account.id,
        })
        results.push({ action: 'mapped-role', role: cfg.role, account: account.code })
      }
    }

    if (dryRun) {
      await trx.rollback()
    } else {
      await trx.commit()
    }
    return results
  } catch (err) {
    await trx.rollback()
    throw err
  }
}

async function main() {
  const args   = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const all    = args.includes('--all')
  const companyId = args.find(a => !a.startsWith('--'))

  if (!all && !companyId) {
    console.error('Usage:')
    console.error('  node backfill_discount_accounts.js <company_id>')
    console.error('  node backfill_discount_accounts.js --all [--dry-run]')
    process.exit(1)
  }

  const companyIds = all
    ? (await db('companies').select('id', 'name'))
    : [{ id: companyId, name: companyId }]

  console.log(`\n${dryRun ? '🔍 DRY RUN — ' : ''}Backfilling discount accounts for ${companyIds.length} compan${companyIds.length === 1 ? 'y' : 'ies'}\n`)

  let ok = 0, failed = 0
  for (const c of companyIds) {
    try {
      const results = await backfillCompany(c.id, { dryRun })
      console.log(`✅ ${c.name || c.id}`)
      for (const r of results) console.log(`    ${r.action.padEnd(24)} ${r.role}${r.code ? '  code=' + r.code : ''}${r.account ? '  → ' + r.account : ''}`)
      ok++
    } catch (err) {
      console.error(`❌ ${c.name || c.id}: ${err.message}`)
      failed++
    }
  }

  console.log(`\nDone. Succeeded: ${ok}  |  Failed: ${failed}${dryRun ? '  (dry run — no changes written)' : ''}\n`)
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1) })
