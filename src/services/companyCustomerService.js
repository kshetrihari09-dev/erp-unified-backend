/**
 * companyCustomerService.js — "Company vs Customer" report.
 *
 * For one date range and (optionally) one manufacturer ("company" =
 * products.company_name), shows per customer:
 *
 *   Sales        = Σ (line amount + line discount)            gross, BEFORE discount
 *   Discount     = Σ round(qty × rate × discount_pct / 100)   what sale_items actually granted
 *   Sales Return = returns of goods that were NOT expired when returned
 *   SR Expiry    = returns of goods already expired on the return date
 *   Net          = Sales − Discount − Sales Return − SR Expiry
 *
 * WHY "gross": sale_items.amount is stored NET of the item discount
 * (sales.js: amount = qty×rate×(1−disc%) + cc_amount). Adding the discount back
 * gives gross Sales; Sales − Discount therefore equals Σ sale_items.amount and
 * the discount is deducted exactly once. Invoice-level round_off is excluded.
 *
 * RETURNS carry no discount in this app (credit note = qty × entered rate), so
 * they are deducted as recorded. Sources, never double counted:
 *   1. stock_register_entries type SRN (full detail: customer, product, expiry)
 *   2. legacy CREDIT_NOTE vouchers (metadata.items) that have NO linked entry
 *
 * Each source is aggregated per customer in its own query, then merged — joins
 * between invoices, items and returns can never multiply rows.
 */
const db = require('../db/knex')

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validate({ from, to, customerType }) {
  const err = (m) => Object.assign(new Error(m), { status: 400 })
  if (!from || !DATE_RE.test(from)) throw err('From date is required (YYYY-MM-DD)')
  if (!to   || !DATE_RE.test(to))   throw err('To date is required (YYYY-MM-DD)')
  if (from > to) throw err('From date cannot be after To date')
  if (customerType && !['all', 'customer', 'credit'].includes(customerType)) throw err('Invalid customer type')
}

/** Pure: merge per-customer aggregates into report rows + grand totals. Exported for tests. */
function buildRows({ sales, returns, parties }) {
  const keys = new Set([...sales.keys(), ...returns.keys()])
  const rows = []
  for (const k of keys) {
    const s = sales.get(k) || { sales: 0, discount: 0 }
    const r = returns.get(k) || { sr: 0, sre: 0 }
    const p = parties.get(k)
    if (k !== '_walkin' && !p) continue                       // filtered out by customer type
    const sales_ = r2(s.sales), disc = r2(s.discount), sr = r2(r.sr), sre = r2(r.sre)
    const net = r2(sales_ - disc - sr - sre)
    if (!sales_ && !disc && !sr && !sre) continue
    rows.push({
      customer_id: k === '_walkin' ? null : k,
      customer_code: p?.code || '',
      customer_name: p?.name || 'Cash / Walk-in Customer',
      customer_type: p ? (Number(p.credit_limit) > 0 ? 'credit' : 'customer') : 'customer',
      sales: sales_, discount: disc, sales_return: sr, sales_return_expiry: sre, net,
    })
  }
  rows.sort((a, b) => (a.customer_name || '').localeCompare(b.customer_name || ''))
  const t = rows.reduce((a, r) => ({
    sales: a.sales + r.sales, discount: a.discount + r.discount, sales_return: a.sales_return + r.sales_return,
    sales_return_expiry: a.sales_return_expiry + r.sales_return_expiry, net: a.net + r.net,
  }), { sales: 0, discount: 0, sales_return: 0, sales_return_expiry: 0, net: 0 })
  for (const k of Object.keys(t)) t[k] = r2(t[k])
  return { rows, totals: t }
}

async function listCompanies(companyId) {
  const r = await db('products').where({ company_id: companyId, is_active: true }).whereNotNull('company_name')
    .whereRaw("TRIM(company_name) <> ''").distinct('company_name').orderBy('company_name')
  return r.map(x => x.company_name)
}

async function getReport(companyId, { from, to, company, customerType = 'all' }) {
  validate({ from, to, customerType })
  const co  = company && company !== 'all' ? String(company) : null
  const bind = { cid: companyId, from, to, co }
  const rowsOf = (r) => r.rows ?? r

  // ── customers (type filter is a property of the customer) ────────────────
  let pq = db('parties').where({ company_id: companyId, type: 'customer' }).select('id', 'code', 'name', 'credit_limit')
  if (customerType === 'credit')   pq = pq.where('credit_limit', '>', 0)
  if (customerType === 'customer') pq = pq.where(b => b.whereNull('credit_limit').orWhere('credit_limit', '<=', 0))
  const parties = new Map((await pq).map(p => [p.id, p]))
  const walkIn = customerType !== 'credit'                    // no party = cash sale, treated as plain Customer

  // ── 1. sales + discount per customer ──────────────────────────────────────
  const salesRes = await db.raw(`
    SELECT s.party_id,
           SUM(si.amount + CASE WHEN COALESCE(si.discount_pct,0) > 0
                                THEN ROUND(si.qty * si.rate * si.discount_pct / 100, 2) ELSE 0 END) AS sales,
           SUM(CASE WHEN COALESCE(si.discount_pct,0) > 0
                    THEN ROUND(si.qty * si.rate * si.discount_pct / 100, 2) ELSE 0 END)           AS discount
      FROM sale_items si
      JOIN sales s          ON s.id = si.sale_id
      LEFT JOIN products pr ON pr.id = si.product_id
     WHERE s.company_id = :cid AND s.status <> 'cancelled'
       AND s.date_ad BETWEEN CAST(:from AS date) AND CAST(:to AS date)
       AND (CAST(:co AS text) IS NULL OR pr.company_name = CAST(:co AS text))
     GROUP BY s.party_id`, bind)
  const sales = new Map()
  for (const r of rowsOf(salesRes)) {
    const k = r.party_id || '_walkin'
    if (k === '_walkin' && !walkIn) continue
    sales.set(k, { sales: Number(r.sales) || 0, discount: Number(r.discount) || 0 })
  }

  // ── 2. returns per customer (entries + legacy vouchers) ──────────────────
  const hasParty = await db.schema.hasColumn('stock_register_entries', 'party_id').catch(() => false)
  const returns = new Map()
  const addRet = (rows) => { for (const r of rows) {
    const k = r.party_id || '_walkin'
    if (k === '_walkin' && !walkIn) continue
    const cur = returns.get(k) || { sr: 0, sre: 0 }
    cur.sr += Number(r.sr) || 0; cur.sre += Number(r.sre) || 0
    returns.set(k, cur)
  } }
  if (hasParty) {
    addRet(rowsOf(await db.raw(`
      SELECT e.party_id,
             SUM(CASE WHEN e.expiry_date IS NULL OR e.expiry_date >  e.entry_date THEN e.qty_in * e.rate ELSE 0 END) AS sr,
             SUM(CASE WHEN e.expiry_date IS NOT NULL AND e.expiry_date <= e.entry_date THEN e.qty_in * e.rate ELSE 0 END) AS sre
        FROM stock_register_entries e
        LEFT JOIN products pr ON pr.id = e.product_id
       WHERE e.company_id = :cid AND e.entry_type = 'SRN'
         AND e.entry_date BETWEEN CAST(:from AS date) AND CAST(:to AS date)
         AND (CAST(:co AS text) IS NULL OR pr.company_name = CAST(:co AS text))
       GROUP BY e.party_id`, bind)))
    // legacy credit notes (made before entries existed): no linked register line
    addRet(rowsOf(await db.raw(`
      SELECT v.party_id,
             SUM((it->>'qty')::numeric * (it->>'unit_cost')::numeric) AS sr, 0::numeric AS sre
        FROM vouchers v
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.metadata->'items', '[]'::jsonb)) AS it
        LEFT JOIN products pr ON pr.id::text = it->>'product_id'
       WHERE v.company_id = :cid AND v.voucher_type = 'CREDIT_NOTE' AND v.status = 'POSTED'
         AND v.metadata->>'source_type' = 'SALE_RETURN'
         AND NOT EXISTS (SELECT 1 FROM stock_register_entries e WHERE e.voucher_id = v.id)
         AND v.voucher_date BETWEEN CAST(:from AS date) AND CAST(:to AS date)
         AND (CAST(:co AS text) IS NULL OR pr.company_name = CAST(:co AS text))
       GROUP BY v.party_id`, bind)))
  }

  const { rows, totals } = buildRows({ sales, returns, parties })
  return {
    title: 'Company vs Customer',
    filters: { from, to, company: co || 'all', customer_type: customerType },
    rows, totals,
  }
}

const TYPE_LABEL = { customer: 'Customer', credit: 'Credit Customer', all: 'All' }

function toCSV(rep) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const f = rep.filters, m = (n) => Number(n).toFixed(2)
  const L = [
    ['Company vs Customer'],
    ['From', f.from, 'To', f.to, 'Company', f.company === 'all' ? 'All Companies' : f.company,
     'Customer Type', TYPE_LABEL[f.customer_type]],
    [],
    ['Customer Code', 'Particular', 'Sales', 'Discount', 'Sales Return', 'Sales Return Expiry', 'Net'],
    ...rep.rows.map(r => [r.customer_code, r.customer_name, m(r.sales), m(r.discount), m(r.sales_return), m(r.sales_return_expiry), m(r.net)]),
    ['', 'Total', m(rep.totals.sales), m(rep.totals.discount), m(rep.totals.sales_return), m(rep.totals.sales_return_expiry), m(rep.totals.net)],
  ]
  return '\uFEFF' + L.map(r => r.map(q).join(',')).join('\r\n') + '\r\n'
}

module.exports = { getReport, listCompanies, buildRows, toCSV }
