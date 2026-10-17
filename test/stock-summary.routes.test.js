/**
 * HTTP-level checks for /stock-register/summary* against a real, migrated Postgres.
 * Skipped unless TEST_DATABASE_URL is set (see stock-summary.integration.test.js).
 * authenticate() is replaced by a stub that takes the company from a test header — exactly the
 * place the real one sets req.companyId — so we can prove the query string cannot override it.
 */
const URL = process.env.TEST_DATABASE_URL
const d = URL ? describe : describe.skip

jest.mock('../src/db/knex', () => {
  const real = process.env.TEST_DATABASE_URL
  if (!real) return () => ({})
  return require('knex')({ client: 'pg', connection: { connectionString: real, ssl: false }, pool: { min: 1, max: 3 } })
})
jest.mock('../src/middleware/index', () => ({
  ...jest.requireActual('../src/middleware/index'),
  authenticate: (req, res, next) => {
    if (!req.headers['x-test-company']) return res.status(401).json({ success: false, message: 'Unauthorized' })
    req.companyId = req.headers['x-test-company']; req.user = { id: 'u' }; next()
  },
}))

const express = require('express')
const request = require('supertest')

d('GET /stock-register/summary*', () => {
  let db, app, a, b
  beforeAll(async () => {
    db = require('../src/db/knex')
    const { errorHandler } = require('../src/middleware/index')
    app = express()
    app.use('/api/stock-register', require('../src/routes/stockRegister'))
    app.use(errorHandler)
    ;[a] = await db('companies').insert({ name: 'RT-A' }).returning('id')
    ;[b] = await db('companies').insert({ name: 'RT-B' }).returning('id')
    await db('products').insert({ company_id: a.id, item_code: 'RA', name: 'Route A item', category: 'Cat', min_stock: 1 })
    await db('products').insert({ company_id: b.id, item_code: 'RB', name: 'Route B item', min_stock: 1 })
  })
  afterAll(async () => { await db('companies').whereIn('id', [a.id, b.id]).del(); await db.destroy() })

  const get = (path, company) => request(app).get(`/api/stock-register${path}`).set('x-test-company', (company || a).id || company)
  const Q = 'from=2026-03-01&to=2026-03-31'

  test('401 without a session', async () => {
    expect((await request(app).get(`/api/stock-register/summary?${Q}`)).status).toBe(401)
  })
  test('400 for missing / invalid / reversed dates and bad enums', async () => {
    expect((await get('/summary')).status).toBe(400)
    expect((await get('/summary?from=2026-03-01&to=nope')).status).toBe(400)
    expect((await get('/summary?from=2026-04-01&to=2026-03-01')).status).toBe(400)
    expect((await get(`/summary?${Q}&sort_by=1;drop table products`)).status).toBe(400)
    expect((await get(`/summary?${Q}&supplier_id=xyz`)).status).toBe(400)
  })
  test('200 returns rows, totals and pagination for the session company only', async () => {
    const r = await get(`/summary?${Q}`)
    expect(r.status).toBe(200)
    const data = r.body.data
    expect(data.rows.map(x => x.item_code)).toEqual(['RA'])
    expect(data.totals.total_products).toBe(1)
    expect(data.pagination).toMatchObject({ page: 1, total: 1 })
  })
  test('company_id in the query string cannot reach another tenant', async () => {
    const r = await get(`/summary?${Q}&company_id=${b.id}&companyId=${b.id}`)
    expect(r.body.data.rows.map(x => x.item_code)).toEqual(['RA'])
  })
  test('filters reach the data (category that does not exist → empty)', async () => {
    const r = await get(`/summary?${Q}&category=Nope`)
    expect(r.body.data.rows).toEqual([])
    expect(r.body.data.totals.total_products).toBe(0)
  })
  test('CSV export: attachment, BOM, honors filters', async () => {
    const r = await get(`/summary/export?${Q}&category=Cat`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="stock-sales-summary-2026-03-01_to_2026-03-31\.csv"/)
    expect(r.text.charCodeAt(0)).toBe(0xFEFF)
    expect(r.text).toContain('RA,Route A item')
    expect(r.text).toContain('Category: Cat')
  })
  test('filters + batches endpoints are company-scoped', async () => {
    const f = await get('/summary/filters')
    expect(f.body.data.categories).toEqual(['Cat'])
    const pB = (await db('products').where({ company_id: b.id }).first('id')).id
    expect((await get(`/summary/batches?product_id=${pB}&${Q}`)).status).toBe(404)   // B's product, A's session
  })
})
