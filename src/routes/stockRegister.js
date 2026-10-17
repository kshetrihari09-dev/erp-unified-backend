/**
 * stockRegister.js — /api/stock-register
 *   GET /                 per-product register (JSON)
 *   GET /export           same figures as CSV
 *   GET /lookup?code=     exact product-code lookup
 *   GET /stores           store list for the filter dropdown
 *   GET /summary          Stock & Sales Summary (all products, paginated, with totals)
 *   GET /summary/export   same figures + filters as CSV
 *   GET /summary/filters  manufacturer / category options for the filter dropdowns
 *   GET /summary/batches  per-batch breakdown for one product
 *
 * Authorization: same as the rest of this router — authenticate(), and every query is scoped
 * to req.companyId from the session (never from the request).
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { getRegister, toCSV, STORES } = require('../services/stockRegisterService')
const summary = require('../services/stockSummaryService')

router.use(authenticate)

const parse = (q) => ({
  productId:  q.product_id,
  from:       q.from || undefined,
  to:         q.to   || undefined,
  store:      q.store || 'all',
  includeAdj: q.include_adj === undefined ? true : ['1', 'true', 'yes'].includes(String(q.include_adj).toLowerCase()),
  // Optional batch / expiry restriction (used by the Stock & Sales Summary drill-down).
  batch:      q.batch || undefined,
  expiryFrom: q.expiry_from || undefined,
  expiryTo:   q.expiry_to   || undefined,
})

router.get('/stores', (req, res) => successResponse(res, STORES))

router.get('/lookup', async (req, res, next) => {
  try {
    const code = String(req.query.code || '').trim()
    if (!code) return res.status(400).json({ success: false, message: 'code is required' })
    const p = await db('products').where({ company_id: req.companyId, is_active: true })
      .whereRaw('LOWER(item_code) = LOWER(?)', [code]).select('id', 'item_code', 'name', 'unit').first()
    if (!p) return res.status(404).json({ success: false, message: 'No product with that code' })
    return successResponse(res, p)
  } catch (err) { next(err) }
})

router.get('/summary/filters', async (req, res, next) => {
  try { return successResponse(res, await summary.getFilterOptions(req.companyId)) } catch (err) { next(err) }
})

router.get('/summary/batches', async (req, res, next) => {
  try {
    const q = req.query
    return successResponse(res, await summary.getBatchBreakdown(req.companyId, {
      productId: q.product_id, from: q.from, to: q.to,
      batch: q.batch || undefined, expiryFrom: q.expiry_from || undefined, expiryTo: q.expiry_to || undefined,
    }))
  } catch (err) { next(err) }
})

router.get('/summary/export', async (req, res, next) => {
  try {
    const f = summary.validateFilters({ ...req.query, all: '1' })
    const rep = await summary.getSummary(req.companyId, f)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="stock-sales-summary-${f.from}_to_${f.to}.csv"`)
    return res.send(summary.toCSV(rep))
  } catch (err) { next(err) }
})

router.get('/summary', async (req, res, next) => {
  try {
    const f = summary.validateFilters(req.query)
    return successResponse(res, await summary.getSummary(req.companyId, f))
  } catch (err) { next(err) }
})

router.get('/', async (req, res, next) => {
  try {
    return successResponse(res, await getRegister(req.companyId, parse(req.query)))
  } catch (err) { next(err) }
})

router.get('/export', async (req, res, next) => {
  try {
    const rep = await getRegister(req.companyId, parse(req.query))
    const safe = String(rep.product.item_code || 'product').replace(/[^\w.-]+/g, '_')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="stock-register-${safe}.csv"`)
    return res.send(toCSV(rep))
  } catch (err) { next(err) }
})

module.exports = router
