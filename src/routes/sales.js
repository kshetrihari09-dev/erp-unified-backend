/**
 * sales.js — FIXED
 *
 * Original line → bug → fix:
 *
 * L42:  raw SQL: SUM(qty_available) FROM stock_batches   → inventory_batches + qty_remaining
 * L43:  raw SQL: qty_available * p.purchase_rate FROM stock_batches → qty_remaining * ib.unit_cost FROM inventory_batches
 * L44:  db('stock_batches').where('qty_available', '>')  → db('inventory_batches').where('qty_remaining', '>')
 * L123: trx('stock_batches')                             → trx('inventory_batches')
 * L125: .where('qty_available', '>', 0)                  → .where('qty_remaining', '>', 0)
 * L131: batch.qty_available                              → batch.qty_remaining
 * L132: trx('stock_batches').where()                     → trx('inventory_batches').where()
 * L133: qty_out: Number(batch.qty_out) + deduct          → removed (column does not exist)
 * L134: qty_available: Number(batch.qty_available)-deduct → qty_remaining: Number(batch.qty_remaining)-deduct
 * L143: trx('accounting_accounts')                       → trx('accounts')
 * L145: trx('accounting_entries').insert()               → REMOVED (ghost table; postingEngine handles this)
 * L177: trx('stock_batches')                             → trx('inventory_batches')
 * L181: trx('stock_batches').where()                     → trx('inventory_batches').where()
 * L182: qty_out: Math.max(0, Number(batch.qty_out)-item.qty) → removed
 * L183: qty_available: Number(batch.qty_available)+item.qty  → qty_remaining: Number(batch.qty_remaining)+item.qty
 *
 * Batch-selection fix (see migration 016):
 * POST /sales previously deducted stock via a FIFO sweep across every
 * batch of a product, ignoring which batch the Sale page's Batch
 * Selection popup told the user they were selling from — so a sale could
 * silently pull from a batch other than the one shown/selected. It now
 * deducts only from the exact batch (item.batch_id, falling back to a
 * batch_no match for older clients) and records that batch_id on the
 * sale_items row so cancellation restores stock to that same lot.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate, identifyDevice, requireSensitiveConfirm } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextInvoiceNo, adToBS, todayBS, auditLog, clampExpiry, isValidUUID } = require('../utils/helpers')
const AccountingIntegration = require('../services/accountingIntegration')
const VoucherEditService    = require('../services/voucherEditService')

router.use(authenticate)
router.use(identifyDevice)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /sales ────────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search, party_id, status, date_from, date_to } = req.query
    let q = db('sales as s').leftJoin('parties as p', 's.party_id', 'p.id').where('s.company_id', req.companyId).select('s.*', 'p.name as party_name', 'p.phone as party_phone')
    if (search)    q = q.where(b => b.whereILike('s.invoice_no', `%${search}%`).orWhereILike('p.name', `%${search}%`))
    if (party_id)  q = q.where('s.party_id', party_id)
    if (status)    q = q.where('s.status', status)
    if (date_from) q = q.where('s.date_ad', '>=', date_from)
    if (date_to)   q = q.where('s.date_ad', '<=', date_to)
    const [{ count }] = await q.clone().clearSelect().count('s.id as count')
    const data = await q.orderBy('s.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /sales/summary/stats ──────────────────────────────────────────────── */
router.get('/summary/stats', async (req, res, next) => {
  try {
    const today      = new Date().toISOString().split('T')[0]
    const monthStart = today.slice(0, 8) + '01'

    const [todayStats]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('date_ad', today).sum({ total: 'net_total' }).count({ count: 'id' })
    const [monthStats]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('date_ad', '>=', monthStart).sum({ revenue: 'net_total' })
    const [receivable]   = await db('sales').where({ company_id: req.companyId, status: 'active' }).where('due_amount', '>', 0).sum({ total: 'due_amount' })

    // L42 FIX: was raw SQL with stock_batches + qty_available
    const lowStockResult = await db.raw(`
      SELECT COUNT(*) AS cnt
      FROM (
        SELECT p.id FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(qty_remaining) AS stock
          FROM inventory_batches WHERE company_id = ?
          GROUP BY product_id
        ) sb ON p.id = sb.product_id
        WHERE p.company_id = ? AND p.is_active = true
          AND COALESCE(sb.stock, 0) < p.min_stock
      ) t
    `, [req.companyId, req.companyId])

    // L43 FIX: was stock_batches + qty_available * purchase_rate
    const stockValResult = await db.raw(`
      SELECT COALESCE(SUM(ib.qty_remaining * ib.unit_cost), 0) AS val
      FROM inventory_batches ib WHERE ib.company_id = ?
    `, [req.companyId])

    // L44 FIX: was db('stock_batches').where('qty_available', '>')
    const [expiryAlerts] = await db(T)
      .where({ company_id: req.companyId })
      .where(QTY, '>', 0)
      .where('expiry_date', '<=', new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0])
      .whereNotNull('expiry_date')
      .count({ count: 'id' })

    const rawRow = (r) => r?.rows?.[0] ?? r?.[0] ?? r ?? {}
    return successResponse(res, {
      today:           { sales_total: Number(todayStats?.total) || 0, sales_count: Number(todayStats?.count) || 0 },
      this_month:      { revenue: Number(monthStats?.revenue) || 0 },
      receivable:      Number(receivable?.total) || 0,
      stock_value:     Number(rawRow(stockValResult).val)  || 0,
      low_stock_items: Number(rawRow(lowStockResult).cnt)  || 0,
      expiry_alerts:   Number(expiryAlerts?.count)         || 0,
    })
  } catch (err) { next(err) }
})

/* ── GET /sales/:id ────────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const sale = await db('sales as s').leftJoin('parties as p', 's.party_id', 'p.id')
      .where('s.id', req.params.id).andWhere('s.company_id', req.companyId)
      .select('s.*', 'p.name as party_name', 'p.phone as party_phone', 'p.address as party_address', 'p.pan_no as party_pan').first()
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' })
    const items = await db('sale_items').where({ sale_id: sale.id })
    return successResponse(res, { ...sale, items })
  } catch (err) { next(err) }
})

/* ── POST /sales ───────────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { party_id, date_ad, payment_mode, reference_no, items, notes, cc_charge_pct, client_txn_id } = req.body
    if (!items?.length) { await trx.rollback(); return res.status(400).json({ success: false, message: 'At least one item is required' }) }

    // ── Idempotency (offline sync retries) ──────────────────────────────────
    // `client_txn_id` is generated once, client-side, the moment an offline
    // sale is queued (see erp-enterprise-full/src/offline/idGen.ts) and sent
    // unchanged on every retry of the same queued transaction. If a sale
    // with this exact (company_id, client_txn_id) already exists — because
    // an earlier attempt actually succeeded but its response never made it
    // back to the client (dropped connection, app killed mid-request, a
    // slow success racing a backoff retry) — this is NOT a new sale. Return
    // the original result unchanged instead of posting a duplicate invoice,
    // duplicate stock deduction, and duplicate journal entry. See migration
    // 025 for the partial unique index this relies on as a second line of
    // defense (a 23505 from the insert below, in the rare case two retries
    // of the same transaction race each other, is also handled below).
    if (client_txn_id) {
      if (!isValidUUID(client_txn_id)) {
        await trx.rollback()
        return res.status(400).json({ success: false, message: 'client_txn_id must be a UUID' })
      }
      const existingSale = await trx('sales').where({ company_id: req.companyId, client_txn_id }).first()
      if (existingSale) {
        await trx.rollback()
        const existingItems = await db('sale_items').where({ sale_id: existingSale.id })
        return successResponse(res, { ...existingSale, items: existingItems }, 'Invoice already recorded (idempotent replay)', 200)
      }
    }

    // ── Date sequence validation ──────────────────────────────────────────────
    // New invoice date must be >= latest active sales invoice date for this company.
    // Same date is allowed. Future dates are allowed. Earlier dates are rejected.
    //
    // EXCEPT for offline-sync replays (client_txn_id present): that date was
    // fixed the moment the cashier made the sale on a disconnected device,
    // and the transaction can sit in the local queue for hours or days
    // before this endpoint ever sees it — during which perfectly ordinary
    // online sales keep advancing "latest active invoice date" past it.
    // Rejecting it here isn't catching a data-entry mistake, it's punishing
    // the sale for having been made offline: the queue would retry the
    // exact same payload forever on a fixed backoff, fail this check every
    // single time (the date never becomes "not earlier"), and the
    // transaction would never post even though the device is fully online
    // and every other queued sale syncs fine. A cashier's live-entered date
    // still gets the strict check; a replayed offline transaction does not.
    const date = date_ad || new Date().toISOString().split('T')[0]

    if (!client_txn_id) {
      const latestSale = await trx('sales')
        .where({ company_id: req.companyId, status: 'active' })
        .whereNotNull('date_ad')
        .orderBy('date_ad', 'desc')
        .select('date_ad', 'invoice_no')
        .first()

      if (latestSale && date < latestSale.date_ad) {
        await trx.rollback()
        return res.status(400).json({
          success: false,
          message: `Sales entry date cannot be earlier than the previous sales invoice date.`,
          detail:  `Last invoice ${latestSale.invoice_no} is dated ${latestSale.date_ad}. New entry must be on or after this date.`,
          last_invoice_date: latestSale.date_ad,
          last_invoice_no:   latestSale.invoice_no,
        })
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const company    = await trx('companies').where({ id: req.companyId }).first()
    const invoice_no = await nextInvoiceNo(req.companyId, company?.invoice_prefix || 'INV')
    const date_bs    = adToBS(date) || todayBS()

    let subtotal = 0, cc_total = 0
    const saleItems = items.map(item => {
      const qty     = Number(item.qty)   || 0
      const rate    = Number(item.rate)  || 0
      const bonus   = Number(item.bonus) || 0
      const cc_pct  = Number(item.cc_pct) || Number(cc_charge_pct) || 0
      // cc_amount = bonus_qty × rate × (cc_pct / 100.0)
      const cc_amount = (bonus > 0 && cc_pct > 0)
        ? Math.round(bonus * rate * (cc_pct / 100) * 10000) / 10000
        : 0
      // discount_pct was previously accepted/stored per item but never
      // actually applied here — `amount` was computed straight from
      // qty*rate, silently ignoring any discount entered on the Sale
      // page. This now applies it using the same formula the frontend
      // already uses for its own live preview (see utils/calcRowAmount):
      // base = qty*rate*(1-discount_pct/100), amount = base+cc_amount.
      const discount_pct = Number(item.discount_pct) || 0
      const base    = qty * rate * (1 - discount_pct / 100)
      const amount  = Math.round((base + cc_amount) * 100) / 100
      subtotal += amount; cc_total += cc_amount
      return { product_id: item.product_id || null, product_name: item.product_name || '', batch_no: item.batch_no || null, batch_id: item.batch_id || null, expiry: clampExpiry(item.expiry), qty, bonus, rate, discount_pct, cc_pct, cc_amount, amount }
    })

    const unrounded_total = Math.round((subtotal) * 100) / 100

    // ── Round Off ─────────────────────────────────────────────────────────────
    // Applied last, after subtotal/discount/tax are all final. Rounds the
    // grand total to the nearest whole number and records the delta so it
    // can be displayed/printed and reproduced exactly on lookup. When the
    // total is already a whole number, round_off is 0 and net_total is
    // unchanged — Grand Total only moves when a round off is actually applied.
    const net_total = Math.round(unrounded_total)
    const round_off = Math.round((net_total - unrounded_total) * 100) / 100

    const paid_amount = payment_mode === 'credit' ? 0 : net_total
    const due_amount  = net_total - paid_amount

    const [sale] = await trx('sales').insert({
      company_id: req.companyId, party_id: party_id || null, created_by: req.user.id,
      invoice_no, date_ad: date, date_bs, payment_mode: payment_mode || 'cash',
      reference_no: reference_no || null, subtotal, cc_amount: cc_total,
      net_total, round_off, paid_amount, due_amount, status: 'active', notes: notes || null,
      client_txn_id: client_txn_id || null, device_id: req.deviceId || null,
    }).returning('*')

    // ── Stock deduction (batched) ────────────────────────────────────────────
    // Previously: one atomic conditional UPDATE + one INSERT per item,
    // sequentially awaited — for a 90+ item invoice that's 180+ round trips
    // to the database, one after another, easily exceeding the frontend's
    // request timeout (config/env.ts's apiTimeout). When that happens the
    // request aborts with no HTTP response at all, which offline/
    // syncEngine.ts's isNetworkError() can only read as "the connection
    // dropped" — the sale silently gets reset to pending and retried,
    // timing out identically every time, even though the server was still
    // working on it and the device never actually went offline.
    //
    // This keeps the exact same correctness guarantee — a concurrent
    // request can't oversell a batch, because each row's qty_remaining is
    // still checked against ITS OWN current value at the moment Postgres
    // locks that specific row — but does it as one multi-row UPDATE
    // instead of N separate ones, for every item that already carries a
    // batch_id (the normal case: the Sale page's Batch Selection popup
    // always resolves one before a row can be posted). The two rarer
    // legacy paths (batch_no-only clients; no batch selected at all) are
    // still handled with their own smaller queries below — genuine edge
    // cases, not the shape of a large everyday invoice.

    // Legacy back-compat: items that only sent batch_no, not batch_id.
    // Resolved with one query for every such item instead of one query each.
    const needsBatchNoLookup = saleItems.filter(it => it.product_id && it.qty > 0 && !it.batch_id && it.batch_no)
    if (needsBatchNoLookup.length) {
      const candidates = await trx(T)
        .whereIn('batch_no', [...new Set(needsBatchNoLookup.map(it => it.batch_no))])
        .andWhere({ company_id: req.companyId })
        .andWhere(QTY, '>', 0)
        .orderBy('created_at', 'asc')
        .select('id', 'product_id', 'batch_no')
      const firstMatch = new Map() // `${product_id}::${batch_no}` -> id, first (oldest) one only
      for (const row of candidates) {
        const key = `${row.product_id}::${row.batch_no}`
        if (!firstMatch.has(key)) firstMatch.set(key, row.id)
      }
      for (const it of needsBatchNoLookup) {
        const resolved = firstMatch.get(`${it.product_id}::${it.batch_no}`)
        if (!resolved) {
          await trx.rollback()
          return res.status(400).json({ success: false, message: `Batch "${it.batch_no}" has no available stock for "${it.product_name}".` })
        }
        it._batchIdToUse = resolved
      }
    }
    for (const it of saleItems) {
      if (it._batchIdToUse === undefined) it._batchIdToUse = it.batch_id || null
    }

    // Sum quantities per batch_id first — two lines can legitimately share
    // one lot, and a single UPDATE...FROM(VALUES) can only carry one
    // deduction amount per row. Also remember which product_id each batch
    // was claimed under — the original per-item code cross-checked
    // product_id against the batch (guarding against a batch_id that
    // exists but belongs to a different product than the item claims),
    // and the bulk version below preserves that same check.
    const batchDeductions  = new Map() // batch_id -> total qty to deduct
    const batchProductIds  = new Map() // batch_id -> product_id it was claimed under
    for (const it of saleItems) {
      if (it.product_id && it.qty > 0 && it._batchIdToUse) {
        batchDeductions.set(it._batchIdToUse, (batchDeductions.get(it._batchIdToUse) || 0) + it.qty)
        if (!batchProductIds.has(it._batchIdToUse)) batchProductIds.set(it._batchIdToUse, it.product_id)
      }
    }

    const succeededBatchIds = new Set()
    if (batchDeductions.size) {
      const ids        = [...batchDeductions.keys()]
      const qtys       = ids.map(id => batchDeductions.get(id))
      const productIds = ids.map(id => batchProductIds.get(id))
      const { rows: updatedRows } = await trx.raw(
        `UPDATE ${T} AS ib
            SET ${QTY} = ib.${QTY} - v.deduct
           FROM (SELECT * FROM UNNEST(?::uuid[], ?::numeric[], ?::uuid[]) AS v(id, deduct, product_id)) AS v
          WHERE ib.id = v.id
            AND ib.company_id = ?
            AND ib.product_id = v.product_id
            AND ib.${QTY} >= v.deduct
        RETURNING ib.id`,
        [ids, qtys, productIds, req.companyId],
      )
      for (const row of updatedRows) succeededBatchIds.add(row.id)
    }

    // Anything requested but not returned above either doesn't exist,
    // belongs to another company, or didn't have enough stock left — same
    // three cases the old per-item code distinguished; one follow-up
    // read-only lookup (not one per item) builds the right message for
    // whichever batch failed first.
    const failedBatchId = [...batchDeductions.keys()].find(id => !succeededBatchIds.has(id))
    if (failedBatchId) {
      const failingItem  = saleItems.find(it => it._batchIdToUse === failedBatchId)
      const currentBatch = await trx(T).where({ id: failedBatchId, product_id: batchProductIds.get(failedBatchId), company_id: req.companyId }).first()
      await trx.rollback()

      if (!currentBatch) {
        return res.status(400).json({ success: false, message: `Selected batch for "${failingItem?.product_name}" no longer exists — please re-select a batch.` })
      }

      const available = Number(currentBatch[QTY])
      const requested = batchDeductions.get(failedBatchId)
      // A structured conflict record only makes sense for a genuine
      // cross-device/offline scenario (this request came from the offline
      // sync queue and/or a registered device) — an ordinary online sale
      // hitting a stale UI snapshot is just a normal validation error to
      // the person looking right at the screen.
      if (client_txn_id || req.deviceId) {
        try {
          await db('sync_conflicts').insert({
            transaction_id: client_txn_id || null, device_id: req.deviceId || null,
            company_id: req.companyId, user_id: req.user.id,
            conflict_type: 'STOCK_CONFLICT', transaction_type: 'sale',
            local_state:  JSON.stringify({ product_id: failingItem?.product_id, product_name: failingItem?.product_name, batch_id: failedBatchId, requested }),
            server_state: JSON.stringify({ batch_id: failedBatchId, available }),
            reason: `Insufficient stock in batch "${currentBatch.batch_no || '—'}" for "${failingItem?.product_name}" (available ${available}, requested ${requested}).`,
          })
        } catch (logErr) {
          console.error('[sync_conflicts] failed to log conflict', logErr.message)
        }
      }

      return res.status(409).json({
        success: false,
        status: 'CONFLICT',
        code: 'INSUFFICIENT_STOCK',
        transaction_id: client_txn_id || null,
        message: `Insufficient stock in batch "${currentBatch.batch_no || '—'}" for "${failingItem?.product_name}" (available ${available}, requested ${requested}).`,
        available,
        requested,
        product_id: failingItem?.product_id,
        product_name: failingItem?.product_name,
      })
    }

    // Legacy fallback — no batch selected at all (non-batch-tracked
    // callers only; the Sale page itself always resolves one before a row
    // can be posted). Rare enough that the original per-item FIFO sweep is
    // left exactly as it was — this is never the shape of a large invoice.
    for (const it of saleItems) {
      if (it.product_id && it.qty > 0 && !it._batchIdToUse) {
        const batches = await trx(T)
          .where({ product_id: it.product_id, company_id: req.companyId })
          .where(QTY, '>', 0)
          .orderBy('expiry_date', 'asc')

        let remaining = it.qty
        for (const b of batches) {
          if (remaining <= 0) break
          const deduct = Math.min(remaining, Number(b[QTY]))
          if (deduct <= 0) continue
          const [updated] = await trx(T)
            .where({ id: b.id })
            .andWhere(QTY, '>=', deduct)
            .update({ [QTY]: trx.raw(`?? - ?`, [QTY, deduct]) })
            .returning('*')
          if (updated) remaining -= deduct
          // If `updated` is falsy, a concurrent request took this batch's
          // stock between our SELECT above and this UPDATE — move on to
          // the next candidate batch rather than oversell it.
        }
      }
    }

    // One bulk insert for every sale_items row instead of one per item.
    await trx('sale_items').insert(
      saleItems.map(it => {
        const { _batchIdToUse, ...clean } = it
        return { sale_id: sale.id, ...clean, batch_id: _batchIdToUse || null }
      }),
    )

    // ── Accounting Integration ─────────────────────────────────────────────────
    // Every sale is posted through AccountingIntegration → VoucherService → PostingEngine.
    // All within the same transaction — if posting fails, the entire sale rolls back.
    // If COA is not yet configured (missing account_defaults), warns and saves without journal.
    let accountingResult = null
    try {
      accountingResult = await AccountingIntegration.postSale({
        sale,
        items: saleItems,
        trx,
        companyId: req.companyId,
        userId:    req.user.id,
        ipAddress: req.ip,
      })
    } catch (acctErr) {
      if (acctErr.status === 422) {
        // COA not configured yet — backward-compatible: save sale, skip journal
        console.warn(`[ACCOUNTING] COA not configured — sale saved without journal. ${acctErr.message}`)
        accountingResult = { voucher: null, journal_entry: null, accountingError: acctErr.message }
      } else {
        await trx.rollback()
        // Everything that lands here (period lock, unbalanced voucher,
        // inactive/group account, etc.) is a structural/config problem,
        // not a transient one — retrying the identical payload will fail
        // identically every time. `retryable: false` lets the offline
        // sync queue (offline/syncEngine.ts) stop backing off and instead
        // surface this to a person immediately, rather than looping
        // silently forever. `code` gives the UI something machine-
        // readable to key a specific message off of.
        return res.status(acctErr.status || 400).json({
          success: false,
          message: acctErr.message,
          code: acctErr.code || undefined,
          retryable: false,
        })
      }
    }

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CREATE', 'sales', sale.id, { invoice_no, net_total }, req.ip)
    // Event-based credit-risk recalculation (requirement #2) — fire-and-forget,
    // never blocks the response or fails the sale if scoring errors out.
    if (sale.payment_mode === 'credit' && sale.party_id) {
      require('../services/creditRiskRecalc').recalcCustomerAsync(req.companyId, sale.party_id, { trigger: 'credit_sale_created', userId: req.user.id })
    }
    return successResponse(res, {
      ...sale,
      items: saleItems,
      accounting: accountingResult?.journal_entry
        ? { voucher_no: accountingResult.voucher?.voucher_no, journal_entry_id: accountingResult.journal_entry?.id }
        : { status: 'pending_coa', note: accountingResult?.accountingError || 'Chart of Accounts not configured' },
    }, 'Invoice created', 201)
  } catch (err) {
    await trx.rollback()
    // Race between two retries of the exact same offline transaction: both
    // passed the idempotency pre-check above before either committed, and
    // the loser hit migration 025's partial unique index at insert time
    // instead. That's still "already recorded" from the client's point of
    // view — return the winner's result instead of a generic duplicate-
    // value error.
    if (err.code === '23505' && err.constraint === 'sales_company_client_txn_id_unique' && req.body.client_txn_id) {
      const existingSale = await db('sales').where({ company_id: req.companyId, client_txn_id: req.body.client_txn_id }).first()
      if (existingSale) {
        const existingItems = await db('sale_items').where({ sale_id: existingSale.id })
        return successResponse(res, { ...existingSale, items: existingItems }, 'Invoice already recorded (idempotent replay)', 200)
      }
    }
    next(err)
  }
})
router.put('/:id/cancel', requireSensitiveConfirm('invoiceCancel'), async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const sale = await trx('sales').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!sale)                       { await trx.rollback(); return res.status(404).json({ success: false, message: 'Sale not found' }) }
    if (sale.status === 'cancelled') { await trx.rollback(); return res.status(400).json({ success: false, message: 'Already cancelled' }) }

    // Reverse stock into the exact batch each item was deducted from —
    // never a different lot of the same product. Items posted after
    // migration 016 carry batch_id (the precise lot); older rows fall back
    // to matching by batch_no, and only as a last resort to "most recent
    // batch for this product" for legacy rows with no batch info at all.
    const items = await trx('sale_items').where({ sale_id: sale.id })
    for (const item of items) {
      if (item.product_id && item.qty > 0) {
        let batch = null
        if (item.batch_id) {
          batch = await trx(T).where({ id: item.batch_id, company_id: req.companyId }).first()
        }
        if (!batch && item.batch_no) {
          batch = await trx(T)
            .where({ product_id: item.product_id, company_id: req.companyId, batch_no: item.batch_no })
            .orderBy('created_at', 'asc').first()
        }
        if (!batch) {
          batch = await trx(T)
            .where({ product_id: item.product_id, company_id: req.companyId })
            .orderBy('created_at', 'desc').first()
        }
        if (batch) {
          await trx(T).where({ id: batch.id }).update({
            [QTY]: Number(batch[QTY]) + Number(item.qty),
          })
        }
      }
    }

    const [updated] = await trx('sales').where({ id: req.params.id }).update({ status: 'cancelled', updated_at: new Date() }).returning('*')
    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CANCEL', 'sales', req.params.id, { reason: req.body.reason }, req.ip)
    if (sale.payment_mode === 'credit' && sale.party_id) {
      require('../services/creditRiskRecalc').recalcCustomerAsync(req.companyId, sale.party_id, { trigger: 'credit_sale_cancelled', userId: req.user.id })
    }
    return successResponse(res, updated, 'Invoice cancelled')
  } catch (err) { await trx.rollback(); next(err) }
})

/* ── PUT /sales/:id/payment-mode ───────────────────────────────────────────
 * UI-only addition to support editing Payment Mode from the Sales List
 * after a sale has been saved. Deliberately minimal and isolated:
 *   - Updates the `payment_mode` column and recomputes `paid_amount` /
 *     `due_amount` using the SAME cash-vs-credit rule applied at sale
 *     creation (see POST / above: `credit` → paid 0, due = net_total;
 *     anything else → paid = net_total, due 0). This only reclassifies
 *     how much of the sale is "paid" vs "due" on the sale record itself.
 *   - No transaction needed — nothing else on this table is touched, and
 *     round_off/subtotal/net_total are left exactly as they were.
 *   - Deliberately does NOT touch inventory_batches, re-run
 *     AccountingIntegration/PostingEngine, or rebuild/reverse vouchers —
 *     cash/receivable ledger entries are intentionally left as-is for now.
 *   - Same `authenticate` + company scoping as every other route on this
 *     router — no new permission model introduced.
 *   - Restricted to 'active' sales, matching the existing rule that only
 *     active invoices can be modified (see /:id/cancel above).
 */
const VALID_PAYMENT_MODES = ['cash', 'credit', 'bank', 'cheque', 'upi', 'card', 'online']

router.put('/:id/payment-mode', requireSensitiveConfirm('paymentModeEdit'), async (req, res, next) => {
  try {
    const { payment_mode } = req.body
    if (!VALID_PAYMENT_MODES.includes(payment_mode)) {
      return res.status(400).json({ success: false, message: `Invalid payment mode: ${payment_mode}` })
    }

    const sale = await db('sales').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' })
    if (sale.status !== 'active') {
      return res.status(400).json({ success: false, message: `Cannot change payment mode on a ${sale.status} invoice.` })
    }

    // No-op guard — nothing to update or audit if the value is unchanged.
    if (sale.payment_mode === payment_mode) {
      return successResponse(res, sale, 'Payment mode unchanged')
    }

    // Same rule as sale creation: `credit` means nothing has been collected
    // yet, anything else means the full net_total was collected. Recomputed
    // from net_total (not paid_amount) so this stays correct no matter which
    // mode the sale is moving from or to.
    const net_total   = Number(sale.net_total)
    const paid_amount = payment_mode === 'credit' ? 0 : net_total
    const due_amount  = net_total - paid_amount

    const [updated] = await db('sales')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ payment_mode, paid_amount, due_amount, updated_at: new Date() })
      .returning('*')

    auditLog(
      req.companyId, req.user.id, 'UPDATE', 'sales', req.params.id,
      {
        field: 'payment_mode', from: sale.payment_mode, to: payment_mode,
        paid_amount: { from: sale.paid_amount, to: paid_amount },
        due_amount:  { from: sale.due_amount,  to: due_amount },
      }, req.ip,
    )
    return successResponse(res, updated, 'Payment mode updated')
  } catch (err) { next(err) }
})

/* ── PUT /sales/:id/date ────────────────────────────────────────────────────
 * Sales List inline edit — lets an already-saved invoice's date be
 * corrected (e.g. a cashier picked the wrong day) without touching
 * anything else on the sale.
 *
 *   - Updates ONLY `date_ad` (+ its derived `date_bs`). Totals, items,
 *     stock, payment_mode, vouchers/accounting postings are all left
 *     exactly as they were — same "isolated column edit" shape as
 *     PUT /:id/payment-mode above.
 *   - Restricted to 'active' sales, same rule as payment-mode edit and
 *     cancel.
 *   - Gated by requireSensitiveConfirm('saleDateEdit') — opt-in per
 *     company, off by default, same mechanism as paymentModeEdit.
 *   - Sequence-preserving: POST /sales only ever checked the new date
 *     against the single latest invoice, which — applied invoice by
 *     invoice at creation time — keeps date_ad non-decreasing in
 *     creation order across the whole company. An edit must not break
 *     that invariant for invoices created before/after this one, so the
 *     new date is bounded by the immediate neighbors (by created_at,
 *     which is what creation order actually means — invoice_no is
 *     derived from it) rather than only checked against the global max.
 *     A sale with no earlier/later active neighbor simply has no bound
 *     on that side.
 */
router.put('/:id/date', requireSensitiveConfirm('saleDateEdit'), async (req, res, next) => {
  try {
    const { date_ad } = req.body
    if (!date_ad || !/^\d{4}-\d{2}-\d{2}$/.test(date_ad)) {
      return res.status(400).json({ success: false, message: 'A valid date (YYYY-MM-DD) is required' })
    }

    const sale = await db('sales').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' })
    if (sale.status !== 'active') {
      return res.status(400).json({ success: false, message: `Cannot change the date on a ${sale.status} invoice.` })
    }

    const existingDate = String(sale.date_ad).slice(0, 10)
    if (existingDate === date_ad) {
      return successResponse(res, sale, 'Date unchanged')
    }

    const [prevSale, nextSale] = await Promise.all([
      db('sales')
        .where({ company_id: req.companyId, status: 'active' })
        .where('created_at', '<', sale.created_at)
        .orderBy('created_at', 'desc')
        .select('date_ad', 'invoice_no')
        .first(),
      db('sales')
        .where({ company_id: req.companyId, status: 'active' })
        .where('created_at', '>', sale.created_at)
        .orderBy('created_at', 'asc')
        .select('date_ad', 'invoice_no')
        .first(),
    ])

    if (prevSale && date_ad < String(prevSale.date_ad).slice(0, 10)) {
      return res.status(400).json({
        success: false,
        message: `Date cannot be earlier than the previous invoice date.`,
        detail:  `Invoice ${prevSale.invoice_no} is dated ${String(prevSale.date_ad).slice(0, 10)}. This entry must be on or after that date.`,
        last_invoice_date: prevSale.date_ad,
        last_invoice_no:   prevSale.invoice_no,
      })
    }
    if (nextSale && date_ad > String(nextSale.date_ad).slice(0, 10)) {
      return res.status(400).json({
        success: false,
        message: `Date cannot be later than the next invoice date.`,
        detail:  `Invoice ${nextSale.invoice_no} is dated ${String(nextSale.date_ad).slice(0, 10)}. This entry must be on or before that date.`,
        next_invoice_date: nextSale.date_ad,
        next_invoice_no:   nextSale.invoice_no,
      })
    }

    const date_bs = adToBS(date_ad) || sale.date_bs

    // ── Propagate to the accounting ledger ──────────────────────────────────
    // BUG (this is what was reported): this route used to update ONLY
    // sales.date_ad/date_bs. The invoice's printed/displayed date changed,
    // but the posted voucher's journal_entries.entry_date — the field every
    // ledger/revenue report actually filters and sorts on (see
    // reportingEngine.js) — never moved. The sale would show up under its
    // new date on the invoice, but the sales revenue ledger kept it under
    // the old date forever: the two records silently disagreed.
    //
    // journal_entries is append-only (no UPDATE/DELETE — see
    // voucherEditService.js's docblock), so the correct fix is NOT to
    // update entry_date directly. VoucherEditService.edit() already
    // implements the accounting-correct pattern for this exact situation —
    // reverse the voucher's current journal entry and repost an identical
    // one under the corrected date, in place, same voucher_id/voucher_no —
    // so reuse it here instead of writing a second, divergent code path.
    // If posting fails for any reason (e.g. the target period is locked),
    // this throws BEFORE the sales row is touched, so the invoice date and
    // the ledger can never end up disagreeing.
    if (sale.voucher_id) {
      const currentLines = await db('voucher_lines')
        .where({ voucher_id: sale.voucher_id })
        .orderBy('line_no')
        .select('account_id', 'party_id', 'description', 'debit', 'credit', 'tax_rate', 'tax_amount')

      try {
        await VoucherEditService.edit({
          voucherId:   sale.voucher_id,
          companyId:   req.companyId,
          userId:      req.user.id,
          reason:      `Invoice ${sale.invoice_no} date changed from ${existingDate} to ${date_ad}`,
          voucherDate: date_ad,
          lines:       currentLines,
        }, req.ip)
      } catch (editErr) {
        return res.status(editErr.status || 400).json({
          success: false,
          message: `Could not update the ledger for this date change: ${editErr.message}`,
        })
      }
    }

    const [updated] = await db('sales')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ date_ad, date_bs, updated_at: new Date() })
      .returning('*')

    auditLog(
      req.companyId, req.user.id, 'UPDATE', 'sales', req.params.id,
      { field: 'date_ad', from: existingDate, to: date_ad },
      req.ip,
    )
    return successResponse(res, updated, 'Invoice date updated')
  } catch (err) { next(err) }
})

module.exports = router
