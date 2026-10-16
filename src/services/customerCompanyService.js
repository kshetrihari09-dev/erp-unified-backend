/**
 * customerCompanyService.js — "Customer vs Company" report.
 *
 * The counterpart of Company vs Customer: pick ONE customer and see, for the
 * selected date range, how much they bought from / returned to each company
 * (manufacturer = products.company_name).
 *
 * Per company (row) the maths is exactly the Company vs Customer maths:
 *   Sales        = Σ (line amount + line discount)           gross, before discount
 *   Discount     = Σ round(qty × rate × discount_pct / 100)
 *   Sales Return = returns of goods not yet expired on the return date
 *   SR Expiry    = returns of goods already expired on the return date
 *   Net          = Sales − Discount − Sales Return − SR Expiry
 * (see companyCustomerService.js for why Sales is gross and why returns carry no discount)
 *
 * The customer's ledger position for the same period (opening / receipts / closing) comes from
 * partyBalanceService and is returned separately — it is party-level, never split by company.
 * Products without a company are grouped under "No Company".
 */
const db = require('../db/knex')
const { getBalances } = require('./partyBalanceService')

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NO_COMPANY = 'No Company'

function validate({ from, to, customerId }) {
  const err = (m, status = 400) => Object.assign(new Error(m), { status })
  if (!customerId) throw err('Select a customer')
  if (!from || !DATE_RE.test(from)) throw err('From date is required (YYYY-MM-DD)')
  if (!to   || !DATE_RE.test(to))   throw err('To date is required (YYYY-MM-DD)')
  if (from > to) throw err('From date cannot be after To date')
}

/** Pure: merge per-company aggregates into rows + totals. Exported for tests. */
function buildCompanyRows({ sales, returns }) {
  const keys = new Set([...sales.keys(), ...returns.keys()])
  const rows = []
  for (const k of keys) {
    const s = sales.get(k) || { sales: 0, discount: 0 }, r = returns.get(k) || { sr: 0, sre: 0 }
    const sl = r2(s.sales), d = r2(s.discount), sr = r2(r.sr), sre = r2(r.sre)
    if (!sl && !d && !sr && !sre) continue
    rows.push({ company: k, sales: sl, discount: d, sales_return: sr, sales_return_expiry: sre, net: r2(sl - d - sr - sre) })
  }
  rows.sort((a, b) => (a.company === NO_COMPANY) - (b.company === NO_COMPANY) || a.company.localeCompare(b.company))
  const t = rows.reduce((a, r) => ({
    sales: a.sales + r.sales, discount: a.discount + r.discount, sales_return: a.sales_return + r.sales_return,
    sales_return_expiry: a.sales_return_expiry + r.sales_return_expiry, net: a.net + r.net,
  }), { sales: 0, discount: 0, sales_return: 0, sales_return_expiry: 0, net: 0 })
  for (const k of Object.keys(t)) t[k] = r2(t[k])
  return { rows, totals: t }
}

/** Customers for the selector (code, name), searchable, newest-agnostic: ordered by name. */
async function searchCustomers(companyId, search, limit = 30) {
  const q = db('parties').where({ company_id: companyId, type: 'customer' }).select('id', 'code', 'name')
    .orderBy('name').limit(Math.min(Number(limit) || 30, 100))
  if (search && String(search).trim()) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, m => '\\' + m)}%`
    q.where(b => b.whereILike('name', like).orWhereILike('code', like))
  }
  return q
}

async function getReport(companyId, { from, to, customerId }) {
  validate({ from, to, customerId })
  const party = await db('parties').where({ id: customerId, company_id: companyId, type: 'customer' })
    .select('id', 'code', 'name', 'credit_limit').first()
  if (!party) throw Object.assign(new Error('Customer not found'), { status: 404 })
  const bind = { cid: companyId, pid: customerId, from, to, none: NO_COMPANY }
  const rowsOf = (r) => r.rows ?? r
  const CO = "COALESCE(NULLIF(TRIM(pr.company_name), ''), CAST(:none AS text))"

  const salesRes = await db.raw(`
    SELECT ${CO} AS company,
           SUM(si.amount + CASE WHEN COALESCE(si.discount_pct,0) > 0
                                THEN ROUND(si.qty * si.rate * si.discount_pct / 100, 2) ELSE 0 END) AS sales,
           SUM(CASE WHEN COALESCE(si.discount_pct,0) > 0
                    THEN ROUND(si.qty * si.rate * si.discount_pct / 100, 2) ELSE 0 END)           AS discount
      FROM sale_items si
      JOIN sales s          ON s.id = si.sale_id
      LEFT JOIN products pr ON pr.id = si.product_id
     WHERE s.company_id = :cid AND s.party_id = CAST(:pid AS uuid) AND s.status <> 'cancelled'
       AND s.date_ad BETWEEN CAST(:from AS date) AND CAST(:to AS date)
     GROUP BY 1`, bind)
  const sales = new Map(rowsOf(salesRes).map(r => [r.company, { sales: Number(r.sales) || 0, discount: Number(r.discount) || 0 }]))

  const returns = new Map()
  const addRet = (rows) => { for (const r of rows) {
    const cur = returns.get(r.company) || { sr: 0, sre: 0 }
    cur.sr += Number(r.sr) || 0; cur.sre += Number(r.sre) || 0; returns.set(r.company, cur)
  } }
  if (await db.schema.hasColumn('stock_register_entries', 'party_id').catch(() => false)) {
    addRet(rowsOf(await db.raw(`
      SELECT ${CO} AS company,
             SUM(CASE WHEN e.expiry_date IS NULL OR e.expiry_date >  e.entry_date THEN e.qty_in * e.rate ELSE 0 END) AS sr,
             SUM(CASE WHEN e.expiry_date IS NOT NULL AND e.expiry_date <= e.entry_date THEN e.qty_in * e.rate ELSE 0 END) AS sre
        FROM stock_register_entries e
        LEFT JOIN products pr ON pr.id = e.product_id
       WHERE e.company_id = :cid AND e.entry_type = 'SRN' AND e.party_id = CAST(:pid AS uuid)
         AND e.entry_date BETWEEN CAST(:from AS date) AND CAST(:to AS date)
       GROUP BY 1`, bind)))
    // legacy credit notes (made before register entries existed): no linked register line
    addRet(rowsOf(await db.raw(`
      SELECT ${CO} AS company,
             SUM((it->>'qty')::numeric * (it->>'unit_cost')::numeric) AS sr, 0::numeric AS sre
        FROM vouchers v
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.metadata->'items', '[]'::jsonb)) AS it
        LEFT JOIN products pr ON pr.id::text = it->>'product_id'
       WHERE v.company_id = :cid AND v.party_id = CAST(:pid AS uuid) AND v.voucher_type = 'CREDIT_NOTE' AND v.status = 'POSTED'
         AND v.metadata->>'source_type' = 'SALE_RETURN'
         AND NOT EXISTS (SELECT 1 FROM stock_register_entries e WHERE e.voucher_id = v.id)
         AND v.voucher_date BETWEEN CAST(:from AS date) AND CAST(:to AS date)
       GROUP BY 1`, bind)))
  }

  const { rows, totals } = buildCompanyRows({ sales, returns })
  const b = (await getBalances(companyId, { from, to, partyId: customerId })).get(customerId)
  return {
    title: 'Customer vs Company',
    customer: { id: party.id, code: party.code || '', name: party.name },
    filters: { from, to, customer_id: customerId },
    rows, totals,
    ledger: b ? { opening_balance: b.opening_balance, receipts: b.receipts, closing_balance: b.closing_balance } : { opening_balance: 0, receipts: 0, closing_balance: 0 },
  }
}

function toCSV(rep) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const m = (n) => Number(n).toFixed(2)
  const L = [
    ['Customer vs Company'],
    ['Customer Code', rep.customer.code, 'Customer', rep.customer.name, 'From', rep.filters.from, 'To', rep.filters.to],
    ['Opening Balance', m(rep.ledger.opening_balance), 'Receipts', m(rep.ledger.receipts), 'Closing Balance', m(rep.ledger.closing_balance)],
    [],
    ['Company', 'Sales', 'Discount', 'Sales Return', 'Sales Return Expiry', 'Net'],
    ...rep.rows.map(r => [r.company, m(r.sales), m(r.discount), m(r.sales_return), m(r.sales_return_expiry), m(r.net)]),
    ['Total', m(rep.totals.sales), m(rep.totals.discount), m(rep.totals.sales_return), m(rep.totals.sales_return_expiry), m(rep.totals.net)],
  ]
  return '\uFEFF' + L.map(r => r.map(q).join(',')).join('\r\n') + '\r\n'
}

module.exports = { getReport, searchCustomers, buildCompanyRows, toCSV, NO_COMPANY }
