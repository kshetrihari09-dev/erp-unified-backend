/**
 * seed_account_defaults.js — One-time Setup Script
 *
 * Populates the `account_defaults` table for a company by reading
 * existing accounts from the Chart of Accounts (matched by sub_type).
 *
 * Run once per company after initial COA setup:
 *
 *   node seed_account_defaults.js <company_id>
 *
 * Or call POST /accounting/account-defaults manually from the frontend.
 *
 * This script is IDEMPOTENT — safe to run multiple times.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') })

const db = require('../src/db/knex')

// Mapping: role → sub_type in the accounts table
const ROLE_SUBTYPE_MAP = [
  { role: 'accounts_receivable', sub_type: 'accounts_receivable' },
  { role: 'accounts_payable',    sub_type: 'accounts_payable'    },
  { role: 'sales_revenue',       sub_type: 'sales'               },
  { role: 'purchase_expense',    sub_type: 'purchases'           },
  { role: 'inventory',           sub_type: 'inventory'           },
  { role: 'cogs',                sub_type: 'cogs'                },
  { role: 'cash',                sub_type: 'cash'                },
  { role: 'bank',                sub_type: 'bank'                },
  { role: 'tax_payable',         sub_type: 'tax_payable'         },
  { role: 'tax_input',           sub_type: 'tax_input'           },
  { role: 'discount_given',      sub_type: 'discount_expense'    },
  { role: 'discount_received',   sub_type: 'discount_income'     },
]

async function seedAccountDefaults(companyId) {
  console.log(`\n📊 Seeding account_defaults for company: ${companyId}\n`)

  let seeded   = 0
  let skipped  = 0
  let missing  = 0

  for (const { role, sub_type } of ROLE_SUBTYPE_MAP) {
    const account = await db('accounts')
      .where({ company_id: companyId, sub_type, is_active: true, is_group: false })
      .first()

    if (!account) {
      console.warn(`  ⚠️  No account found for sub_type="${sub_type}" (role="${role}") — skipping`)
      missing++
      continue
    }

    const existing = await db('account_defaults')
      .where({ company_id: companyId, role })
      .first()

    if (existing) {
      if (existing.account_id === account.id) {
        console.log(`  ✅  ${role.padEnd(25)} → ${account.code} ${account.name} (already set)`)
        skipped++
      } else {
        await db('account_defaults')
          .where({ company_id: companyId, role })
          .update({ account_id: account.id, updated_at: new Date() })
        console.log(`  🔄  ${role.padEnd(25)} → ${account.code} ${account.name} (updated)`)
        seeded++
      }
    } else {
      await db('account_defaults').insert({
        company_id:  companyId,
        account_id:  account.id,
        role,
        description: `Auto-seeded from sub_type="${sub_type}"`,
        is_active:   true,
      })
      console.log(`  ✨  ${role.padEnd(25)} → ${account.code} ${account.name} (created)`)
      seeded++
    }
  }

  console.log(`\nDone. Seeded: ${seeded}  |  Already set: ${skipped}  |  Missing accounts: ${missing}`)
  if (missing > 0) {
    console.log('\n⚠️  Some roles have no matching account. Create these accounts in your COA')
    console.log('   then re-run this script, or set them manually via:')
    console.log('   POST /accounting/account-defaults  { role, account_id }')
  }
  console.log()
}

const companyId = process.argv[2]
if (!companyId) {
  console.error('Usage: node seed_account_defaults.js <company_id>')
  process.exit(1)
}

seedAccountDefaults(companyId)
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1) })
