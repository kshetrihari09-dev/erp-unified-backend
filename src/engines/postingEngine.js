/**
 * PostingEngine — Bank-grade double-entry posting engine
 *
 * Architecture:
 *   1. Validate: period lock, debit=credit, account status
 *   2. Idempotency: check processing_log for duplicate
 *   3. Advisory lock: prevent concurrent posting of same voucher
 *   4. Execute strategy (postSales, postPurchase, postPayment, etc.)
 *   5. Write immutable journal_entry + journal_lines
 *   6. Hash chain: compute + store entry_hash + prev_hash
 *   7. Mark processing_log as COMPLETED
 *   8. Update voucher status to POSTED
 *   9. Write audit log
 *
 * RULES (non-negotiable):
 *   - Runs entirely inside a single PostgreSQL transaction
 *   - Idempotent: posting same voucher twice is a no-op
 *   - Journal is append-only (DB trigger enforces this)
 *   - Debit must equal Credit (DB CHECK constraint enforces this)
 */

const crypto = require('crypto')
const db = require('../db/knex')
const { hashJournalEntry, getLastJournalHash } = require('../utils/hashing')
const AuditLogger = require('../utils/auditLogger')
const PostingStrategies = require('./postingStrategies')
const { todayDateOnly, yearOf } = require('../utils/dateOnly')
const { activeEntryVoucherId } = require('../services/currentEntry')

class PostingEngine {

  /**
   * Post a voucher — the main entry point.
   * @param {string} voucherId
   * @param {string} userId  — the user performing the post
   * @param {string} ipAddress
   * @returns {object} journal_entry
   */
  static async post(voucherId, userId, ipAddress = null) {
    // ── Step 1: Load voucher (outside transaction for quick validation) ──
    const voucher = await db('vouchers as v')
      .leftJoin('users as u', 'v.created_by', 'u.id')
      .where('v.id', voucherId)
      .select('v.*', 'u.company_id as company_id_check')
      .first()

    if (!voucher) throw new AppError('Voucher not found', 404)
    if (voucher.status === 'POSTED')    throw new AppError('Voucher is already posted', 409)
    if (voucher.status === 'CANCELLED') throw new AppError('Cannot post a cancelled voucher', 400)
    if (voucher.status === 'REVERSED')  throw new AppError('Cannot post a reversed voucher', 400)

    const companyId     = voucher.company_id
    const idempotencyKey = `post:${voucherId}`

    return db.transaction(async trx => {
      // ── Step 2: Set RLS context ──────────────────────────────────────
      await db.setRLSContext(trx, companyId)

      // ── Step 3: Idempotency check ────────────────────────────────────
      const existing = await trx('processing_log')
        .where({ company_id: companyId, idempotency_key: idempotencyKey })
        .first()

      if (existing?.status === 'COMPLETED') {
        // Already posted — return the existing journal entry (idempotent)
        const je = await trx('journal_entries').where({ id: existing.result_id }).first()
        return { alreadyPosted: true, journal_entry: je }
      }
      if (existing?.status === 'PROCESSING') {
        throw new AppError('Voucher is currently being processed by another request', 409)
      }

      // ── Step 4: Acquire PostgreSQL advisory lock (concurrency safety) ─
      // Hash the UUID to a bigint for pg_try_advisory_xact_lock
      const lockId = await trx.raw(`SELECT ('x' || substr(md5(?), 1, 16))::bit(64)::bigint AS lock_id`, [voucherId])
      const numericLockId = lockId.rows[0].lock_id
      const lockResult = await trx.raw(`SELECT pg_try_advisory_xact_lock(?) AS acquired`, [numericLockId])
      if (!lockResult.rows[0].acquired) {
        throw new AppError('Another process is posting this voucher. Please retry.', 429)
      }

      // ── Step 5: Mark as PROCESSING (prevents duplicate concurrent posts) ─
      await trx('processing_log').insert({
        company_id:      companyId,
        idempotency_key: idempotencyKey,
        status:          'PROCESSING',
      }).onConflict(['company_id', 'idempotency_key']).merge({ status: 'PROCESSING', started_at: new Date() })

      try {
        // ── Step 6: Period lock check ──────────────────────────────────
        const periodLocked = await trx.raw(
          `SELECT is_period_locked(?, ?::date) AS locked`,
          [companyId, voucher.voucher_date]
        )
        if (periodLocked.rows[0].locked) {
          throw new AppError(`Cannot post — accounting period containing ${voucher.voucher_date} is locked`, 400)
        }

        // ── Step 7: Load voucher lines ─────────────────────────────────
        const lines = await trx('voucher_lines').where({ voucher_id: voucherId }).orderBy('line_no')
        if (lines.length < 2) throw new AppError('Voucher must have at least 2 lines', 400)

        // ── Step 8: Validate debit = credit ───────────────────────────
        const totalDebit  = lines.reduce((s, l) => s + Number(l.debit),  0)
        const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0)
        if (Math.abs(totalDebit - totalCredit) > 0.005) {
          throw new AppError(
            `Voucher does not balance: Debit ${totalDebit.toFixed(2)} ≠ Credit ${totalCredit.toFixed(2)}`,
            400
          )
        }

        // ── Step 9: Validate all accounts exist + are not group accounts ─
        for (const line of lines) {
          const account = await trx('accounts').where({ id: line.account_id, company_id: companyId }).first()
          if (!account) throw new AppError(`Account ${line.account_id} not found`, 404)
          if (account.is_group) throw new AppError(`Cannot post to group account: ${account.name} (${account.code})`, 400)
          if (!account.is_active) throw new AppError(`Account ${account.name} is inactive`, 400)
        }

        // ── Step 10: Execute posting strategy ─────────────────────────
        const strategy = PostingStrategies.getStrategy(voucher.voucher_type)
        const journalLines = await strategy.execute({ voucher, lines, trx, companyId })

        // ── Post-strategy balance guard ────────────────────────────────
        // A buggy strategy can produce an unbalanced journalLines array even when
        // voucher_lines balanced — catch it here before it corrupts the ledger.
        const jlDebit  = journalLines.reduce((s, l) => s + Number(l.debit  || 0), 0)
        const jlCredit = journalLines.reduce((s, l) => s + Number(l.credit || 0), 0)
        if (Math.abs(jlDebit - jlCredit) > 0.005) {
          throw new AppError(
            `[PostingEngine] Strategy "${voucher.voucher_type}" produced an unbalanced journal: ` +
            `Dr ${jlDebit.toFixed(2)} ≠ Cr ${jlCredit.toFixed(2)}. ` +
            `Voucher ${voucher.voucher_no} not posted.`,
            500
          )
        }

        // ── Step 11: Compute hash chain ────────────────────────────────
        const prevHash = await getLastJournalHash(trx, companyId)
        const periodRef = voucher.voucher_date.toString().slice(0, 7) // "2024-08"

        const entryData = {
          company_id:    companyId,
          voucher_id:    voucherId,
          event_type:    'POSTED',
          entry_date:    voucher.voucher_date,
          total_debit:   totalDebit,
          total_credit:  totalCredit,
          narration:     voucher.narration,
          prev_hash:     prevHash,
        }
        const entryHash = hashJournalEntry(entryData)

        // ── Step 12: Write immutable journal entry ─────────────────────
        const [journalEntry] = await trx('journal_entries').insert({
          company_id:    companyId,
          voucher_id:    voucherId,
          event_type:    'POSTED',
          entry_date:    voucher.voucher_date,
          period_ref:    periodRef,
          entry_hash:    entryHash,
          prev_hash:     prevHash,
          total_debit:   totalDebit,
          total_credit:  totalCredit,
          narration:     voucher.narration,
          created_by:    userId,
          created_at:    trx.raw('clock_timestamp()'),
        }).returning('*')

        // ── Step 13: Write immutable journal lines ─────────────────────
        for (const [i, jl] of journalLines.entries()) {
          await trx('journal_lines').insert({
            journal_entry_id: journalEntry.id,
            account_id:       jl.account_id,
            party_id:         jl.party_id || null,
            line_no:          i + 1,
            description:      jl.description || voucher.narration,
            debit:            Number(jl.debit)  || 0,
            credit:           Number(jl.credit) || 0,
            currency:         voucher.currency  || 'NPR',
            exchange_rate:    voucher.exchange_rate || 1,
            debit_base:       Number(jl.debit)  || 0,
            credit_base:      Number(jl.credit) || 0,
          })
        }

        // ── Step 14: Update voucher to POSTED ─────────────────────────
        await trx('vouchers').where({ id: voucherId }).update({
          status:    'POSTED',
          posted_by: userId,
          posted_at: new Date(),
          period_ref: periodRef,
        })

        // ── Step 15: Mark processing as COMPLETED ─────────────────────
        await trx('processing_log')
          .where({ company_id: companyId, idempotency_key: idempotencyKey })
          .update({ status: 'COMPLETED', result_id: journalEntry.id, completed_at: new Date() })

        // ── Step 16: Audit log ─────────────────────────────────────────
        await AuditLogger.log(trx, {
          companyId, userId, action: 'POST_VOUCHER',
          entityType: 'voucher', entityId: voucherId,
          voucherNo: voucher.voucher_no,
          payloadBefore: { status: 'DRAFT' },
          payloadAfter:  { status: 'POSTED', journal_entry_id: journalEntry.id, total_debit: totalDebit },
          ipAddress,
        })

        return { journal_entry: journalEntry, lines_posted: journalLines.length }

      } catch (err) {
        // Mark processing as FAILED so it can be retried
        await trx('processing_log')
          .where({ company_id: companyId, idempotency_key: idempotencyKey })
          .update({ status: 'FAILED', error_message: err.message, completed_at: new Date() })
        throw err
      }
    })
  }

  /**
   * Reverse a posted voucher's CURRENT accounting effect.
   * Creates an equal-and-opposite journal entry. Never modifies the original.
   *
   * If the voucher has been edited (see VoucherEditService) its live journal
   * entry is the one on the active correction anchor, NOT the original
   * entry — that one was already neutralised by the edit. Resolving through
   * `activeEntryVoucherId()` makes sure we reverse what is actually live
   * instead of re-reversing the superseded original (which would corrupt
   * the ledger).
   */
  static async reverse(voucherId, userId, reason, ipAddress = null) {
    const voucher = await db('vouchers').where({ id: voucherId }).first()
    if (!voucher)                       throw new AppError('Voucher not found', 404)
    if (voucher.status !== 'POSTED')    throw new AppError('Only POSTED vouchers can be reversed', 400)

    const companyId     = voucher.company_id
    const idempotencyKey = `reverse:${voucherId}`

    return db.transaction(async trx => {
      await db.setRLSContext(trx, companyId)

      // Serialise against concurrent edits/reversals of the same voucher and
      // re-read it under the lock (its active anchor may have just changed).
      const locked = await trx('vouchers').where({ id: voucherId }).forUpdate().first()
      if (!locked || locked.status !== 'POSTED') throw new AppError('Only POSTED vouchers can be reversed', 400)

      // Idempotency check for reversal
      const existing = await trx('processing_log')
        .where({ company_id: companyId, idempotency_key: idempotencyKey }).first()
      if (existing?.status === 'COMPLETED') {
        throw new AppError('This voucher has already been reversed', 409)
      }

      // Advisory lock
      const lockId = await trx.raw(`SELECT ('x' || substr(md5(?), 1, 16))::bit(64)::bigint AS lock_id`, [`rev-${voucherId}`])
      await trx.raw(`SELECT pg_advisory_xact_lock(?)`, [lockId.rows[0].lock_id])

      // Period lock check for reversal date (today)
      const reversalDate = todayDateOnly()
      const periodLocked = await trx.raw(`SELECT is_period_locked(?, ?::date) AS locked`, [companyId, reversalDate])
      if (periodLocked.rows[0].locked) {
        throw new AppError('Cannot reverse — current period is locked. Contact your accountant.', 400)
      }

      await trx('processing_log').insert({
        company_id: companyId, idempotency_key: idempotencyKey, status: 'PROCESSING',
      }).onConflict(['company_id', 'idempotency_key']).merge({ status: 'PROCESSING' })

      try {
        const entryVoucherId = activeEntryVoucherId(locked)
        const { reversalVoucher, reversalJE } = await PostingEngine._reverseEntry(trx, {
          companyId, userId, reason, ipAddress,
          visibleVoucher: locked, entryVoucherId, reversalDate,
          reversalNo: null,          // normal REV-… number — this IS a user-visible reversal
          internal: false,
          markReversed: true,        // visible voucher (and its anchor, if any) become REVERSED
        })

        await trx('processing_log')
          .where({ company_id: companyId, idempotency_key: idempotencyKey })
          .update({ status: 'COMPLETED', result_id: reversalJE.id, completed_at: new Date() })

        await AuditLogger.log(trx, {
          companyId, userId, action: 'REVERSE_VOUCHER',
          entityType: 'voucher', entityId: voucherId,
          voucherNo: locked.voucher_no,
          payloadBefore: { status: 'POSTED' },
          payloadAfter:  { status: 'REVERSED', reversal_voucher_no: reversalVoucher.voucher_no, reason },
          ipAddress,
        })

        return { reversal_voucher: reversalVoucher, reversal_journal_entry: reversalJE }

      } catch (err) {
        await trx('processing_log')
          .where({ company_id: companyId, idempotency_key: idempotencyKey })
          .update({ status: 'FAILED', error_message: err.message, completed_at: new Date() })
        throw err
      }
    })
  }

  /**
   * Reverse the LIVE accounting entry of a POSTED voucher as one step of an
   * edit, INSIDE the caller's transaction (VoucherEditService.edit()).
   *
   * Differences from reverse():
   *   - runs in the caller's trx → rolls back with the rest of the edit
   *   - reverses the *active* entry (original, or the previous edit's anchor)
   *   - dated at the entry being cancelled, not "today": the old amount and
   *     its reversal then net to zero in the OLD period, so period-bucketed
   *     reports (trial balance, P&L, cash flow…) move with the edit
   *   - uses an internal `SYS-CORR-…` label — no REV-… number is burned
   *   - the visible voucher stays POSTED (it is never flipped to REVERSED,
   *     not even transiently); only a superseded internal anchor is marked
   *
   * Caller must already hold a row lock on the visible voucher.
   */
  static async reverseForCorrection({ trx, voucher, userId, reason, ipAddress = null }) {
    const entryVoucherId = activeEntryVoucherId(voucher)
    const live = await trx('journal_entries').where({ voucher_id: entryVoucherId }).first()
    if (!live) throw new AppError('No journal entry found for this voucher', 404)

    const { reversalVoucher, reversalJE } = await PostingEngine._reverseEntry(trx, {
      companyId: voucher.company_id, userId, reason, ipAddress,
      visibleVoucher: voucher, entryVoucherId,
      reversalDate: String(live.entry_date).slice(0, 10),
      reversalNo: `SYS-CORR-${crypto.randomUUID()}`,
      internal: true,
      markReversed: entryVoucherId !== voucher.id,
    })
    return { reversal_voucher: reversalVoucher, reversal_journal_entry: reversalJE, reversed_entry_voucher_id: entryVoucherId }
  }

  /**
   * Shared core: write an equal-and-opposite entry for the LIVE entry owned
   * by `entryVoucherId`. Always runs inside a caller-supplied transaction.
   * @private
   */
  static async _reverseEntry(trx, { companyId, userId, reason, visibleVoucher, entryVoucherId, reversalDate, reversalNo, internal, markReversed }) {
    const originalEntry = await trx('journal_entries').where({ voucher_id: entryVoucherId }).first()
    if (!originalEntry) throw new AppError('No journal entry found for this voucher', 404)

    // One entry can only ever be neutralised once.
    const alreadyReversed = await trx('journal_entries').where({ reversed_entry_id: originalEntry.id }).first()
    if (alreadyReversed) throw new AppError('This voucher has already been reversed', 409)

    const originalLines = await trx('journal_lines').where({ journal_entry_id: originalEntry.id }).orderBy('line_no')

    let voucherNo = reversalNo
    if (!voucherNo) {
      const r = await trx.raw(`SELECT next_voucher_number(?, ?, ?, ?) AS voucher_no`, [companyId, 'REVERSAL', yearOf(reversalDate), 'REV'])
      voucherNo = r.rows[0].voucher_no
    }

    const [reversalVoucher] = await trx('vouchers').insert({
      company_id:   companyId,
      voucher_no:   voucherNo,
      voucher_type: 'JOURNAL',
      status:       'POSTED',
      voucher_date: reversalDate,
      narration:    `REVERSAL of ${visibleVoucher.voucher_no}: ${reason}`,
      total_amount: originalEntry.total_debit,
      // Public reversals point at the visible voucher (list filters rely on
      // it); internal edit reversals point at the entry owner they cancel.
      reversal_of:  internal ? entryVoucherId : visibleVoucher.id,
      created_by:   userId,
      posted_by:    userId,
      posted_at:    new Date(),
      currency:     visibleVoucher.currency || 'NPR',
      exchange_rate: 1,
      // Tagged at INSERT time (same statement) so an internal reversal can
      // never exist, even for an instant, without its system_correction flag.
      metadata:     internal
        ? JSON.stringify({ system_correction: true, corrects_voucher_id: visibleVoucher.id, internal_only: true, kind: 'edit_reversal' })
        : null,
    }).returning('*')

    // Build reversal lines (swap debit and credit)
    const reversalLines = originalLines.map((l, i) => ({
      voucher_id:  reversalVoucher.id,
      account_id:  l.account_id,
      party_id:    l.party_id,
      line_no:     i + 1,
      description: `Reversal: ${l.description || ''}`,
      debit:       l.credit,  // SWAPPED
      credit:      l.debit,   // SWAPPED
    }))
    for (const rl of reversalLines) await trx('voucher_lines').insert(rl)

    // Hash chain for reversal journal entry.
    // The hash MUST cover exactly the narration that is stored on the entry
    // (verifyJournalChain recomputes it from the stored row). It used to hash
    // `REVERSAL of X` while storing `REVERSAL of X: <reason>`, so every
    // reversal failed chain verification with hash_mismatch.
    const prevHash = await getLastJournalHash(trx, companyId)
    const reversalNarration = `REVERSAL of ${visibleVoucher.voucher_no}: ${reason}`
    const reversalHash = hashJournalEntry({
      company_id:   companyId,
      voucher_id:   reversalVoucher.id,
      event_type:   'REVERSED',
      entry_date:   reversalDate,
      total_debit:  originalEntry.total_credit,  // swapped
      total_credit: originalEntry.total_debit,   // swapped
      narration:    reversalNarration,
      prev_hash:    prevHash,
    })

    const [reversalJE] = await trx('journal_entries').insert({
      company_id:        companyId,
      voucher_id:        reversalVoucher.id,
      reversed_entry_id: originalEntry.id,
      event_type:        'REVERSED',
      entry_date:        reversalDate,
      period_ref:        reversalDate.slice(0, 7),
      entry_hash:        reversalHash,
      prev_hash:         prevHash,
      total_debit:       originalEntry.total_credit,
      total_credit:      originalEntry.total_debit,
      narration:         reversalNarration,
      created_by:        userId,
      created_at:        trx.raw('clock_timestamp()'),
    }).returning('*')

    for (const [i, l] of reversalLines.entries()) {
      await trx('journal_lines').insert({
        journal_entry_id: reversalJE.id,
        account_id:  l.account_id,
        party_id:    l.party_id,
        line_no:     i + 1,
        description: l.description,
        debit:       l.debit,
        credit:      l.credit,
        debit_base:  l.debit,
        credit_base: l.credit,
      })
    }

    if (markReversed) {
      // Entry owner (visible voucher or its anchor) is now neutralised.
      await trx('vouchers').where({ id: entryVoucherId }).update({ status: 'REVERSED', reversed_by: userId })
      // Public reversal of an edited voucher: the visible voucher is reversed too.
      if (!internal && entryVoucherId !== visibleVoucher.id) {
        await trx('vouchers').where({ id: visibleVoucher.id }).update({ status: 'REVERSED', reversed_by: userId })
      }
    }

    return { reversalVoucher, reversalJE }
  }

  /**
   * Post a voucher inside an EXISTING transaction.
   *
   * Used by AccountingIntegration so that voucher creation + posting +
   * operational record save all happen in ONE atomic database transaction.
   * If anything fails, the entire transaction rolls back — no partial records.
   *
   * Unlike post(), this method:
   *   - Does NOT create its own transaction (uses the provided trx)
   *   - Does NOT use advisory locks (caller's transaction serialises access)
   *   - Does NOT use processing_log for idempotency (caller checks voucher_postings)
   *   - DOES set the RLS context
   *   - DOES validate, balance-check, create journal_entry + journal_lines
   *   - DOES update voucher to POSTED
   *   - DOES write the audit log
   *
   * @param {{ trx, voucherId, userId, ipAddress, companyId }} opts
   */
  static async postInTransaction({ trx, voucherId, userId, ipAddress = null, companyId }) {
    // Load voucher within the transaction
    const voucher = await trx('vouchers').where({ id: voucherId }).first()
    if (!voucher) throw new AppError('Voucher not found', 404)
    if (voucher.status === 'POSTED')    throw new AppError('Voucher is already posted', 409)
    if (voucher.status === 'CANCELLED') throw new AppError('Cannot post a cancelled voucher', 400)
    if (voucher.status === 'REVERSED')  throw new AppError('Cannot post a reversed voucher', 400)

    const resolvedCompanyId = companyId || voucher.company_id
    await db.setRLSContext(trx, resolvedCompanyId)

    // Period lock check
    const periodLocked = await trx.raw(
      `SELECT is_period_locked(?, ?::date) AS locked`,
      [resolvedCompanyId, voucher.voucher_date]
    )
    if (periodLocked.rows[0].locked) {
      // Non-retryable: the period stays locked until a human reopens it or
      // corrects the date — an offline-sync queue retrying this exact
      // payload every backoff interval will fail identically forever
      // otherwise (see routes/sales.js / offline/syncEngine.ts).
      throw new AppError(`Cannot post — accounting period containing ${voucher.voucher_date} is locked`, 400, 'PERIOD_LOCKED')
    }

    // Load lines
    const lines = await trx('voucher_lines').where({ voucher_id: voucherId }).orderBy('line_no')
    if (lines.length < 2) throw new AppError('Voucher must have at least 2 lines', 400)

    // Balance check
    const totalDebit  = lines.reduce((s, l) => s + Number(l.debit),  0)
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0)
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new AppError(
        `Voucher does not balance: Debit ${totalDebit.toFixed(2)} ≠ Credit ${totalCredit.toFixed(2)}`,
        400
      )
    }

    // Validate accounts
    for (const line of lines) {
      const account = await trx('accounts').where({ id: line.account_id, company_id: resolvedCompanyId }).first()
      if (!account) throw new AppError(`Account ${line.account_id} not found`, 404)
      if (account.is_group) throw new AppError(`Cannot post to group account: ${account.name} (${account.code})`, 400)
      if (!account.is_active) throw new AppError(`Account ${account.name} is inactive`, 400)
    }

    // Execute posting strategy
    const strategy = PostingStrategies.getStrategy(voucher.voucher_type)
    const journalLines = await strategy.execute({ voucher, lines, trx, companyId: resolvedCompanyId })

    // Post-strategy balance guard — same check as post() above
    const jlDebit  = journalLines.reduce((s, l) => s + Number(l.debit  || 0), 0)
    const jlCredit = journalLines.reduce((s, l) => s + Number(l.credit || 0), 0)
    if (Math.abs(jlDebit - jlCredit) > 0.005) {
      throw new AppError(
        `[PostingEngine] Strategy "${voucher.voucher_type}" produced an unbalanced journal: ` +
        `Dr ${jlDebit.toFixed(2)} ≠ Cr ${jlCredit.toFixed(2)}. ` +
        `Voucher ${voucher.voucher_no} not posted.`,
        500
      )
    }

    // Hash chain
    const prevHash  = await getLastJournalHash(trx, resolvedCompanyId)
    const periodRef = voucher.voucher_date.toString().slice(0, 7)

    const entryData = {
      company_id:   resolvedCompanyId,
      voucher_id:   voucherId,
      event_type:   'POSTED',
      entry_date:   voucher.voucher_date,
      total_debit:  totalDebit,
      total_credit: totalCredit,
      narration:    voucher.narration,
      prev_hash:    prevHash,
    }
    const entryHash = hashJournalEntry(entryData)

    // Write journal entry
    const [journalEntry] = await trx('journal_entries').insert({
      company_id:   resolvedCompanyId,
      voucher_id:   voucherId,
      event_type:   'POSTED',
      entry_date:   voucher.voucher_date,
      period_ref:   periodRef,
      entry_hash:   entryHash,
      prev_hash:    prevHash,
      total_debit:  totalDebit,
      total_credit: totalCredit,
      narration:    voucher.narration,
      created_by:   userId,
      created_at:   trx.raw('clock_timestamp()'),
    }).returning('*')

    // Write journal lines
    for (const [i, jl] of journalLines.entries()) {
      await trx('journal_lines').insert({
        journal_entry_id: journalEntry.id,
        account_id:       jl.account_id,
        party_id:         jl.party_id || null,
        line_no:          i + 1,
        description:      jl.description || voucher.narration,
        debit:            Number(jl.debit)  || 0,
        credit:           Number(jl.credit) || 0,
        currency:         voucher.currency  || 'NPR',
        exchange_rate:    voucher.exchange_rate || 1,
        debit_base:       Number(jl.debit)  || 0,
        credit_base:      Number(jl.credit) || 0,
      })
    }

    // Mark voucher POSTED
    await trx('vouchers').where({ id: voucherId }).update({
      status:     'POSTED',
      posted_by:  userId,
      posted_at:  new Date(),
      period_ref: periodRef,
    })

    // Audit log
    await AuditLogger.log(trx, {
      companyId: resolvedCompanyId, userId, action: 'POST_VOUCHER',
      entityType: 'voucher', entityId: voucherId,
      voucherNo: voucher.voucher_no,
      payloadBefore: { status: 'DRAFT' },
      payloadAfter:  { status: 'POSTED', journal_entry_id: journalEntry.id, total_debit: totalDebit, source: 'AccountingIntegration' },
      ipAddress,
    })

    return { journal_entry: journalEntry, lines_posted: journalLines.length }
  }
}

class AppError extends Error {
  // `code` is an optional machine-readable tag (e.g. 'PERIOD_LOCKED') so
  // callers upstream (AccountingIntegration → routes/sales.js) can tell a
  // structural/config rejection — one that will NEVER succeed on its own,
  // no matter how many times the same payload is retried — from an
  // ordinary validation error. See routes/sales.js's postSale catch block.
  constructor(message, status = 400, code = null) { super(message); this.status = status; this.code = code }
}

module.exports = PostingEngine
module.exports.AppError = AppError
