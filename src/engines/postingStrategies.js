/**
 * PostingStrategies — Strategy pattern for voucher-type-specific posting logic.
 *
 * Each strategy receives: { voucher, lines, trx, companyId }
 * Each strategy returns: journalLines[] — array of { account_id, debit, credit, description, party_id }
 *
 * Strategies handle:
 *   - FIFO inventory deduction (sales)
 *   - FIFO inventory receipt (purchase)
 *   - Tax account auto-split (VAT)
 *   - Control account routing (receivables/payables)
 */

class SalesStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    const journalLines = []

    for (const line of lines) {
      // Pass all voucher lines through unchanged.
      // voucherBuilder already creates a dedicated CR VAT Payable line in voucher_lines
      // when VAT applies — do NOT add another CR here or VAT is double-counted,
      // creating more credits than debits and breaking Trial Balance.
      journalLines.push({
        account_id:  line.account_id,
        debit:       Number(line.debit),
        credit:      Number(line.credit),
        description: line.description,
        party_id:    line.party_id || voucher.party_id,
      })
    }

    // FIFO stock deduction — process inventory movements if metadata contains items
    if (voucher.metadata?.items?.length > 0) {
      const cogsAccount = await trx('accounts')
        .where({ company_id: companyId, sub_type: 'cogs', is_active: true })
        .first()
      const inventoryAccount = await trx('accounts')
        .where({ company_id: companyId, sub_type: 'inventory', is_active: true })
        .first()

      if (cogsAccount && inventoryAccount) {
        let totalCOGS = 0
        for (const item of voucher.metadata.items) {
          const cogs = await deductFIFO(trx, companyId, item.product_id, item.qty, voucher.id)
          totalCOGS += cogs
        }
        if (totalCOGS > 0) {
          journalLines.push({ account_id: cogsAccount.id, debit: totalCOGS, credit: 0, description: 'Cost of Goods Sold' })
          journalLines.push({ account_id: inventoryAccount.id, debit: 0, credit: totalCOGS, description: 'Inventory reduction (FIFO)' })
        }
      }
    }

    return journalLines
  }
}

class PurchaseStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    const journalLines = []

    for (const line of lines) {
      // Pass all voucher lines through unchanged.
      // voucherBuilder already creates a dedicated DR VAT Input line in voucher_lines
      // when VAT applies — do NOT add another DR here or input VAT is double-counted,
      // creating more debits than credits and breaking Trial Balance.
      journalLines.push({
        account_id:  line.account_id,
        debit:       Number(line.debit),
        credit:      Number(line.credit),
        description: line.description,
        party_id:    line.party_id || voucher.party_id,
      })
    }

    // Add inventory batches for stock items.
    // create_inventory_batches flag controls this to avoid double-inserts
    // when the purchases route has already created the batch records.
    // Set metadata.create_inventory_batches = true only when batches
    // have NOT been created by the calling route.
    if (voucher.metadata?.create_inventory_batches === true && voucher.metadata?.items?.length > 0) {
      for (const item of voucher.metadata.items) {
        if (item.product_id && item.qty > 0) {
          const unitCost = Number(item.unit_cost || item.rate || 0)
          const qty = Number(item.qty)
          await trx('inventory_batches').insert({
            company_id:    companyId,
            product_id:    item.product_id,
            voucher_id:    voucher.id,
            batch_no:      item.batch_no    || null,
            expiry_date:   item.expiry_date || null,
            receipt_date:  voucher.voucher_date,
            qty_received:  qty,
            qty_remaining: qty,
            unit_cost:     unitCost,
            total_cost:    qty * unitCost,
          })
          await trx('inventory_movements').insert({
            company_id:    companyId,
            product_id:    item.product_id,
            voucher_id:    voucher.id,
            movement_type: 'IN',
            qty,
            unit_cost:     unitCost,
            total_cost:    qty * unitCost,
            movement_date: voucher.voucher_date,
            description:   `Purchase via PostingEngine: ${voucher.voucher_no}`,
          })
        }
      }
    } else if (voucher.metadata?.items?.length > 0) {
      // Batches were created by the purchases route — link voucher_id for audit trail
      for (const item of voucher.metadata.items) {
        if (item.product_id) {
          await trx('inventory_batches')
            .where({ company_id: companyId, product_id: item.product_id })
            .whereNull('voucher_id')
            .orderBy('created_at', 'desc')
            .limit(1)
            .update({ voucher_id: voucher.id })
        }
      }
    }

    return journalLines
  }
}

class PaymentStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    // Payments: standard pass-through — lines already specify debit (bank/cash) + credit (payable)
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description,
      party_id:    l.party_id || voucher.party_id,
    }))
  }
}

class ReceiptStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description,
      party_id:    l.party_id || voucher.party_id,
    }))
  }
}

class JournalStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    // Pure journal — validates balance and passes through
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description,
      party_id:    l.party_id,
    }))
  }
}

class ContraStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    // Contra: typically cash to bank or vice versa
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description,
      party_id:    null,
    }))
  }
}

class DebitNoteStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description,
      party_id:    l.party_id || voucher.party_id,
    }))
  }
}

class CreditNoteStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description,
      party_id:    l.party_id || voucher.party_id,
    }))
  }
}

class OpeningStrategy {
  async execute({ voucher, lines, trx, companyId }) {
    // Opening balances: each account gets its opening balance
    return lines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.debit),
      credit:      Number(l.credit),
      description: l.description || 'Opening Balance',
      party_id:    l.party_id,
    }))
  }
}

// ─── FIFO Deduction Engine ────────────────────────────────────────────────────
async function deductFIFO(trx, companyId, productId, qtyNeeded, voucherId) {
  // Get available batches in FIFO order (oldest first, then by expiry)
  const batches = await trx('inventory_batches')
    .where({ company_id: companyId, product_id: productId })
    .where('qty_remaining', '>', 0)
    .orderBy('receipt_date', 'asc')
    .orderBy('expiry_date', 'asc')

  let remaining = Number(qtyNeeded)
  let totalCOGS = 0

  for (const batch of batches) {
    if (remaining <= 0) break

    const available = Number(batch.qty_remaining)
    const deduct    = Math.min(remaining, available)
    const costDeducted = deduct * Number(batch.unit_cost)

    // Update batch qty_remaining
    await trx('inventory_batches').where({ id: batch.id }).update({
      qty_remaining: available - deduct,
    })

    // Record movement
    await trx('inventory_movements').insert({
      company_id:    companyId,
      product_id:    productId,
      batch_id:      batch.id,
      voucher_id:    voucherId,
      movement_type: 'OUT',
      qty:           deduct,
      unit_cost:     batch.unit_cost,
      total_cost:    costDeducted,
      movement_date: new Date().toISOString().split('T')[0],
      description:   `FIFO deduction`,
    })

    totalCOGS += costDeducted
    remaining -= deduct
  }

  if (remaining > 0) {
    throw new Error(`Insufficient stock: ${remaining} units of product ${productId} not available`)
  }

  return totalCOGS
}

// ─── Strategy Registry ────────────────────────────────────────────────────────
const STRATEGIES = {
  SALES:       new SalesStrategy(),
  PURCHASE:    new PurchaseStrategy(),
  PAYMENT:     new PaymentStrategy(),
  RECEIPT:     new ReceiptStrategy(),
  JOURNAL:     new JournalStrategy(),
  CONTRA:      new ContraStrategy(),
  DEBIT_NOTE:  new DebitNoteStrategy(),
  CREDIT_NOTE: new CreditNoteStrategy(),
  OPENING:     new OpeningStrategy(),
  CLOSING:     new JournalStrategy(),
  REVERSAL:    new JournalStrategy(),
}

const PostingStrategies = {
  getStrategy(voucherType) {
    const strategy = STRATEGIES[voucherType]
    if (!strategy) throw new Error(`No posting strategy found for voucher type: ${voucherType}`)
    return strategy
  },
}

module.exports = PostingStrategies
module.exports.deductFIFO = deductFIFO
