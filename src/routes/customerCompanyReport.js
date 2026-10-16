/**
 * customerCompanyReport.js — /api/reports/customer-vs-company
 *   GET /            report JSON for one customer
 *   GET /export      same figures as CSV
 *   GET /customers   ?search=  customer lookup for the selector
 */
const router = require('express').Router()
const { authenticate } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { getReport, searchCustomers, toCSV } = require('../services/customerCompanyService')

router.use(authenticate)

const parse = (q) => ({ from: q.from, to: q.to, customerId: q.customer_id })

router.get('/customers', async (req, res, next) => {
  try { return successResponse(res, await searchCustomers(req.companyId, req.query.search, req.query.limit)) } catch (err) { next(err) }
})
router.get('/', async (req, res, next) => {
  try { return successResponse(res, await getReport(req.companyId, parse(req.query))) } catch (err) { next(err) }
})
router.get('/export', async (req, res, next) => {
  try {
    const rep = await getReport(req.companyId, parse(req.query))
    const safe = String(rep.customer.code || rep.customer.name).replace(/[^\w.-]+/g, '_')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="customer-vs-company-${safe}_${rep.filters.from}_${rep.filters.to}.csv"`)
    return res.send(toCSV(rep))
  } catch (err) { next(err) }
})
module.exports = router
