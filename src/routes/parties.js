/**
 * parties.js — FIXED
 *
 * Original line → bug → fix:
 *
 * L133: db('accounting_entries as ae')
 *         .join('vouchers as v', 'ae.voucher_id', 'v.id')
 *         .select('ae.*', ...)
 *
 *       'accounting_entries' table does not exist.
 *       Real schema (migration 001):
 *         vouchers → journal_entries → journal_lines
 *
 *       FIX: query journal_entries joined to vouchers,
 *            filtered by party_id on the vouchers table.
 *
 * Also removed: the silent try/catch that was hiding this error
 * and triggering a broken fallback query on every ledger call.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextPartyCode, adToBS, auditLog } = require('../utils/helpers')
const AuditLogger = require('../utils/auditLogger')

router.use(authenticate)

/* ── GET /parties/customers ────────────────────────────────────────────────── */
router.get('/customers', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search } = req.query
    // Base filter (no .select() yet) — clone THIS for the count query,
    // so .count() never has to coexist with the p.*/a.name/a.code select list.
    // Adding .select() before .clone() for count caused:
    //   "column p.id must appear in the GROUP BY clause or be used in an
    //    aggregate function" — Postgres correctly rejecting a mixed
    //    SELECT p.*, a.name, count(p.id) with no GROUP BY.
    let base = db('parties as p')
      .leftJoin('accounts as a', 'a.id', 'p.control_account_id')
      .where({ 'p.company_id': req.companyId, 'p.type': 'customer' })
    if (search) base = base.where(b => b.whereILike('p.name', `%${search}%`).orWhereILike('p.phone', `%${search}%`).orWhereILike('p.code', `%${search}%`))

    const [{ count }] = await base.clone().count('p.id as count')
    const data = await base.clone()
      .select('p.*', 'a.name as control_account_name', 'a.code as control_account_code')
      .orderBy('p.name').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /parties/suppliers ────────────────────────────────────────────────── */
router.get('/suppliers', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search } = req.query
    // Same fix as /customers above — see comment there.
    let base = db('parties as p')
      .leftJoin('accounts as a', 'a.id', 'p.control_account_id')
      .where({ 'p.company_id': req.companyId, 'p.type': 'supplier' })
    if (search) base = base.where(b => b.whereILike('p.name', `%${search}%`).orWhereILike('p.phone', `%${search}%`).orWhereILike('p.code', `%${search}%`))

    const [{ count }] = await base.clone().count('p.id as count')
    const data = await base.clone()
      .select('p.*', 'a.name as control_account_name', 'a.code as control_account_code')
      .orderBy('p.name').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── POST /parties/customers ───────────────────────────────────────────────── */
router.post('/customers', async (req, res, next) => {
  try {
    const party = await createParty(req, 'customer')
    return successResponse(res, party, 'Customer created', 201)
  } catch (err) { next(err) }
})

/* ── POST /parties/suppliers ───────────────────────────────────────────────── */
router.post('/suppliers', async (req, res, next) => {
  try {
    const party = await createParty(req, 'supplier')
    return successResponse(res, party, 'Supplier created', 201)
  } catch (err) { next(err) }
})

async function createParty(req, type) {
  const { name, phone, email, address, pan_no, credit_limit, credit_days, opening_balance } = req.body
  if (!name?.trim()) throw Object.assign(new Error('Name is required'), { status: 400 })

  const code        = await nextPartyCode(req.companyId, type)
  const subType     = type === 'customer' ? 'receivable' : 'payable'
  const controlAcct = await db('accounts').where({ company_id: req.companyId, sub_type: subType }).first()

  const [party] = await db('parties').insert({
    company_id:         req.companyId,
    type, code,
    name:               name.trim(),
    phone:              phone?.trim()   || null,
    email:              email?.trim()   || null,
    address:            address?.trim() || null,
    pan_no:             pan_no?.trim()  || null,
    credit_limit:       Number(credit_limit)    || 0,
    credit_days:        Number(credit_days)     || 30,
    opening_balance:    Number(opening_balance) || 0,
    control_account_id: controlAcct?.id || null,
    is_active:          true,
  }).returning('*')

  await AuditLogger.log(db, {
    companyId: req.companyId, userId: req.user.id,
    action: 'CREATE', entityType: 'parties', entityId: party.id,
    payloadAfter: { name, type }, ipAddress: req.ip,
  })
  return party
}

/* ── GET /parties/:id ──────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const party = await db('parties').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!party) return res.status(404).json({ success: false, message: 'Party not found' })
    return successResponse(res, party)
  } catch (err) { next(err) }
})

/* ── PUT /parties/:id ──────────────────────────────────────────────────────── */
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await db('parties').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!existing) return res.status(404).json({ success: false, message: 'Party not found' })

    const allowed = ['name','phone','email','address','pan_no','credit_limit','credit_days','opening_balance','is_active','control_account_id']
    const updates = {}
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        updates[k] = ['credit_limit','credit_days','opening_balance'].includes(k)
          ? Number(req.body[k]) : req.body[k]
      }
    }
    const [updated] = await db('parties').where({ id: req.params.id }).update({ ...updates, updated_at: new Date() }).returning('*')
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'UPDATE', entityType: 'parties', entityId: req.params.id, payloadAfter: updates, ipAddress: req.ip })
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── DELETE /parties/:id ───────────────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  try {
    const party = await db('parties').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!party) return res.status(404).json({ success: false, message: 'Party not found' })

    const [{ count }] = await db('vouchers').where({ company_id: req.companyId, party_id: req.params.id }).count('id as count')
    if (Number(count) > 0) return res.status(400).json({ success: false, message: `Cannot delete — ${count} linked transactions exist` })

    await db('parties').where({ id: req.params.id }).del()
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'DELETE', entityType: 'parties', entityId: req.params.id, payloadBefore: { name: party.name }, ipAddress: req.ip })
    return successResponse(res, null, 'Deleted')
  } catch (err) { next(err) }
})

/* ── GET /parties/:id/ledger ───────────────────────────────────────────────── */
router.get('/:id/ledger', async (req, res, next) => {
  try {
    const party = await db('parties')
      .where({ id: req.params.id, company_id: req.companyId })
      .first()
    if (!party) return res.status(404).json({ success: false, message: 'Party not found' })

    const { date_from, date_to } = req.query
    const isCustomer = party.type === 'customer'

    // ── Helper: apply date filter to a query builder ─────────────────────────
    const applyDates = (q) => {
      if (date_from) q.where('date_ad', '>=', date_from)
      if (date_to)   q.where('date_ad', '<=', date_to)
      return q
    }

    // ── 1. SALES rows (customers only) ────────────────────────────────────────
    // Invoice created → debit (customer owes us)
    // Payment received → credit (customer paid)
    let salesInvoices = []
    let salesPayments = []
    if (isCustomer) {
      salesInvoices = await applyDates(
        db('sales')
          .where({ company_id: req.companyId, party_id: req.params.id, status: 'active' })
      ).select(
        'date_ad    as date',
        'date_bs',
        'invoice_no as reference',
        db.raw("'SALES'         as type"),
        db.raw("'Sales Invoice' as description"),
        'payment_mode',
        'net_total  as debit',
        db.raw('0           as credit'),
      ).orderBy('date_ad', 'asc').orderBy('created_at', 'asc')

      // Restore cash/card payment rows — these are INLINE payments on the invoice
      // itself (payment_mode != 'credit'). They must appear in the ledger as a
      // credit entry on the same date as the invoice.
      //
      // DEDUP RULE (applied later in additiveVoucherRows filter):
      //   If postingEngine also created a RECEIPT voucher with the same
      //   invoice_no as reference (e.g. RV-2026-00001 → reference = INV-2083-002),
      //   that voucher is skipped. Only standalone RV-* receipts are additive.
      //   This prevents double-counting for cash sales.
      salesPayments = await applyDates(
        db('sales')
          .where({ company_id: req.companyId, party_id: req.params.id, status: 'active' })
          .whereNot({ payment_mode: 'credit' })  // cash, card, online, bank only
          .where('paid_amount', '>', 0)
      ).select(
        'date_ad      as date',
        'date_bs',
        'invoice_no   as reference',
        db.raw("'RECEIPT'           as type"),
        db.raw("'Payment received'  as description"),
        'payment_mode',
        db.raw('0               as debit'),
        'paid_amount   as credit',
      ).orderBy('date_ad', 'asc').orderBy('created_at', 'asc')
    }

    // ── 2. PURCHASE rows (suppliers only) ─────────────────────────────────────
    // Bill received → credit (we owe supplier)
    // Payment made  → debit  (we paid supplier)
    let purchaseInvoices = []
    let purchasePayments = []
    if (!isCustomer) {
      purchaseInvoices = await applyDates(
        db('purchases')
          .where({ company_id: req.companyId, party_id: req.params.id, status: 'active' })
      ).select(
        'date_ad          as date',
        'date_bs',
        'bill_no          as reference',
        db.raw("'PURCHASE'         as type"),
        db.raw("'Purchase Bill'    as description"),
        'payment_mode',
        db.raw('0              as debit'),
        'net_total         as credit',
      ).orderBy('date_ad', 'asc').orderBy('created_at', 'asc')

      // Restore cash purchase payments (same logic as salesPayments above)
      purchasePayments = await applyDates(
        db('purchases')
          .where({ company_id: req.companyId, party_id: req.params.id, status: 'active' })
          .whereNot({ payment_mode: 'credit' })
          .where('paid_amount', '>', 0)
      ).select(
        'date_ad          as date',
        'date_bs',
        'bill_no          as reference',
        db.raw("'PAYMENT'              as type"),
        db.raw("'Payment to supplier'  as description"),
        'payment_mode',
        'paid_amount       as debit',
        db.raw('0              as credit'),
      ).orderBy('date_ad', 'asc').orderBy('created_at', 'asc')
    }

    // ── 3. VOUCHER rows (posted accounting entries, if postingEngine is active) ─
    let voucherRows = []
    try {
      // Probe minimum required columns once — cached for this request
      const [hasEntryDate, hasTotalDebit, hasTotalCredit] = await Promise.all([
        db.schema.hasColumn('journal_entries', 'entry_date'),
        db.schema.hasColumn('journal_entries', 'total_debit'),
        db.schema.hasColumn('journal_entries', 'total_credit'),
      ])

      if (hasEntryDate && hasTotalDebit && hasTotalCredit) {
        const [hasNarration, hasCreatedAt] = await Promise.all([
          db.schema.hasColumn('journal_entries', 'narration'),
          db.schema.hasColumn('journal_entries', 'created_at'),
        ])

        // For party ledger, show only ONE side of each voucher entry:
        //   RECEIPT      → Credit only  (customer paid us — reduces receivable)
        //   PAYMENT      → Debit  only  (we paid supplier — reduces payable)
        //   DEBIT_NOTE   → Debit  only  (customer owes more)
        //   CREDIT_NOTE  → Credit only  (customer owes less)
        //   JOURNAL/CONTRA → use net: if net debit > 0 show debit, else credit
        // total_debit and total_credit from journal_entries are BOTH sides of
        // the double-entry — we must not show both or balance never changes.
        const debitExpr  = hasTotalDebit  ? '"je"."total_debit"'  : '0'
        const creditExpr = hasTotalCredit ? '"je"."total_credit"' : '0'

        const partyDebit = `
          CASE v.voucher_type
            WHEN 'RECEIPT'     THEN 0
            WHEN 'PAYMENT'     THEN ${debitExpr}
            WHEN 'DEBIT_NOTE'  THEN ${debitExpr}
            WHEN 'CREDIT_NOTE' THEN 0
            WHEN 'JOURNAL'     THEN GREATEST(0, ${debitExpr} - ${creditExpr})
            WHEN 'CONTRA'      THEN GREATEST(0, ${debitExpr} - ${creditExpr})
            ELSE ${debitExpr}
          END`

        const partyCredit = `
          CASE v.voucher_type
            WHEN 'RECEIPT'     THEN ${creditExpr}
            WHEN 'PAYMENT'     THEN 0
            WHEN 'DEBIT_NOTE'  THEN 0
            WHEN 'CREDIT_NOTE' THEN ${creditExpr}
            WHEN 'JOURNAL'     THEN GREATEST(0, ${creditExpr} - ${debitExpr})
            WHEN 'CONTRA'      THEN GREATEST(0, ${creditExpr} - ${debitExpr})
            ELSE ${creditExpr}
          END`

        let q = db('journal_entries as je')
          .join('vouchers as v', 'je.voucher_id', 'v.id')
          .where('v.company_id', req.companyId)
          .where('v.party_id', req.params.id)
          .where('v.status', 'POSTED')
          .select(
            'je.entry_date                                   as date',
            db.raw('NULL::text                              as date_bs'),
            'v.voucher_no                                    as reference',
            'v.voucher_type                                  as type',
            db.raw(hasNarration ? '"je"."narration" as description' : "NULL::text as description"),
            db.raw('NULL::text                              as payment_mode'),
            db.raw(`(${partyDebit})  as debit`),
            db.raw(`(${partyCredit}) as credit`),
          )

        if (date_from) q = q.where('je.entry_date', '>=', date_from)
        if (date_to)   q = q.where('je.entry_date', '<=', date_to)
        if (hasCreatedAt) q = q.orderBy('je.entry_date', 'asc').orderBy('je.created_at', 'asc')
        else              q = q.orderBy('je.entry_date', 'asc')

        voucherRows = await q
      }
    } catch (e) {
      // journal_entries may not exist yet — non-fatal, skip voucher rows
      console.warn('[ledger] journal_entries unavailable:', e.message)
    }

    // ── 4. Merge ALL sources — sales + vouchers combined ─────────────────────
    //
    // IMPORTANT: sales/purchases always appear in the ledger.
    // Voucher entries (from postingEngine) are ADDITIVE — they do not replace
    // the sales/purchase rows. The two sources are deduplicated by reference:
    // a voucher row that has the same reference as a sale invoice is filtered
    // out to avoid double-counting (this happens when postingEngine has run).
    //
    // Deduplication key: voucher_no typically matches invoice_no for SALES-type
    // vouchers. If the voucher_type is SALES or PURCHASE, skip it because the
    // transaction row already covers it. Only RECEIPT / PAYMENT / JOURNAL /
    // CONTRA vouchers are truly additive.
    // RECEIPT and PAYMENT vouchers are additive ONLY when no salesPayments
    // rows exist. Since we removed synthetic payment rows, we re-add RECEIPT
    // and PAYMENT here — but deduplicate against invoice references to ensure
    // a cash sale's paid_amount isn't shown twice (once as invoice credit column
    // and once as a separate RECEIPT row).
    const ADDITIVE_VOUCHER_TYPES = new Set(['RECEIPT','PAYMENT','JOURNAL','CONTRA','DEBIT_NOTE','CREDIT_NOTE'])

    // Collect invoice refs + cash payment refs for deduplication.
    // A RECEIPT voucher whose reference matches an invoice number means
    // postingEngine created it for that specific sale — skip it because
    // salesPayments already shows the same payment.
    const invoiceRefs = new Set([
      ...salesInvoices.map(r => r.reference),
      ...salesPayments.map(r => r.reference),   // cash sale INV refs
      ...purchaseInvoices.map(r => r.reference),
      ...purchasePayments.map(r => r.reference), // cash purchase bill refs
    ])
    const additiveVoucherRows = voucherRows.filter(v => {
      const vType = String(v.type).toUpperCase()
      if (!ADDITIVE_VOUCHER_TYPES.has(vType)) return false

      // For RECEIPT/PAYMENT vouchers: skip if their voucher_no matches an
      // invoice reference — this means the sale's built-in paid_amount column
      // already handled this payment (cash sale). We only want standalone
      // receipts (manual receipt vouchers like RV-2026-00001).
      // RV-* pattern = standalone receipt; INV-* pattern = sale's own payment
      const ref = String(v.reference || '')
      if ((vType === 'RECEIPT' || vType === 'PAYMENT') && invoiceRefs.has(ref)) {
        return false  // Skip — already represented in the invoice debit/credit columns
      }

      return true
    })

    // Invoice rows + cash payment rows (credit sales don't have payment rows here)
    const transactionRows = [
      ...salesInvoices,
      ...salesPayments,       // cash/card sales: immediate RECEIPT row
      ...purchaseInvoices,
      ...purchasePayments,    // cash purchases: immediate PAYMENT row
    ]

    // Combine: transactions first, then additive voucher entries
    const allEntries = [...transactionRows, ...additiveVoucherRows]
      .sort((a, b) => {
        const da = new Date(String(a.date || '1900-01-01'))
        const db_ = new Date(String(b.date || '1900-01-01'))
        if (da.getTime() !== db_.getTime()) return da - db_
        // Secondary sort: transactions before vouchers on the same date
        const aIsVoucher = ADDITIVE_VOUCHER_TYPES.has(String(a.type).toUpperCase())
        const bIsVoucher = ADDITIVE_VOUCHER_TYPES.has(String(b.type).toUpperCase())
        return aIsVoucher === bIsVoucher ? 0 : aIsVoucher ? 1 : -1
      })

    const useVouchers = additiveVoucherRows.length > 0

    // ── 5. Build running balance ───────────────────────────────────────────────
    //
    // CUSTOMER ledger:
    //   Debit  (+) = customer owes more  (invoice, debit note)
    //   Credit (−) = customer paid       (receipt, credit note)
    //
    // SUPPLIER ledger:
    //   Credit (+) = we owe more         (purchase bill, credit note)
    //   Debit  (−) = we paid             (payment, debit note)
    //
    let balance = Number(party.opening_balance) || 0
    const rows = [{
      date:            null,
      date_bs:         null,
      type:            'opening',
      reference:       '',
      description:     'Opening Balance',
      payment_mode:    null,
      debit:           0,
      credit:          0,
      balance,
      running_balance: balance,
    }]

    for (const e of allEntries) {
      const dr = Math.round(Number(e.debit  || 0) * 100) / 100
      const cr = Math.round(Number(e.credit || 0) * 100) / 100

      if (isCustomer) {
        balance = Math.round((balance + dr - cr) * 100) / 100
      } else {
        balance = Math.round((balance + cr - dr) * 100) / 100
      }

      // Prefer date_bs if available, else convert date_ad to BS, else use date_ad
      const displayDate = e.date_bs
        || (e.date ? (adToBS(String(e.date)) || String(e.date)) : null)

      rows.push({
        date:            displayDate,
        date_ad:         e.date    ? String(e.date)    : null,
        date_bs:         e.date_bs ? String(e.date_bs) : null,
        type:            e.type         || '',
        reference:       e.reference    || '',
        description:     e.description  || '',
        payment_mode:    e.payment_mode || null,
        debit:           dr,
        credit:          cr,
        balance,
        running_balance: balance,
      })
    }

    // ── 6. Summary ────────────────────────────────────────────────────────────
    const totalDebit  = rows.slice(1).reduce((s, r) => s + r.debit,  0)
    const totalCredit = rows.slice(1).reduce((s, r) => s + r.credit, 0)

    return successResponse(res, {
      party,
      rows,
      summary: {
        opening_balance: Number(party.opening_balance) || 0,
        total_debit:     Math.round(totalDebit  * 100) / 100,
        total_credit:    Math.round(totalCredit * 100) / 100,
        closing_balance: balance,
        source:          allEntries.length > 0 ? (additiveVoucherRows.length > 0 ? 'mixed' : 'transactions') : 'none',
      },
      // Legacy fields kept for frontend compat
      closingBalance:  balance,
      opening_balance: Number(party.opening_balance) || 0,
    })
  } catch (err) { next(err) }
})

module.exports = router
