/**
 * AccountingService.js
 *
 * Lightweight double-entry posting service for Sales and Purchase transactions.
 * Called directly from sales.js and purchases.js inside the SAME database
 * transaction so sale/purchase + journal entries are atomic.
 *
 * Why not use PostingEngine?
 *   PostingEngine.post() requires a pre-existing voucher + voucher_lines.
 *   Sales and purchases never created those records, so the engine was never
 *   triggered. Rather than adding a full voucher workflow, this service posts
 *   directly — creating the voucher + journal_entry + journal_lines in one step.
 *
 * Account mappings (by sub_type — looked up per company so custom COAs work):
 *   Sales:
 *     DR  cash (1001) or receivable (1100)   ← payment_mode determines which
 *     CR  sales (4001)                        sub_type = 'sales'
 *
 *   Purchase:
 *     DR  purchase_expense (5100)             sub_type = 'purchase'
 *     CR  cash (1001) or payable (2001)       ← payment_mode determines which
 *
 * Journal entries are immutable once written. Cancellation posts a reversal.
 */

const { v4: uuid } = require('uuid')

class AccountingService {

  /**
   * Look up an account by sub_type, scoped to a company.
   * Returns the account row or null (never throws — missing account = skip posting).
   */
  static async _getAccount(trx, companyId, subType) {
    return trx('accounts')
      .where({ company_id: companyId, sub_type: subType, is_active: true, is_group: false })
      .first()
  }

  /**
   * Build a period_ref string ("2024-08") from a date string.
   */
  static _periodRef(dateStr) {
    return (dateStr || new Date().toISOString().split('T')[0]).slice(0, 7)
  }

  /**
   * Get the last entry_hash for the company's hash chain.
   * Returns null for the first ever entry.
   */
  static async _lastHash(trx, companyId) {
    const last = await trx('journal_entries')
      .where({ company_id: companyId })
      .orderBy('created_at', 'desc')
      .select('entry_hash')
      .first()
    return last?.entry_hash || null
  }

  /**
   * Simple deterministic hash for a journal entry (mirrors PostingEngine).
   */
  static _hash(data) {
    const str = JSON.stringify(data)
    // Simple hash without crypto dependency — good enough for chain integrity
    let h = 0n
    for (let i = 0; i < str.length; i++) {
      h = (h * 31n + BigInt(str.charCodeAt(i))) % (2n ** 64n)
    }
    return h.toString(16).padStart(16, '0')
  }

  /**
   * Write a voucher + journal_entry + journal_lines inside `trx`.
   *
   * @param {object} trx         - Knex transaction
   * @param {object} opts
   * @param {string} opts.companyId
   * @param {string} opts.userId
   * @param {string} opts.voucherType  - 'SALES' | 'PURCHASE'
   * @param {string} opts.voucherNo    - e.g. 'INV-001'
   * @param {string} opts.date         - 'YYYY-MM-DD'
   * @param {string} [opts.partyId]
   * @param {string} [opts.narration]
   * @param {string} [opts.referenceId]  - sale.id or purchase.id for traceability
   * @param {{ account_id, debit, credit, description }[]} opts.lines
   * @returns {object} { journal_entry, voucher }
   */
  static async _writeEntry(trx, { companyId, userId, voucherType, voucherNo, date,
    partyId, narration, referenceId, lines }) {

    const totalDebit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0)
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0)

    // Guard: must balance
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new Error(
        `Accounting entry for ${voucherNo} does not balance: ` +
        `DR ${totalDebit.toFixed(2)} ≠ CR ${totalCredit.toFixed(2)}`
      )
    }

    const periodRef = this._periodRef(date)

    // ── 1. Create voucher ──────────────────────────────────────────────────
    const [voucher] = await trx('vouchers').insert({
      id:           uuid(),
      company_id:   companyId,
      voucher_no:   voucherNo,
      voucher_type: voucherType,
      status:       'POSTED',
      voucher_date: date,
      period_ref:   periodRef,
      total_amount: totalDebit,
      narration:    narration || null,
      reference_no: referenceId || null,  // traces back to sale/purchase id
      party_id:     partyId || null,
      created_by:   userId,
      posted_by:    userId,
      posted_at:    new Date(),
      currency:     'NPR',
      exchange_rate: 1,
    }).returning('*')

    // ── 2. Create journal entry ────────────────────────────────────────────
    const prevHash = await this._lastHash(trx, companyId)
    const entryHash = this._hash({
      company_id:   companyId,
      voucher_id:   voucher.id,
      entry_date:   date,
      total_debit:  totalDebit,
      total_credit: totalCredit,
      narration,
      prev_hash:    prevHash,
    })

    const [journalEntry] = await trx('journal_entries').insert({
      id:           uuid(),
      company_id:   companyId,
      voucher_id:   voucher.id,
      event_type:   'POSTED',
      entry_date:   date,
      period_ref:   periodRef,
      entry_hash:   entryHash,
      prev_hash:    prevHash,
      total_debit:  totalDebit,
      total_credit: totalCredit,
      narration:    narration || null,
      created_by:   userId,
    }).returning('*')

    // ── 3. Write journal lines ─────────────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      await trx('journal_lines').insert({
        id:               uuid(),
        journal_entry_id: journalEntry.id,
        account_id:       l.account_id,
        party_id:         l.party_id || partyId || null,
        line_no:          i + 1,
        description:      l.description || narration || '',
        debit:            Number(l.debit  || 0),
        credit:           Number(l.credit || 0),
        currency:         'NPR',
        exchange_rate:    1,
        debit_base:       Number(l.debit  || 0),
        credit_base:      Number(l.credit || 0),
      })
    }

    return { journal_entry: journalEntry, voucher }
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */

  /**
   * Post accounting entries for a SALE.
   *
   * Double-entry:
   *   DR  Cash (sub_type='cash')         ← if payment_mode != 'credit'
   *   DR  Accounts Receivable (sub_type='receivable') ← if credit
   *   CR  Sales Revenue (sub_type='sales')
   *
   * @param {object} trx
   * @param {object} sale           - saved sale row
   * @param {string} userId
   */
  static async postSale(trx, sale, userId) {
    const { company_id: companyId, id: saleId, invoice_no,
      date_ad, payment_mode, net_total, party_id } = sale

    // Resolve accounts
    const salesAccount = await this._getAccount(trx, companyId, 'sales')
    if (!salesAccount) {
      console.warn(`[Accounting] No sales account (sub_type=sales) for company ${companyId} — skipping journal`)
      return null
    }

    const debitSubType  = payment_mode === 'credit' ? 'receivable' : 'cash'
    const debitAccount  = await this._getAccount(trx, companyId, debitSubType)
      ?? await this._getAccount(trx, companyId, 'cash')  // fallback to cash
    if (!debitAccount) {
      console.warn(`[Accounting] No ${debitSubType} account for company ${companyId} — skipping journal`)
      return null
    }

    const amount = Number(net_total)
    const lines = [
      {
        account_id:  debitAccount.id,
        debit:       amount,
        credit:      0,
        description: `Sale ${invoice_no}`,
      },
      {
        account_id:  salesAccount.id,
        debit:       0,
        credit:      amount,
        description: `Sale ${invoice_no} — Revenue`,
      },
    ]

    return this._writeEntry(trx, {
      companyId,
      userId,
      voucherType:  'SALES',
      voucherNo:    invoice_no,
      date:         date_ad,
      partyId:      party_id || null,
      narration:    `Sales Invoice ${invoice_no}`,
      referenceId:  saleId,
      lines,
    })
  }

  /**
   * Post accounting entries for a PURCHASE.
   *
   * Double-entry:
   *   DR  Purchase Expense (sub_type='purchase')
   *   CR  Cash (sub_type='cash')         ← if payment_mode != 'credit'
   *   CR  Accounts Payable (sub_type='payable') ← if credit
   *
   * @param {object} trx
   * @param {object} purchase       - saved purchase row
   * @param {string} userId
   */
  static async postPurchase(trx, purchase, userId) {
    const { company_id: companyId, id: purchaseId, bill_no,
      date_ad, payment_mode, net_total, party_id } = purchase

    const purchaseAccount = await this._getAccount(trx, companyId, 'purchase')
    if (!purchaseAccount) {
      console.warn(`[Accounting] No purchase account (sub_type=purchase) for company ${companyId} — skipping journal`)
      return null
    }

    const creditSubType  = payment_mode === 'credit' ? 'payable' : 'cash'
    const creditAccount  = await this._getAccount(trx, companyId, creditSubType)
      ?? await this._getAccount(trx, companyId, 'cash')  // fallback
    if (!creditAccount) {
      console.warn(`[Accounting] No ${creditSubType} account for company ${companyId} — skipping journal`)
      return null
    }

    const amount = Number(net_total)
    const lines = [
      {
        account_id:  purchaseAccount.id,
        debit:       amount,
        credit:      0,
        description: `Purchase ${bill_no}`,
      },
      {
        account_id:  creditAccount.id,
        debit:       0,
        credit:      amount,
        description: `Purchase ${bill_no} — Payment`,
      },
    ]

    return this._writeEntry(trx, {
      companyId,
      userId,
      voucherType:  'PURCHASE',
      voucherNo:    bill_no,
      date:         date_ad,
      partyId:      party_id || null,
      narration:    `Purchase Bill ${bill_no}`,
      referenceId:  purchaseId,
      lines,
    })
  }

  /**
   * Reverse the journal entries for a cancelled sale or purchase.
   * Looks up the voucher by voucher_no and creates an equal-and-opposite entry.
   *
   * @param {object} trx
   * @param {string} companyId
   * @param {string} voucherNo   - invoice_no or bill_no of the cancelled doc
   * @param {string} date        - cancellation date
   * @param {string} userId
   */
  static async reverseEntry(trx, companyId, voucherNo, date, userId) {
    // Find the original journal entry via voucher_no
    const originalVoucher = await trx('vouchers')
      .where({ company_id: companyId, voucher_no: voucherNo, status: 'POSTED' })
      .first()

    if (!originalVoucher) {
      console.warn(`[Accounting] No POSTED voucher found for ${voucherNo} — skipping reversal`)
      return null
    }

    const originalJE = await trx('journal_entries')
      .where({ voucher_id: originalVoucher.id })
      .first()

    if (!originalJE) return null

    const originalLines = await trx('journal_lines')
      .where({ journal_entry_id: originalJE.id })

    // Swap debit ↔ credit
    const reversalLines = originalLines.map(l => ({
      account_id:  l.account_id,
      debit:       Number(l.credit),
      credit:      Number(l.debit),
      description: `REVERSAL: ${l.description || voucherNo}`,
      party_id:    l.party_id,
    }))

    const reversalVoucherNo = `REV-${voucherNo}`
    const periodRef = this._periodRef(date)
    const prevHash  = await this._lastHash(trx, companyId)
    const amount    = originalJE.total_debit

    const entryHash = this._hash({
      company_id:   companyId,
      entry_date:   date,
      event_type:   'REVERSED',
      total_debit:  originalJE.total_credit,
      total_credit: originalJE.total_debit,
      narration:    `REVERSAL of ${voucherNo}`,
      prev_hash:    prevHash,
    })

    // Create reversal voucher
    const [revVoucher] = await trx('vouchers').insert({
      id:           uuid(),
      company_id:   companyId,
      voucher_no:   reversalVoucherNo,
      voucher_type: originalVoucher.voucher_type,
      status:       'POSTED',
      voucher_date: date,
      period_ref:   periodRef,
      total_amount: amount,
      narration:    `REVERSAL of ${voucherNo}`,
      reference_no: originalVoucher.id,
      party_id:     originalVoucher.party_id || null,
      reversal_of:  originalVoucher.id,
      created_by:   userId,
      posted_by:    userId,
      posted_at:    new Date(),
      currency:     'NPR',
      exchange_rate: 1,
    }).returning('*')

    // Mark original voucher as REVERSED
    await trx('vouchers')
      .where({ id: originalVoucher.id })
      .update({ status: 'REVERSED', reversed_by: userId })

    // Create reversal journal entry
    const [revJE] = await trx('journal_entries').insert({
      id:                uuid(),
      company_id:        companyId,
      voucher_id:        revVoucher.id,
      reversed_entry_id: originalJE.id,
      event_type:        'REVERSED',
      entry_date:        date,
      period_ref:        periodRef,
      entry_hash:        entryHash,
      prev_hash:         prevHash,
      total_debit:       originalJE.total_credit,
      total_credit:      originalJE.total_debit,
      narration:         `REVERSAL of ${voucherNo}`,
      created_by:        userId,
    }).returning('*')

    // Write reversal lines
    for (let i = 0; i < reversalLines.length; i++) {
      const l = reversalLines[i]
      await trx('journal_lines').insert({
        id:               uuid(),
        journal_entry_id: revJE.id,
        account_id:       l.account_id,
        party_id:         l.party_id || null,
        line_no:          i + 1,
        description:      l.description,
        debit:            l.debit,
        credit:           l.credit,
        currency:         'NPR',
        exchange_rate:    1,
        debit_base:       l.debit,
        credit_base:      l.credit,
      })
    }

    return { reversal_voucher: revVoucher, reversal_journal_entry: revJE }
  }
}

module.exports = AccountingService
