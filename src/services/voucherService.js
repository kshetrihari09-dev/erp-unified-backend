/**
 * VoucherService — manages voucher lifecycle (CREATE, CANCEL)
 * Posting and reversals are handled by PostingEngine.
 */
const db = require('../db/knex')
const AuditLogger = require('../utils/auditLogger')
const { AppError } = require('../engines/postingEngine')

class VoucherService {

  /**
   * Create a voucher in DRAFT status.
   * Does NOT post to the ledger — call PostingEngine.post() for that.
   */
  static async create({ companyId, userId, voucherType, voucherDate, partyId, periodId, lines, narration, referenceNo, notes, metadata, currency = 'NPR', dueDate }, ipAddress = null) {

    // Validate lines
    if (!lines?.length || lines.length < 2) {
      throw new AppError('A voucher requires at least 2 lines', 400)
    }

    const totalDebit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0)
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0)

    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new AppError(`Voucher does not balance: Dr ${totalDebit.toFixed(2)} ≠ Cr ${totalCredit.toFixed(2)}`, 400)
    }
    if (totalDebit <= 0) {
      throw new AppError('Voucher total must be greater than zero', 400)
    }

    // Validate each line has exactly one of debit/credit
    for (const [i, line] of lines.entries()) {
      const dr = Number(line.debit  || 0)
      const cr = Number(line.credit || 0)
      if (dr > 0 && cr > 0) throw new AppError(`Line ${i+1}: cannot have both debit and credit`, 400)
      if (dr === 0 && cr === 0) throw new AppError(`Line ${i+1}: debit or credit must be non-zero`, 400)
      if (dr < 0 || cr < 0)  throw new AppError(`Line ${i+1}: negative amounts not allowed`, 400)
    }

    // Validate date
    const dateObj = new Date(voucherDate)
    if (isNaN(dateObj.getTime())) throw new AppError('Invalid voucher date', 400)

    // Validate period lock before even creating the draft
    const periodLocked = await db.raw(
      `SELECT is_period_locked(?, ?::date) AS locked`,
      [companyId, voucherDate]
    )
    if (periodLocked.rows[0].locked) {
      throw new AppError(`Cannot create voucher — period containing ${voucherDate} is locked`, 400)
    }

    // Auto-detect period
    let resolvedPeriodId = periodId
    if (!resolvedPeriodId) {
      const period = await db('accounting_periods')
        .where({ company_id: companyId })
        .where('start_date', '<=', voucherDate)
        .where('end_date', '>=', voucherDate)
        .andWhere('is_locked', false)
        .first()
      resolvedPeriodId = period?.id || null
    }

    return db.transaction(async trx => {
      await db.setRLSContext(trx, companyId)

      // Generate atomic voucher number
      const fiscalYear = new Date(voucherDate).getFullYear().toString()
      const prefixMap  = {
        SALES: 'SI', PURCHASE: 'PI', PAYMENT: 'PV', RECEIPT: 'RV',
        JOURNAL: 'JV', CONTRA: 'CO', DEBIT_NOTE: 'DN', CREDIT_NOTE: 'CN',
        OPENING: 'OB', CLOSING: 'YE', REVERSAL: 'REV',
      }
      const prefix = prefixMap[voucherType] || 'VCH'

      const voucherNoResult = await trx.raw(
        `SELECT next_voucher_number(?, ?, ?, ?) AS voucher_no`,
        [companyId, voucherType, fiscalYear, prefix]
      )
      const voucherNo = voucherNoResult.rows[0].voucher_no

      // Insert voucher
      const [voucher] = await trx('vouchers').insert({
        company_id:    companyId,
        period_id:     resolvedPeriodId,
        party_id:      partyId   || null,
        created_by:    userId,
        voucher_no:    voucherNo,
        voucher_type:  voucherType,
        status:        'DRAFT',
        voucher_date:  voucherDate,
        due_date:      dueDate    || null,
        currency:      currency,
        exchange_rate: 1,
        total_amount:  totalDebit,
        reference_no:  referenceNo || null,
        narration:     narration   || null,
        notes:         notes       || null,
        metadata:      metadata ? JSON.stringify(metadata) : null,
      }).returning('*')

      // Insert voucher lines
      for (const [i, line] of lines.entries()) {
        // Validate account exists
        const account = await trx('accounts')
          .where({ id: line.account_id, company_id: companyId })
          .first()
        if (!account) throw new AppError(`Account not found: ${line.account_id}`, 404)

        await trx('voucher_lines').insert({
          voucher_id:  voucher.id,
          account_id:  line.account_id,
          party_id:    line.party_id    || null,
          line_no:     i + 1,
          description: line.description || null,
          debit:       Number(line.debit  || 0),
          credit:      Number(line.credit || 0),
          tax_rate:    Number(line.tax_rate   || 0),
          tax_amount:  Number(line.tax_amount || 0),
          metadata:    line.metadata ? JSON.stringify(line.metadata) : null,
        })
      }

      await AuditLogger.log(trx, {
        companyId, userId, action: 'CREATE_VOUCHER',
        entityType: 'voucher', entityId: voucher.id,
        voucherNo: voucher.voucher_no,
        payloadAfter: { voucher_type: voucherType, total: totalDebit, lines: lines.length },
        ipAddress,
      })

      return { voucher, lines_count: lines.length }
    })
  }

  /**
   * Cancel a DRAFT voucher (not yet posted).
   * Posted vouchers must be reversed, not cancelled.
   */
  static async cancel(voucherId, userId, reason, ipAddress = null) {
    const voucher = await db('vouchers').where({ id: voucherId }).first()
    if (!voucher)                     throw new AppError('Voucher not found', 404)
    if (voucher.status === 'POSTED')  throw new AppError('Cannot cancel a posted voucher. Use reverse instead.', 400)
    if (voucher.status === 'CANCELLED') throw new AppError('Already cancelled', 409)

    await db('vouchers').where({ id: voucherId }).update({
      status:       'CANCELLED',
      cancelled_by: userId,
      cancelled_at: new Date(),
      notes:        `CANCELLED: ${reason}`,
    })

    await AuditLogger.log(db, {
      companyId: voucher.company_id, userId, action: 'CANCEL_VOUCHER',
      entityType: 'voucher', entityId: voucherId,
      voucherNo: voucher.voucher_no,
      payloadBefore: { status: voucher.status },
      payloadAfter: { status: 'CANCELLED', reason },
      ipAddress,
    })

    return { cancelled: true, voucher_no: voucher.voucher_no }
  }

  /**
   * Get a voucher with its lines and journal entry.
   */
  static async get(voucherId, companyId) {
    const voucher = await db('vouchers as v')
      .leftJoin('parties as p', 'v.party_id', 'p.id')
      .leftJoin('users as uc', 'v.created_by', 'uc.id')
      .leftJoin('users as up', 'v.posted_by', 'up.id')
      .where('v.id', voucherId).andWhere('v.company_id', companyId)
      .select(
        'v.*',
        'p.name as party_name', 'p.code as party_code',
        'uc.name as created_by_name',
        'up.name as posted_by_name',
      ).first()
    if (!voucher) throw new AppError('Voucher not found', 404)

    const lines = await db('voucher_lines as vl')
      .leftJoin('accounts as a', 'vl.account_id', 'a.id')
      .leftJoin('parties as p', 'vl.party_id', 'p.id')
      .where('vl.voucher_id', voucherId)
      .select('vl.*', 'a.name as account_name', 'a.code as account_code', 'p.name as party_name')
      .orderBy('vl.line_no')

    const journalEntry = await db('journal_entries').where({ voucher_id: voucherId }).first()

    return { voucher, lines, journal_entry: journalEntry || null }
  }

  /**
   * List vouchers with filters.
   */
  static async list(companyId, { page = 1, limit = 20, voucherType, status, partyId, dateFrom, dateTo, search } = {}) {
    const offset = (page - 1) * limit

    let q = db('vouchers as v')
      .leftJoin('parties as p', 'v.party_id', 'p.id')
      .where('v.company_id', companyId)
      .select('v.*', 'p.name as party_name')

    if (voucherType) q = q.where('v.voucher_type', voucherType)
    if (status)      q = q.where('v.status', status)
    if (partyId)     q = q.where('v.party_id', partyId)
    if (dateFrom)    q = q.where('v.voucher_date', '>=', dateFrom)
    if (dateTo)      q = q.where('v.voucher_date', '<=', dateTo)
    if (search)      q = q.where(b => b.whereILike('v.voucher_no', `%${search}%`).orWhereILike('v.narration', `%${search}%`))

    const [{ count }] = await q.clone().clearSelect().count('v.id as count')
    const data = await q.orderBy('v.voucher_date', 'desc').orderBy('v.created_at', 'desc').limit(limit).offset(offset)

    return { data, total: Number(count), page, limit, totalPages: Math.ceil(Number(count) / limit) }
  }

  /**
   * Create a voucher inside an EXISTING transaction.
   * Used by AccountingIntegration so the voucher creation shares the
   * caller's transaction — any failure rolls back everything atomically.
   *
   * Signature is identical to VoucherService.create() except the first
   * argument is a destructured object that includes `trx`.
   */
  static async createInTransaction({ trx, companyId, userId, voucherType, voucherDate, partyId, periodId, lines, narration, referenceNo, notes, metadata, currency = 'NPR', dueDate }, ipAddress = null) {

    if (!lines?.length || lines.length < 2) {
      throw new AppError('A voucher requires at least 2 lines', 400)
    }

    const totalDebit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0)
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0)

    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new AppError(`Voucher does not balance: Dr ${totalDebit.toFixed(2)} ≠ Cr ${totalCredit.toFixed(2)}`, 400)
    }
    if (totalDebit <= 0) {
      throw new AppError('Voucher total must be greater than zero', 400)
    }

    for (const [i, line] of lines.entries()) {
      const dr = Number(line.debit  || 0)
      const cr = Number(line.credit || 0)
      if (dr > 0 && cr > 0) throw new AppError(`Line ${i+1}: cannot have both debit and credit`, 400)
      if (dr === 0 && cr === 0) throw new AppError(`Line ${i+1}: debit or credit must be non-zero`, 400)
      if (dr < 0 || cr < 0)  throw new AppError(`Line ${i+1}: negative amounts not allowed`, 400)
    }

    const dateObj = new Date(voucherDate)
    if (isNaN(dateObj.getTime())) throw new AppError('Invalid voucher date', 400)

    // Period lock check
    const periodLocked = await trx.raw(
      `SELECT is_period_locked(?, ?::date) AS locked`,
      [companyId, voucherDate]
    )
    if (periodLocked.rows[0].locked) {
      throw new AppError(`Cannot create voucher — period containing ${voucherDate} is locked`, 400)
    }

    // Auto-detect period
    let resolvedPeriodId = periodId
    if (!resolvedPeriodId) {
      const period = await trx('accounting_periods')
        .where({ company_id: companyId })
        .where('start_date', '<=', voucherDate)
        .where('end_date', '>=', voucherDate)
        .andWhere('is_locked', false)
        .first()
      resolvedPeriodId = period?.id || null
    }

    await db.setRLSContext(trx, companyId)

    const fiscalYear = new Date(voucherDate).getFullYear().toString()
    const prefixMap  = {
      SALES: 'SI', PURCHASE: 'PI', PAYMENT: 'PV', RECEIPT: 'RV',
      JOURNAL: 'JV', CONTRA: 'CO', DEBIT_NOTE: 'DN', CREDIT_NOTE: 'CN',
      OPENING: 'OB', CLOSING: 'YE', REVERSAL: 'REV',
    }
    const prefix = prefixMap[voucherType] || 'VCH'

    const voucherNoResult = await trx.raw(
      `SELECT next_voucher_number(?, ?, ?, ?) AS voucher_no`,
      [companyId, voucherType, fiscalYear, prefix]
    )
    const voucherNo = voucherNoResult.rows[0].voucher_no

    const [voucher] = await trx('vouchers').insert({
      company_id:    companyId,
      period_id:     resolvedPeriodId,
      party_id:      partyId   || null,
      created_by:    userId,
      voucher_no:    voucherNo,
      voucher_type:  voucherType,
      status:        'DRAFT',
      voucher_date:  voucherDate,
      due_date:      dueDate    || null,
      currency:      currency,
      exchange_rate: 1,
      total_amount:  totalDebit,
      reference_no:  referenceNo || null,
      narration:     narration   || null,
      notes:         notes       || null,
      metadata:      metadata ? JSON.stringify(metadata) : null,
    }).returning('*')

    for (const [i, line] of lines.entries()) {
      const account = await trx('accounts')
        .where({ id: line.account_id, company_id: companyId })
        .first()
      if (!account) throw new AppError(`Account not found: ${line.account_id}`, 404)

      await trx('voucher_lines').insert({
        voucher_id:  voucher.id,
        account_id:  line.account_id,
        party_id:    line.party_id    || null,
        line_no:     i + 1,
        description: line.description || null,
        debit:       Number(line.debit  || 0),
        credit:      Number(line.credit || 0),
        tax_rate:    Number(line.tax_rate   || 0),
        tax_amount:  Number(line.tax_amount || 0),
        metadata:    line.metadata ? JSON.stringify(line.metadata) : null,
      })
    }

    await AuditLogger.log(trx, {
      companyId, userId, action: 'CREATE_VOUCHER',
      entityType: 'voucher', entityId: voucher.id,
      voucherNo: voucher.voucher_no,
      payloadAfter: { voucher_type: voucherType, total: totalDebit, lines: lines.length, source: 'AccountingIntegration' },
      ipAddress,
    })

    return { voucher, lines_count: lines.length }
  }
}

module.exports = VoucherService
