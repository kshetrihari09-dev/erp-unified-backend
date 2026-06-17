/**
 * VoucherBuilder — Centralized Voucher Line Construction
 *
 * Responsibility:
 *   Given a raw operational transaction (sale, purchase, receive, …),
 *   resolve the correct account IDs and construct the balanced
 *   voucher + voucher_lines needed for PostingEngine.
 *
 * Rules:
 *   - Reads account mappings from `account_defaults` (configured per company)
 *   - Falls back to `accounts.sub_type` lookup if no explicit default exists
 *   - Never creates journal_entries directly (PostingEngine does that)
 *   - Never commits a transaction (caller owns the trx)
 *   - Returns { voucherPayload, lines[] } ready to pass to VoucherService.create()
 *
 * Supported transaction types:
 *   buildSaleVoucher(sale, items, trx, companyId, userId)
 *   buildPurchaseVoucher(purchase, items, trx, companyId, userId)
 *   buildReceiveVoucher(receive, items, trx, companyId, userId)
 *   buildSaleReturnVoucher(original, returnItems, trx, companyId, userId)
 *   buildPurchaseReturnVoucher(original, returnItems, trx, companyId, userId)
 */

const { AppError } = require('../engines/postingEngine')

// ─── Account Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve an account ID by its role.
 * Checks account_defaults first, then falls back to sub_type search.
 * Throws AppError if no account found (missing COA setup).
 */
async function resolveAccount(trx, companyId, role) {
  // 1. Check account_defaults table
  const def = await trx('account_defaults as ad')
    .join('accounts as a', 'ad.account_id', 'a.id')
    .where({ 'ad.company_id': companyId, 'ad.role': role, 'ad.is_active': true, 'a.is_active': true })
    .select('a.id', 'a.name', 'a.code', 'a.type', 'a.sub_type')
    .first()

  if (def) return def

  // 2. Fall back to sub_type search (legacy / auto-detection)
  // Map role names to sub_type values used in the Chart of Accounts
  const subTypeMap = {
    accounts_receivable: 'accounts_receivable',
    accounts_payable:    'accounts_payable',
    sales_revenue:       'sales',
    purchase_expense:    'purchases',
    inventory:           'inventory',
    cogs:                'cogs',
    cash:                'cash',
    bank:                'bank',
    tax_payable:         'tax_payable',
    tax_input:           'tax_input',
    discount_given:      'discount_expense',
    discount_received:   'discount_income',
  }

  const subType = subTypeMap[role] || role
  const account = await trx('accounts')
    .where({ company_id: companyId, sub_type: subType, is_active: true, is_group: false })
    .first()

  if (!account) {
    throw new AppError(
      `No account configured for role "${role}". ` +
      `Please set up your Chart of Accounts or add an entry to account_defaults for this company.`,
      422
    )
  }

  return account
}

/**
 * Resolve cash or bank account based on payment_mode.
 */
async function resolvePaymentAccount(trx, companyId, paymentMode) {
  const modeToRole = {
    cash:   'cash',
    bank:   'bank',
    cheque: 'bank',
    upi:    'bank',
    credit: null,  // credit sales → no immediate cash entry
  }
  const role = modeToRole[paymentMode] || 'cash'
  if (!role) return null
  return resolveAccount(trx, companyId, role)
}

// ─── Sale Voucher Builder ─────────────────────────────────────────────────────

/**
 * Build a SALES voucher payload.
 *
 * Accounting for a cash sale:
 *   DR Cash/Bank           net_total
 *   CR Sales Revenue       net_total - vat_amount
 *   CR VAT Payable         vat_amount  (if vat > 0)
 *
 * Accounting for a credit sale:
 *   DR Accounts Receivable net_total
 *   CR Sales Revenue       net_total - vat_amount
 *   CR VAT Payable         vat_amount  (if vat > 0)
 *
 * If there are inventory-tracked items, COGS entries are added
 * via the SalesStrategy inside PostingEngine (FIFO deduction).
 * We do NOT add COGS lines here — PostingEngine handles that via metadata.
 */
async function buildSaleVoucher({ sale, items, trx, companyId, userId }) {
  const isCredit = sale.payment_mode === 'credit'
  const vatAmount = Number(sale.vat_amount) || 0
  const netTotal  = Number(sale.net_total)  || 0
  const salesNet  = netTotal - vatAmount

  // Resolve accounts
  const debitAccount  = isCredit
    ? await resolveAccount(trx, companyId, 'accounts_receivable')
    : await resolvePaymentAccount(trx, companyId, sale.payment_mode)
  const revenueAccount = await resolveAccount(trx, companyId, 'sales_revenue')

  const lines = []

  // DR line: Cash/Bank or Receivable
  lines.push({
    account_id:  debitAccount.id,
    party_id:    sale.party_id || null,
    debit:       netTotal,
    credit:      0,
    description: `${isCredit ? 'Credit Sale' : 'Cash Sale'} — ${sale.invoice_no}`,
  })

  // CR line: Sales Revenue
  lines.push({
    account_id:  revenueAccount.id,
    party_id:    null,
    debit:       0,
    credit:      salesNet > 0 ? salesNet : netTotal,
    description: `Sales Revenue — ${sale.invoice_no}`,
  })

  // CR line: VAT Payable (only if there is VAT)
  if (vatAmount > 0) {
    const vatAccount = await resolveAccount(trx, companyId, 'tax_payable')
    lines.push({
      account_id:  vatAccount.id,
      party_id:    null,
      debit:       0,
      credit:      vatAmount,
      description: `VAT Payable — ${sale.invoice_no}`,
    })
  }

  // Build metadata for PostingEngine's SalesStrategy FIFO deduction
  const inventoryItems = items.filter(i => i.product_id && Number(i.qty) > 0)

  const voucherPayload = {
    companyId,
    userId,
    voucherType:  'SALES',
    voucherDate:  sale.date_ad,
    partyId:      sale.party_id || null,
    narration:    `Sales Invoice ${sale.invoice_no}` + (sale.notes ? ` — ${sale.notes}` : ''),
    referenceNo:  sale.invoice_no,
    currency:     'NPR',
    metadata: {
      source_type: 'SALE',
      source_id:   sale.id,
      invoice_no:  sale.invoice_no,
      payment_mode: sale.payment_mode,
      items: inventoryItems.map(i => ({
        product_id: i.product_id,
        qty:        Number(i.qty),
        unit_cost:  Number(i.rate) || 0,
      })),
    },
    lines,
  }

  return voucherPayload
}

// ─── Purchase Voucher Builder ─────────────────────────────────────────────────

/**
 * Build a PURCHASE voucher payload.
 *
 * Accounting for credit purchase:
 *   DR Inventory / Purchase Expense   net_total - vat_amount
 *   DR VAT Input                      vat_amount (if vat > 0)
 *   CR Accounts Payable               net_total
 *
 * Accounting for cash purchase:
 *   DR Inventory / Purchase Expense   net_total
 *   CR Cash/Bank                      net_total
 */
async function buildPurchaseVoucher({ purchase, items, trx, companyId, userId }) {
  const isCredit  = purchase.payment_mode === 'credit'
  const vatAmount = Number(purchase.vat_amount) || 0
  const netTotal  = Number(purchase.net_total)  || 0
  const purchaseNet = netTotal - vatAmount

  // Resolve accounts
  const creditAccount   = isCredit
    ? await resolveAccount(trx, companyId, 'accounts_payable')
    : await resolvePaymentAccount(trx, companyId, purchase.payment_mode)
  const inventoryAccount = await resolveAccount(trx, companyId, 'inventory')

  const lines = []

  // DR line: Inventory asset
  lines.push({
    account_id:  inventoryAccount.id,
    party_id:    null,
    debit:       purchaseNet > 0 ? purchaseNet : netTotal,
    credit:      0,
    description: `Inventory Purchase — ${purchase.bill_no}`,
  })

  // DR line: Input VAT
  if (vatAmount > 0) {
    const vatInputAccount = await resolveAccount(trx, companyId, 'tax_input')
    lines.push({
      account_id:  vatInputAccount.id,
      party_id:    null,
      debit:       vatAmount,
      credit:      0,
      description: `Input VAT — ${purchase.bill_no}`,
    })
  }

  // CR line: Payable or Cash
  lines.push({
    account_id:  creditAccount.id,
    party_id:    purchase.party_id || null,
    debit:       0,
    credit:      netTotal,
    description: `${isCredit ? 'Trade Payable' : 'Cash Payment'} — ${purchase.bill_no}`,
  })

  // Build metadata for PurchaseStrategy's inventory batch creation
  const inventoryItems = items.filter(i => i.product_id && Number(i.qty) > 0)

  const voucherPayload = {
    companyId,
    userId,
    voucherType:  'PURCHASE',
    voucherDate:  purchase.date_ad,
    partyId:      purchase.party_id || null,
    narration:    `Purchase Bill ${purchase.bill_no}` +
                  (purchase.supplier_bill_no ? ` (Supplier: ${purchase.supplier_bill_no})` : '') +
                  (purchase.notes ? ` — ${purchase.notes}` : ''),
    referenceNo:  purchase.bill_no,
    currency:     'NPR',
    metadata: {
      source_type:       'PURCHASE',
      source_id:         purchase.id,
      bill_no:           purchase.bill_no,
      supplier_bill_no:  purchase.supplier_bill_no,
      payment_mode:      purchase.payment_mode,
      items: inventoryItems.map(i => ({
        product_id:  i.product_id,
        qty:         Number(i.qty) + Number(i.bonus || 0),
        unit_cost:   Number(i.rate) || 0,
        batch_no:    i.batch_no    || null,
        expiry_date: i.expiry_date || null,
      })),
    },
    lines,
  }

  return voucherPayload
}

// ─── Receive Voucher Builder ──────────────────────────────────────────────────

/**
 * Build a RECEIPT voucher for a stock receive (goods received without purchase order).
 *
 * Simple inventory-in with no financial liability:
 *   DR Inventory        total_value
 *   CR Purchase/Expense total_value
 *
 * This represents an internal stock adjustment / donation / opening stock entry.
 */
async function buildReceiveVoucher({ receive, items, trx, companyId, userId }) {
  const totalValue = items.reduce((sum, i) => {
    return sum + (Number(i.qty || 0) + Number(i.bonus || 0)) * Number(i.rate || 0)
  }, 0)

  if (totalValue === 0) return null  // zero-value receives don't need accounting entries

  const inventoryAccount = await resolveAccount(trx, companyId, 'inventory')
  const purchaseAccount  = await resolveAccount(trx, companyId, 'purchase_expense')

  const lines = [
    {
      account_id:  inventoryAccount.id,
      debit:       totalValue,
      credit:      0,
      description: `Stock Received — ${receive.id}`,
    },
    {
      account_id:  purchaseAccount.id,
      debit:       0,
      credit:      totalValue,
      description: `Inventory Received (no bill) — ${receive.id}`,
    },
  ]

  return {
    companyId,
    userId,
    voucherType:  'PURCHASE',
    voucherDate:  receive.date || new Date().toISOString().split('T')[0],
    partyId:      receive.party_id || null,
    narration:    `Stock Receive — ${receive.id}`,
    referenceNo:  null,
    currency:     'NPR',
    metadata: {
      source_type: 'RECEIVE',
      source_id:   receive.id,
      items: items.filter(i => i.product_id && Number(i.qty) > 0).map(i => ({
        product_id: i.product_id,
        qty:        Number(i.qty) + Number(i.bonus || 0),
        unit_cost:  Number(i.rate) || 0,
        batch_no:   i.batch_no || null,
      })),
    },
    lines,
  }
}

// ─── Sale Return Voucher Builder ──────────────────────────────────────────────

/**
 * Build a CREDIT_NOTE voucher for a sales return.
 *
 * Reverses the sale accounting:
 *   DR Sales Revenue       return_total
 *   CR Cash/Receivable     return_total
 *   (COGS reversal handled by PostingEngine if inventory items present)
 */
async function buildSaleReturnVoucher({ originalSale, returnItems, returnDate, trx, companyId, userId }) {
  const returnTotal = returnItems.reduce((s, i) => s + Number(i.qty || 0) * Number(i.rate || 0), 0)
  if (returnTotal <= 0) throw new AppError('Sale return total must be greater than zero', 400)

  const revenueAccount = await resolveAccount(trx, companyId, 'sales_revenue')
  const creditAccount  = originalSale.payment_mode === 'credit'
    ? await resolveAccount(trx, companyId, 'accounts_receivable')
    : await resolvePaymentAccount(trx, companyId, originalSale.payment_mode || 'cash')

  const lines = [
    {
      account_id:  revenueAccount.id,
      party_id:    null,
      debit:       returnTotal,
      credit:      0,
      description: `Sales Return — Ref: ${originalSale.invoice_no}`,
    },
    {
      account_id:  creditAccount.id,
      party_id:    originalSale.party_id || null,
      debit:       0,
      credit:      returnTotal,
      description: `Refund/Credit — Sales Return Ref: ${originalSale.invoice_no}`,
    },
  ]

  return {
    companyId,
    userId,
    voucherType:  'CREDIT_NOTE',
    voucherDate:  returnDate || new Date().toISOString().split('T')[0],
    partyId:      originalSale.party_id || null,
    narration:    `Sales Return — Original Invoice: ${originalSale.invoice_no}`,
    referenceNo:  originalSale.invoice_no,
    currency:     'NPR',
    metadata: {
      source_type:         'SALE_RETURN',
      original_sale_id:    originalSale.id,
      original_invoice_no: originalSale.invoice_no,
      items: returnItems.filter(i => i.product_id).map(i => ({
        product_id: i.product_id,
        qty:        Number(i.qty),
        unit_cost:  Number(i.rate) || 0,
      })),
    },
    lines,
  }
}

// ─── Purchase Return Voucher Builder ─────────────────────────────────────────

/**
 * Build a DEBIT_NOTE voucher for a purchase return.
 *
 * Reverses the purchase accounting:
 *   DR Accounts Payable    return_total
 *   CR Inventory           return_total
 */
async function buildPurchaseReturnVoucher({ originalPurchase, returnItems, returnDate, trx, companyId, userId }) {
  const returnTotal = returnItems.reduce((s, i) => s + Number(i.qty || 0) * Number(i.rate || 0), 0)
  if (returnTotal <= 0) throw new AppError('Purchase return total must be greater than zero', 400)

  const payableAccount   = await resolveAccount(trx, companyId, 'accounts_payable')
  const inventoryAccount = await resolveAccount(trx, companyId, 'inventory')

  const lines = [
    {
      account_id:  payableAccount.id,
      party_id:    originalPurchase.party_id || null,
      debit:       returnTotal,
      credit:      0,
      description: `Purchase Return — Ref: ${originalPurchase.bill_no}`,
    },
    {
      account_id:  inventoryAccount.id,
      party_id:    null,
      debit:       0,
      credit:      returnTotal,
      description: `Inventory Returned to Supplier — Ref: ${originalPurchase.bill_no}`,
    },
  ]

  return {
    companyId,
    userId,
    voucherType:  'DEBIT_NOTE',
    voucherDate:  returnDate || new Date().toISOString().split('T')[0],
    partyId:      originalPurchase.party_id || null,
    narration:    `Purchase Return — Original Bill: ${originalPurchase.bill_no}`,
    referenceNo:  originalPurchase.bill_no,
    currency:     'NPR',
    metadata: {
      source_type:          'PURCHASE_RETURN',
      original_purchase_id: originalPurchase.id,
      original_bill_no:     originalPurchase.bill_no,
      items: returnItems.filter(i => i.product_id).map(i => ({
        product_id: i.product_id,
        qty:        Number(i.qty),
        unit_cost:  Number(i.rate) || 0,
      })),
    },
    lines,
  }
}

// ─── Payment / Receipt Voucher Builders ──────────────────────────────────────

/**
 * Build a PAYMENT voucher (paying a supplier).
 *
 *   DR Accounts Payable   amount
 *   CR Cash/Bank          amount
 */
async function buildPaymentVoucher({ partyId, amount, paymentMode, paymentDate, narration, referenceNo, trx, companyId, userId }) {
  if (!amount || amount <= 0) throw new AppError('Payment amount must be positive', 400)

  const payableAccount = await resolveAccount(trx, companyId, 'accounts_payable')
  const cashAccount    = await resolvePaymentAccount(trx, companyId, paymentMode || 'cash')

  return {
    companyId,
    userId,
    voucherType:  'PAYMENT',
    voucherDate:  paymentDate || new Date().toISOString().split('T')[0],
    partyId:      partyId || null,
    narration:    narration || `Payment to Supplier`,
    referenceNo:  referenceNo || null,
    currency:     'NPR',
    metadata: { source_type: 'PAYMENT', payment_mode: paymentMode },
    lines: [
      {
        account_id:  payableAccount.id,
        party_id:    partyId || null,
        debit:       amount,
        credit:      0,
        description: narration || `Supplier Payment`,
      },
      {
        account_id:  cashAccount.id,
        party_id:    null,
        debit:       0,
        credit:      amount,
        description: `Paid via ${paymentMode || 'cash'}`,
      },
    ],
  }
}

/**
 * Build a RECEIPT voucher (receiving payment from a customer).
 *
 *   DR Cash/Bank          amount
 *   CR Accounts Receivable amount
 */
async function buildReceiptVoucher({ partyId, amount, paymentMode, receiptDate, narration, referenceNo, trx, companyId, userId }) {
  if (!amount || amount <= 0) throw new AppError('Receipt amount must be positive', 400)

  const receivableAccount = await resolveAccount(trx, companyId, 'accounts_receivable')
  const cashAccount       = await resolvePaymentAccount(trx, companyId, paymentMode || 'cash')

  return {
    companyId,
    userId,
    voucherType:  'RECEIPT',
    voucherDate:  receiptDate || new Date().toISOString().split('T')[0],
    partyId:      partyId || null,
    narration:    narration || `Receipt from Customer`,
    referenceNo:  referenceNo || null,
    currency:     'NPR',
    metadata: { source_type: 'RECEIPT', payment_mode: paymentMode },
    lines: [
      {
        account_id:  cashAccount.id,
        party_id:    null,
        debit:       amount,
        credit:      0,
        description: `Received via ${paymentMode || 'cash'}`,
      },
      {
        account_id:  receivableAccount.id,
        party_id:    partyId || null,
        debit:       0,
        credit:      amount,
        description: narration || `Customer Receipt`,
      },
    ],
  }
}

module.exports = {
  resolveAccount,
  resolvePaymentAccount,
  buildSaleVoucher,
  buildPurchaseVoucher,
  buildReceiveVoucher,
  buildSaleReturnVoucher,
  buildPurchaseReturnVoucher,
  buildPaymentVoucher,
  buildReceiptVoucher,
}
