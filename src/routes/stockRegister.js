/**
 * stockRegister.js — /api/stock-register
 *   GET /                 per-product register (JSON)
 *   GET /export           same figures as CSV
 *   GET /lookup?code=     exact product-code lookup
 *   GET /stores           store list for the filter dropdown
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { getRegister, toCSV, STORES } = require('../services/stockRegisterService')

router.use(authenticate)

const parse = (q) => ({
  productId:  q.product_id,
  from:       q.from || undefined,
  to:         q.to   || undefined,
  store:      q.store || 'all',
  includeAdj: q.include_adj === undefined ? true : ['1', 'true', 'yes'].includes(String(q.include_adj).toLowerCase()),
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
