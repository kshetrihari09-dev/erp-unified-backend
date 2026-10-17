/**
 * stockRegisterService.js — builds the per-product Stock Register.
 *
 * SOURCE OF TRUTH (read-only, no copies of data that already exists):
 *   PU  purchase_items  (+ purchases, status <> cancelled)  in = qty, free = bonus
 *   SL  sale_items      (+ sales,     status <> cancelled)  out = qty
 *   RV  receive_items   (+ receives)                        in = qty, free = bonus (if column exists)
 *   SRN / PRN / ADJ     stock_register_entries              returns & adjustments (see migration 041)
 *
 * STOCK RULES (identical to what the routes do to inventory_batches):
 *   purchase / receive : stock += qty + bonus      (purchases.js: qty_received = qty + bonus)
 *   sale               : stock -= qty              (sales.js deducts qty only; bonus is shown in
 *                                                   the Free column but never leaves inventory)
 *   sales return       : stock += qty
 *   purchase return    : stock -= qty
 *   adjustment/opening : stock += qty
 *   cancelled invoices are excluded (cancelling restores stock, so net effect is nil).
 *
 * Opening balance = net effect of every movement dated BEFORE `from`.
 * Running balance is computed here, never stored.
 */
const db = require('../db/knex')

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const STORES = [{ id: 'main', name: 'Main Store' }]   // single stock pool per company (no store table exists)

let _receiveBonus   // cached: does receive_items.bonus exist?
async function receiveHasBonus() {
  if (_receiveBonus === undefined) {
    try { _receiveBonus = await db.schema.hasColumn('receive_items', 'bonus') } catch { _receiveBonus = false }
  }
  return _receiveBonus
}

function validate({ productId, from, to }) {
  const err = (m) => Object.assign(new Error(m), { status: 400 })
  if (!productId) throw err('product_id is required')
  if (from && !DATE_RE.test(from)) throw err('from must be YYYY-MM-DD')
  if (to   && !DATE_RE.test(to))   throw err('to must be YYYY-MM-DD')
  if (from && to && from > to)     throw err('From date cannot be after To date')
}

/**
 * The single definition of "what moved stock". Used by the per-product
 * register (one product, :pid) AND the Stock & Sales Summary
 * (stockSummaryService.js, every product of the company).
 *
 * Extra columns beyond the register's own (product_id, line_value,
 * line_gross, line_disc, party_id) exist for the summary's value figures:
 *   line_value  money value of the line as the document recorded it
 *               (purchase_items.amount / sale_items.amount; for receipts and
 *               register entries qty × rate)
 *   line_gross  qty × rate before any discount
 *   line_disc   discount given on the line (sales only)
 *
 * @param {boolean} includeAdj  include ADJ (opening stock / adjustment) lines
 * @param {{allProducts?: boolean}} [opts]  allProducts → no `:pid` predicate
 */
async function movementsSQL(includeAdj, opts = {}) {
  const pf = (alias) => (opts.allProducts ? '' : `AND ${alias}.product_id = :pid`)
  const rvBonus = (await receiveHasBonus()) ? 'COALESCE(ri.bonus,0)' : '0'
  return `
    SELECT 'PU'::text AS ty, pi.product_id AS product_id, p.date_ad AS dt, p.bill_no::text AS inv_no, pi.batch_no::text AS batch,
           COALESCE(pt.name, 'Purchase')::text AS particular, p.notes::text AS narration,
           pi.qty::numeric AS qty_in, 0::numeric AS qty_out, COALESCE(pi.bonus,0)::numeric AS qty_free, 1 AS free_effect,
           pi.rate::numeric AS rate, COALESCE(pr.mrp,0)::numeric AS mrp,
           pi.expiry::text AS expiry, pi.expiry_date AS expiry_date, 'Main Store'::text AS store,
           p.created_at AS ts, pi.id::text AS rid,
           COALESCE(pi.amount,0)::numeric AS line_value, (pi.qty * pi.rate)::numeric AS line_gross, 0::numeric AS line_disc
      FROM purchase_items pi
      JOIN purchases p        ON p.id = pi.purchase_id
      LEFT JOIN parties pt    ON pt.id = p.party_id
      LEFT JOIN products pr   ON pr.id = pi.product_id
     WHERE p.company_id = :cid ${pf('pi')} AND p.status <> 'cancelled'
    UNION ALL
    SELECT 'SL', si.product_id, s.date_ad, s.invoice_no::text, si.batch_no::text,
           COALESCE(pt.name, 'Cash Sale')::text, s.notes::text,
           0::numeric, si.qty::numeric, COALESCE(si.bonus,0)::numeric, 0,
           si.rate::numeric, COALESCE(pr.mrp,0)::numeric,
           si.expiry::text, si.expiry_date, 'Main Store'::text,
           s.created_at, si.id::text,
           COALESCE(si.amount,0)::numeric, (si.qty * si.rate)::numeric,
           (si.qty * si.rate * COALESCE(si.discount_pct,0) / 100)::numeric
      FROM sale_items si
      JOIN sales s            ON s.id = si.sale_id
      LEFT JOIN parties pt    ON pt.id = s.party_id
      LEFT JOIN products pr   ON pr.id = si.product_id
     WHERE s.company_id = :cid ${pf('si')} AND s.status <> 'cancelled'
    UNION ALL
    SELECT 'RV', ri.product_id, r.date_ad, r.receive_no::text, ri.batch_no::text,
           'Stock Receipt'::text, r.notes::text,
           ri.qty::numeric, 0::numeric, ${rvBonus}::numeric, 1,
           COALESCE(ri.rate,0)::numeric, COALESCE(pr.mrp,0)::numeric,
           ri.expiry::text, ri.expiry_date, 'Main Store'::text,
           r.created_at, ri.id::text,
           (ri.qty * COALESCE(ri.rate,0))::numeric, (ri.qty * COALESCE(ri.rate,0))::numeric, 0::numeric
      FROM receive_items ri
      JOIN receives r         ON r.id = ri.receive_id
      LEFT JOIN products pr   ON pr.id = ri.product_id
     WHERE r.company_id = :cid ${pf('ri')}
    UNION ALL
    SELECT e.entry_type, e.product_id, e.entry_date, e.ref_no::text, e.batch_no::text,
           COALESCE(e.particular, e.entry_type)::text, e.narration::text,
           e.qty_in, e.qty_out, e.qty_free, 1,
           e.rate, e.mrp, e.expiry::text, e.expiry_date, e.store_name::text,
           e.created_at, e.id::text,
           ((e.qty_in + e.qty_out) * e.rate)::numeric, ((e.qty_in + e.qty_out) * e.rate)::numeric, 0::numeric
      FROM stock_register_entries e
     WHERE e.company_id = :cid ${pf('e')}
       ${includeAdj ? '' : "AND e.entry_type <> 'ADJ'"}`
}

/** Pure: apply running balance + totals to already-sorted rows. Exported for tests. */
function buildRegister(opening, rows) {
  let bal = round4(opening)
  const out = []
  const totals = { qty_in: 0, qty_out: 0, qty_free: 0 }
  for (const r of rows) {
    const qin = Number(r.qty_in) || 0, qout = Number(r.qty_out) || 0, free = Number(r.qty_free) || 0
    const fx  = Number(r.free_effect) || 0
    bal = round4(bal + qin - qout + free * fx)
    totals.qty_in   += qin
    totals.qty_out  += qout
    totals.qty_free += free
    out.push({ ...r, qty_in: qin, qty_out: qout, qty_free: free, balance: bal })
  }
  return {
    rows: out,
    totals: { qty_in: round4(totals.qty_in), qty_out: round4(totals.qty_out), qty_free: round4(totals.qty_free) },
    closing: bal,
  }
}

function fmtExpiry(r) {
  if (r.expiry) return r.expiry
  if (!r.expiry_date) return ''
  const d = new Date(r.expiry_date)
  return isNaN(d) ? '' : `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(-2)}`
}
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))

/**
 * Optional batch / expiry restriction shared by the register and the summary.
 * Returns an SQL fragment (starting with AND) over the movement CTE columns
 * plus its bind values. Lines with no expiry never match an expiry filter.
 */
function batchExpiryFilter({ batch, expiryFrom, expiryTo } = {}) {
  let sql = ''
  const bind = {}
  if (batch)      { sql += ` AND batch ILIKE :f_batch`; bind.f_batch = `%${String(batch).replace(/[%_\\]/g, m => '\\' + m)}%` }
  if (expiryFrom) { sql += ` AND expiry_date >= CAST(:f_exp_from AS date)`; bind.f_exp_from = expiryFrom }
  if (expiryTo)   { sql += ` AND expiry_date <= CAST(:f_exp_to AS date)`;   bind.f_exp_to   = expiryTo }
  return { sql, bind }
}

async function getRegister(companyId, { productId, from, to, store, includeAdj = true, batch, expiryFrom, expiryTo }) {
  validate({ productId, from, to })
  for (const [k, v] of [['expiry_from', expiryFrom], ['expiry_to', expiryTo]]) {
    if (v && !DATE_RE.test(v)) throw Object.assign(new Error(`${k} must be YYYY-MM-DD`), { status: 400 })
  }
  if (store && String(store).toLowerCase() !== 'all' && !STORES.some(s => s.id === String(store).toLowerCase() || s.name === store)) {
    // Unknown store → nothing can match (only one store exists).
    store = '__none__'
  }

  const product = await db('products').where({ id: productId, company_id: companyId })
    .select('id', 'item_code', 'name', 'unit', 'company_name', 'mrp').first()
  if (!product) throw Object.assign(new Error('Product not found'), { status: 404 })

  const mv   = await movementsSQL(includeAdj)
  const be   = batchExpiryFilter({ batch, expiryFrom, expiryTo })
  const bind = { cid: companyId, pid: productId, from: from || null, to: to || null, ...be.bind }
  const storeFilter = (store === '__none__' ? 'AND false' : '') + be.sql

  const openingRes = from ? await db.raw(`
      WITH mv AS (${mv})
      SELECT COALESCE(SUM(qty_in - qty_out + qty_free * free_effect), 0) AS opening
        FROM mv WHERE dt < CAST(:from AS date) ${storeFilter}`, bind) : null
  const opening = round4(openingRes ? (openingRes.rows?.[0] ?? openingRes[0])?.opening : 0)

  const rowsRes = await db.raw(`
      WITH mv AS (${mv})
      SELECT * FROM mv
       WHERE (CAST(:from AS date) IS NULL OR dt >= CAST(:from AS date))
         AND (CAST(:to AS date)   IS NULL OR dt <= CAST(:to AS date)) ${storeFilter}
       ORDER BY dt ASC, ts ASC, rid ASC`, bind)
  const raw = rowsRes.rows ?? rowsRes

  const built = buildRegister(opening, raw)
  const rows = built.rows.map(r => ({
    date: isoDate(r.dt), inv_no: r.inv_no || '', batch: r.batch || '', particular: r.particular || '',
    narration: r.narration || '', ty: r.ty, qty_in: r.qty_in, qty_out: r.qty_out, balance: r.balance,
    qty_free: r.qty_free, free_effect: Number(r.free_effect) || 0, rate: Number(r.rate) || 0, store: r.store || 'Main Store',
    mrp: Number(r.mrp) || 0, expiry: fmtExpiry(r), key: `${r.ty}:${r.rid}`,
  }))

  // Reconciliation against the live batch table (informational).
  const cur = await db('inventory_batches').where({ company_id: companyId, product_id: productId })
    .sum('qty_remaining as q').first()
  const currentStock = round4(cur?.q)
  let closingAllTime = built.closing
  if (to) {   // closing of the full history (not just up to `to`) for comparison with live stock
    const allRes = await db.raw(`WITH mv AS (${mv}) SELECT COALESCE(SUM(qty_in - qty_out + qty_free * free_effect),0) AS t FROM mv`, bind)
    closingAllTime = round4((allRes.rows?.[0] ?? allRes[0])?.t)
  }

  return {
    product: { id: product.id, item_code: product.item_code, name: product.name, unit: product.unit },
    filters: { from: from || null, to: to || null, store: store && store !== '__none__' ? store : 'all', include_adj: !!includeAdj },
    opening_balance: opening,
    rows,
    totals: { ...built.totals, opening_balance: opening, closing_balance: built.closing },
    reconciliation: { register_closing_all_time: closingAllTime, current_stock: currentStock, matches: Math.abs(closingAllTime - currentStock) < 0.0001 },
  }
}

/** CSV with the same figures as the screen. */
function toCSV(rep) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const L = []
  L.push(['Stock Register'].map(q).join(','))
  L.push(['Product Code', rep.product.item_code, 'Product Name', rep.product.name].map(q).join(','))
  L.push(['From', rep.filters.from || 'Beginning', 'To', rep.filters.to || 'Latest', 'Store', rep.filters.store === 'all' ? 'All Stores' : rep.filters.store].map(q).join(','))
  L.push('')
  L.push(['Date','Inv No.','Batch','Particular','Narration','Ty','In','Out','Bal','Free','Rate','Store','MRP','Expiry'].join(','))
  L.push(['', '', '', 'Opening Balance', '', '', '', '', rep.opening_balance].map(q).join(','))
  for (const r of rep.rows) {
    L.push([r.date, r.inv_no, r.batch, r.particular, r.narration, r.ty, r.qty_in, r.qty_out, r.balance, r.qty_free, r.rate, r.store, r.mrp, r.expiry].map(q).join(','))
  }
  L.push(['', '', '', 'Total', '', '', rep.totals.qty_in, rep.totals.qty_out, rep.totals.closing_balance, rep.totals.qty_free].map(q).join(','))
  return '\uFEFF' + L.join('\r\n') + '\r\n'
}

let _partyCols
async function hasPartyCols() {   // migration 042 may not be applied yet
  if (_partyCols === undefined) {
    try { _partyCols = await db.schema.hasColumn('stock_register_entries', 'party_id') } catch { _partyCols = false }
  }
  return _partyCols
}

let _hasEntries
/**
 * Append one stock line to stock_register_entries INSIDE the caller's transaction.
 * Idempotent via UNIQUE(company_id, source_key). Silently skips if migration 041
 * has not been applied yet, so returns/adjustments keep working either way.
 */
async function recordEntry(trx, e) {
  if (_hasEntries === undefined) {
    try { _hasEntries = await db.schema.hasTable('stock_register_entries') } catch { _hasEntries = false }
  }
  if (!_hasEntries) return
  await trx('stock_register_entries').insert({
    company_id: e.companyId, product_id: e.productId, batch_id: e.batchId || null,
    ...(await hasPartyCols() ? { party_id: e.partyId || null } : {}),
    entry_type: e.type, entry_date: e.date, ref_no: e.refNo || null,
    particular: e.particular || null, narration: e.narration || null,
    batch_no: e.batchNo || null, expiry: e.expiry || null, expiry_date: e.expiryDate || null,
    qty_in: e.qtyIn || 0, qty_out: e.qtyOut || 0, qty_free: e.qtyFree || 0,
    rate: e.rate || 0, mrp: e.mrp || 0, source_key: e.sourceKey,
  }).onConflict(['company_id', 'source_key']).ignore()
}

/** After the accounting voucher exists, link the return's register lines to it. */
async function linkEntriesToVoucher(trx, companyId, keyPrefix, voucherId) {
  if (!voucherId || !(await hasPartyCols())) return
  await trx('stock_register_entries').where({ company_id: companyId })
    .where('source_key', 'like', `${keyPrefix}%`).update({ voucher_id: voucherId })
}

module.exports = { getRegister, buildRegister, toCSV, recordEntry, linkEntriesToVoucher, STORES, movementsSQL, batchExpiryFilter }
