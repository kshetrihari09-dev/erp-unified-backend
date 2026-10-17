/**
 * stock-summary.integration.test.js — runs the REAL Stock & Sales Summary SQL against Postgres.
 *
 * Needs a migrated database; skipped when TEST_DATABASE_URL is not set so the normal
 * `npm test` run is unaffected:
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/erp_test npx jest test/stock-summary.integration
 *
 * Scenario (period 2026-03-01 … 2026-03-31) for product P1, built to hit every rule:
 *   before period : ADJ +100 (opening stock), PU 50 + 5 free, SL 20            → opening 135
 *   in period     : PU 40 + 4 free on 03-01 (FROM boundary)
 *                   SL 30 + 3 free @20 with 10% discount on 03-10
 *                   SL 99  CANCELLED, PU 77 CANCELLED                          → must be ignored
 *                   SRN +5 (sales return), PRN −6 (purchase return), ADJ +2
 *                   RV +10 on 03-31 (TO boundary)
 *   after period  : SL 8 on 04-01                                              → must be ignored
 *   expected closing = 135 + 40 + 4 + 10 + 5 + 2 − 6 − 30 = 160
 */
const URL = process.env.TEST_DATABASE_URL
const d = URL ? describe : describe.skip

let knex
jest.mock('../src/db/knex', () => {
  const real = process.env.TEST_DATABASE_URL
  if (!real) return () => ({})
  const k = require('knex')({ client: 'pg', connection: { connectionString: real, ssl: false }, pool: { min: 1, max: 4 } })
  return k
})

const svc = require('../src/services/stockSummaryService')
const { getRegister } = require('../src/services/stockRegisterService')

const F = { from: '2026-03-01', to: '2026-03-31' }
const run = (extra = {}, cid) => svc.getSummary(cid || ids.cid, svc.validateFilters({ ...F, ...extra }))
const byCode = (rep, code) => rep.rows.find(r => r.item_code === code)
const ids = {}

d('Stock & Sales Summary — real SQL', () => {
  let db
  beforeAll(async () => {
    db = require('../src/db/knex')
    const [co]  = await db('companies').insert({ name: 'TEST-SUMMARY-A' }).returning('id')
    const [co2] = await db('companies').insert({ name: 'TEST-SUMMARY-B' }).returning('id')
    ids.cid = co.id; ids.cid2 = co2.id
    const cid = ids.cid

    const [s1] = await db('parties').insert({ company_id: cid, code: 'S1', name: 'Supplier One', type: 'supplier' }).returning('id')
    const [s2] = await db('parties').insert({ company_id: cid, code: 'S2', name: 'Supplier Two', type: 'supplier' }).returning('id')
    ids.s1 = s1.id; ids.s2 = s2.id

    const mkP = async (o) => (await db('products').insert({ company_id: cid, ...o }).returning('id'))[0].id
    ids.p1 = await mkP({ item_code: 'P001', name: 'Paracetamol 500', unit: 'Strip', company_name: 'Acme', category: 'Tablet', min_stock: 50, barcode: '8901230001' })
    ids.p2 = await mkP({ item_code: 'P002', name: 'Amoxicillin 250', unit: 'Cap',   company_name: 'Zeta', category: 'Capsule', min_stock: 50 })
    ids.p3 = await mkP({ item_code: 'P003', name: 'Old Inactive',    unit: 'Strip', company_name: 'Acme', category: 'Tablet', min_stock: 5, is_active: false })
    const [pb] = await db('products').insert({ company_id: ids.cid2, item_code: 'B001', name: 'Other Company Item', min_stock: 1 }).returning('id')
    ids.pb = pb.id

    const purchase = async (bill, date, status, party, items) => {
      const [p] = await db('purchases').insert({ company_id: cid, bill_no: bill, date_ad: date, status, party_id: party, net_total: 0 }).returning('id')
      for (const it of items) await db('purchase_items').insert({ purchase_id: p.id, ...it })
    }
    const sale = async (inv, date, status, items) => {
      const [s] = await db('sales').insert({ company_id: cid, invoice_no: inv, date_ad: date, status, net_total: 0 }).returning('id')
      for (const it of items) await db('sale_items').insert({ sale_id: s.id, ...it })
    }
    const entry = (type, date, p, o) => db('stock_register_entries').insert({
      company_id: cid, product_id: p, entry_type: type, entry_date: date, source_key: `${type}:${date}:${p}:${Math.random()}`, ...o })

    // ── P1 ────────────────────────────────────────────────────────────
    await entry('ADJ', '2026-01-10', ids.p1, { qty_in: 100, rate: 8, batch_no: 'B0' })
    await purchase('PB-1', '2026-02-15', 'active', s1.id, [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B1', qty: 50, bonus: 5, rate: 10, amount: 500 }])
    await sale('SI-1', '2026-02-20', 'active', [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B1', qty: 20, rate: 20, amount: 400 }])
    await purchase('PB-2', '2026-03-01', 'active', s1.id, [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B2', expiry_date: '2027-06-30', qty: 40, bonus: 4, rate: 12, amount: 480 }])
    await sale('SI-2', '2026-03-10', 'active', [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B2', expiry_date: '2027-06-30', qty: 30, bonus: 3, rate: 20, discount_pct: 10, amount: 540 }])
    await sale('SI-3', '2026-03-12', 'cancelled', [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B2', qty: 99, rate: 20, amount: 1980 }])
    await purchase('PB-3', '2026-03-15', 'cancelled', s1.id, [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B2', qty: 77, rate: 12, amount: 924 }])
    await entry('SRN', '2026-03-12', ids.p1, { qty_in: 5, rate: 20, batch_no: 'B2' })
    await entry('PRN', '2026-03-20', ids.p1, { qty_out: 6, rate: 12, batch_no: 'B2' })
    await entry('ADJ', '2026-03-25', ids.p1, { qty_in: 2, rate: 0, batch_no: 'B2' })
    const [rv] = await db('receives').insert({ company_id: cid, receive_no: 'RV-1', date_ad: '2026-03-31' }).returning('id')
    await db('receive_items').insert({ receive_id: rv.id, product_id: ids.p1, batch_no: 'B2', expiry_date: '2027-06-30', qty: 10, rate: 11 })
    await sale('SI-4', '2026-04-01', 'active', [{ product_id: ids.p1, product_name: 'P1', batch_no: 'B2', qty: 8, rate: 20, amount: 160 }])

    // ── P2: only an old purchase from supplier two (10 left → below min_stock 50) ──
    await purchase('PB-4', '2026-02-01', 'active', s2.id, [{ product_id: ids.p2, product_name: 'P2', batch_no: 'C1', qty: 10, rate: 5, amount: 50 }])

    // ── other company: must never leak ────────────────────────────────
    const [op] = await db('purchases').insert({ company_id: ids.cid2, bill_no: 'X-1', date_ad: '2026-03-05', status: 'active', net_total: 0 }).returning('id')
    await db('purchase_items').insert({ purchase_id: op.id, product_id: ids.pb, product_name: 'B', qty: 999, rate: 1, amount: 999 })
  })

  afterAll(async () => {
    if (!db) return
    for (const c of [ids.cid, ids.cid2]) if (c) await db('companies').where({ id: c }).del()
    await db.destroy()
  })

  test('P1 figures: opening, movements, closing, values', async () => {
    const r = byCode(await run(), 'P001')
    expect(r.opening).toBe(135)
    expect(r.purchased).toBe(40)
    expect(r.free_in).toBe(4)
    expect(r.received).toBe(10)
    expect(r.purchase_returns).toBe(6)
    expect(r.sold).toBe(30)
    expect(r.free_out).toBe(3)
    expect(r.sales_returns).toBe(5)
    expect(r.adjustments).toBe(2)
    expect(r.closing).toBe(160)
    // identity: closing = opening + in-movements − out-movements
    expect(r.opening + r.purchased + r.free_in + r.received + r.sales_returns + r.adjustments
           - r.purchase_returns - r.sold).toBe(r.closing)
    expect(r.rate).toBe(11)                // latest PU/RV on/before `to` = the 03-31 receipt
    expect(r.stock_value).toBe(1760)       // 160 × 11
    expect(r.sales_value).toBe(540)        // net of 10% discount
    expect(r.sales_discount).toBe(60)
    expect(r.purchase_value).toBe(480)     // PB-2 only (PB-1 before period, PB-3 cancelled)
    expect(r.sales_return_value).toBe(100)
    expect(r.status).toBe('ok')
  })

  test('cancelled documents and anything after `to` are ignored', async () => {
    const r = byCode(await run(), 'P001')
    expect(r.sold).toBe(30)                // not 30 + 99 (cancelled) + 8 (after period)
    expect(r.purchased).toBe(40)           // not + 77 (cancelled)
  })

  test('date boundaries: FROM is inclusive for the period, exclusive for opening', async () => {
    const r = byCode(await run({ from: '2026-03-02' }), 'P001')   // PB-2 (03-01) now falls BEFORE the period
    expect(r.opening).toBe(135 + 44)
    expect(r.purchased).toBe(0)
    expect(r.closing).toBe(160)            // closing unaffected by where the period starts
    const last = byCode(await run({ to: '2026-03-30' }), 'P001') // receipt on 03-31 now excluded
    expect(last.received).toBe(0)
    expect(last.closing).toBe(150)
    expect(last.rate).toBe(12)             // historical rate as of `to`, not the later 11
  })

  test('include_discount=false reports the pre-discount sales value', async () => {
    const r = byCode(await run({ include_discount: 'false' }), 'P001')
    expect(r.sales_value).toBe(600)
  })

  test('totals cover all filtered products, not just the page', async () => {
    const rep = await run({ limit: 1, page: 1 })
    expect(rep.rows).toHaveLength(1)
    expect(rep.pagination).toMatchObject({ total: 2, pages: 2, limit: 1 })
    expect(rep.totals.total_products).toBe(2)
    expect(rep.totals.opening).toBe(145)           // 135 + 10
    expect(rep.totals.closing).toBe(170)
    expect(rep.totals.sold).toBe(30)
    expect(rep.totals.low_stock_count).toBe(1)     // P2: 10 < 50
    expect(rep.totals.out_of_stock_count).toBe(0)
    expect(rep.totals.stock_value).toBe(1760 + 50) // P2: 10 × 5
    expect(rep.totals.net_sales_value).toBe(540 - 100)
  })

  test('sorting + pagination are server-side', async () => {
    const asc  = await run({ sort_by: 'closing', sort_dir: 'asc' })
    expect(asc.rows.map(r => r.item_code)).toEqual(['P002', 'P001'])
    const desc = await run({ sort_by: 'closing', sort_dir: 'desc' })
    expect(desc.rows.map(r => r.item_code)).toEqual(['P001', 'P002'])
    const p2 = await run({ sort_by: 'name', limit: 1, page: 2 })
    expect(p2.rows.map(r => r.item_code)).toEqual(['P001'])   // names: Amoxicillin, Paracetamol
  })

  test('filters change the data: company, category, search, barcode, inactive, supplier', async () => {
    expect((await run({ company: 'acme' })).rows.map(r => r.item_code)).toEqual(['P001'])
    expect((await run({ category: 'Capsule' })).rows.map(r => r.item_code)).toEqual(['P002'])
    expect((await run({ search: 'amoxi' })).rows.map(r => r.item_code)).toEqual(['P002'])
    expect((await run({ search: 'p001' })).rows.map(r => r.item_code)).toEqual(['P001'])
    expect((await run({ search: '8901230001' })).rows.map(r => r.item_code)).toEqual(['P001'])
    expect((await run({})).rows.map(r => r.item_code)).not.toContain('P003')
    expect((await run({ include_inactive: '1' })).rows.map(r => r.item_code)).toContain('P003')
    expect((await run({ supplier_id: ids.s1 })).rows.map(r => r.item_code)).toEqual(['P001'])
    expect((await run({ supplier_id: ids.s2 })).rows.map(r => r.item_code)).toEqual(['P002'])
  })

  test('stock-status filters: low / zero / in_stock', async () => {
    expect((await run({ stock_status: 'low' })).rows.map(r => r.item_code)).toEqual(['P002'])
    expect((await run({ stock_status: 'in_stock' })).rows.map(r => r.item_code)).toEqual(['P002', 'P001'])   // default sort = name (Amoxicillin, Paracetamol)
    const zero = await run({ stock_status: 'zero', include_inactive: '1' })
    expect(zero.rows.map(r => r.item_code)).toEqual(['P003'])
    expect(zero.totals.out_of_stock_count).toBe(1)
  })

  test('batch and expiry filters restrict the movements that are counted', async () => {
    const b2 = await run({ batch: 'B2' })
    expect(b2.rows.map(r => r.item_code)).toEqual(['P001'])       // P2 has no B2 movement → not listed
    expect(b2.rows[0].opening).toBe(0)                            // nothing in batch B2 before March
    expect(b2.rows[0].sold).toBe(30)
    const old = await run({ expiry_to: '2026-12-31' })            // B2 expires 2027-06 → excluded
    expect(old.rows.map(r => r.item_code)).toEqual([])
    const soon = await run({ expiry_from: '2027-01-01', expiry_to: '2027-12-31' })
    expect(soon.rows.map(r => r.item_code)).toEqual(['P001'])
  })

  test('company isolation', async () => {
    const mine = await run()
    expect(mine.rows.map(r => r.item_code)).not.toContain('B001')
    expect(mine.totals.purchased).toBe(40)                        // not +999 from the other company
    const other = await run({}, ids.cid2)
    expect(other.rows.map(r => r.item_code)).toEqual(['B001'])
    expect(byCode(other, 'B001').purchased).toBe(999)
    await expect(svc.getBatchBreakdown(ids.cid2, { productId: ids.p1, ...F })).rejects.toMatchObject({ status: 404 })
  })

  test('agrees with the per-product Stock Register (same movement rules)', async () => {
    const reg = await getRegister(ids.cid, { productId: ids.p1, from: F.from, to: F.to })
    const r = byCode(await run(), 'P001')
    expect(reg.opening_balance).toBe(r.opening)
    expect(reg.totals.closing_balance).toBe(r.closing)
    const last = reg.rows[reg.rows.length - 1]
    expect(last.balance).toBe(r.closing)
  })

  test('batch breakdown reconciles to the product closing', async () => {
    const batches = await svc.getBatchBreakdown(ids.cid, { productId: ids.p1, ...F })
    expect(batches.reduce((s, b) => s + b.closing, 0)).toBe(160)
    expect(batches.map(b => b.batch_no).sort()).toEqual(['B0', 'B1', 'B2'])
  })

  test('movement drill-down (register) honors the same batch / expiry filters', async () => {
    const reg = await getRegister(ids.cid, { productId: ids.p1, from: F.from, to: F.to, batch: 'B2' })
    const b2  = (await svc.getBatchBreakdown(ids.cid, { productId: ids.p1, ...F })).find(b => b.batch_no === 'B2')
    expect(reg.totals.closing_balance).toBe(b2.closing)
    expect(reg.rows.every(r => r.batch === 'B2')).toBe(true)
    expect(reg.rows.some(r => r.free_effect === 1)).toBe(true)           // exposed for the In column
    const none = await getRegister(ids.cid, { productId: ids.p1, from: F.from, to: F.to, expiryTo: '2026-12-31' })
    expect(none.rows).toEqual([])
  })

  test('CSV mirrors the filtered data', async () => {
    const rep = await svc.getSummary(ids.cid, svc.validateFilters({ ...F, company: 'Acme', all: '1' }))
    const csv = svc.toCSV(rep)
    expect(csv).toContain('Company: Acme')
    expect(csv).toContain('P001,Paracetamol 500')
    expect(csv).not.toContain('P002')
  })
})

describe('validateFilters', () => {
  const v = (o) => () => svc.validateFilters(o)
  test('requires and validates dates', () => {
    expect(v({})).toThrow(/required/)
    expect(v({ from: '2026-13-45', to: '2026-03-31' })).toThrow(/valid/)
    expect(v({ from: '2026-04-01', to: '2026-03-31' })).toThrow(/cannot be after/)
    expect(v({ ...F, expiry_from: '2027-02-01', expiry_to: '2027-01-01' })).toThrow(/Expiry/)
  })
  test('rejects unknown sort / status / bad uuid, caps limit', () => {
    expect(v({ ...F, sort_by: 'name; DROP TABLE products' })).toThrow(/sort_by/)
    expect(v({ ...F, sort_dir: 'sideways' })).toThrow(/sort_dir/)
    expect(v({ ...F, stock_status: 'weird' })).toThrow(/stock_status/)
    expect(v({ ...F, supplier_id: 'not-a-uuid' })).toThrow(/supplier_id/)
    expect(svc.validateFilters({ ...F, limit: '99999' }).limit).toBe(200)
    expect(svc.validateFilters({ ...F }).includeDiscount).toBe(true)
  })
})
