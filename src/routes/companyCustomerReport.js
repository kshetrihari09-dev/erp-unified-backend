/**
 * companyCustomerReport.js — /api/reports/company-vs-customer
 *   GET /            report JSON
 *   GET /export      same figures as CSV
 *   GET /companies   manufacturer/company list for the selector
 */
const router = require('express').Router()
const { authenticate } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { getReport, listCompanies, toCSV } = require('../services/companyCustomerService')

router.use(authenticate)

const parse = (q) => ({
  from: q.from, to: q.to,
  company: q.company || 'all',
  customerType: q.customer_type || 'all',
})

router.get('/companies', async (req, res, next) => {
  try { return successResponse(res, await listCompanies(req.companyId)) } catch (err) { next(err) }
})
router.get('/', async (req, res, next) => {
  try { return successResponse(res, await getReport(req.companyId, parse(req.query))) } catch (err) { next(err) }
})
router.get('/export', async (req, res, next) => {
  try {
    const rep = await getReport(req.companyId, parse(req.query))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="company-vs-customer-${rep.filters.from}_${rep.filters.to}.csv"`)
    return res.send(toCSV(rep))
  } catch (err) { next(err) }
})
module.exports = router
