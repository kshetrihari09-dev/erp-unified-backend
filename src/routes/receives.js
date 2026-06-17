/**
 * receives.js — FIXED
 * Line 46: db('stock_batches').insert() → db('inventory_batches').insert()
 * Corrected columns: qty_in/qty_out/qty_available/purchase_rate/date_ad
 *                 → qty_received/qty_remaining/unit_cost/total_cost/receipt_date
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { auditLog, adToBS, todayBS } = require('../utils/helpers')
const AccountingIntegration = require('../services/accountingIntegration')

router.use(authenticate)

const T = 'inventory_batches'

/* ── GET /receives ────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const q = db('receives as r')
      .leftJoin('parties as p', 'r.party_id', 'p.id')
      .where('r.company_id', req.companyId)
      .select('r.*', 'p.name as party_name')

    const [{ count }] = await q.clone().clearSelect().count('r.id as count')
    const data = await q.orderBy('r.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── POST /receives ───────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { party_id, date, items = [], notes } = req.body
    if (!items.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'Items required' })
    }

    const receiveDate = date || new Date().toISOString().split('T')[0]

    const [receive] = await trx('receives').insert({
      company_id: req.companyId,
      party_id:   party_id || null,
      date:       receiveDate,
      notes:      notes || null,
      created_by: req.user.id,
      status:     'active',
    }).returning('*')

    for (const item of items) {
      const qty      = Number(item.qty)  || 0
      const rate     = Number(item.rate) || 0
      const bonus    = Number(item.bonus)|| 0
      const totalQty = qty + bonus
      if (!item.product_id || qty <= 0) continue

      await trx('receive_items').insert({
        receive_id:  receive.id,
        product_id:  item.product_id,
        batch_no:    item.batch_no || null,
        expiry:      item.expiry   || null,
        qty,
        bonus,
        rate,
      })

      // FIX: was db('stock_batches').insert() with nonexistent columns
      await trx(T).insert({
        company_id:    req.companyId,
        product_id:    item.product_id,
        batch_no:      item.batch_no || 'RCV',
        expiry:        item.expiry   || null,
        expiry_date:   parseExpiryToDate(item.expiry),
        receipt_date:  receiveDate,
        qty_received:  totalQty,
        qty_remaining: totalQty,      // FIX: was qty_available
        qty_sold:      0,
        unit_cost:     rate,          // FIX: was purchase_rate
        total_cost:    Math.round(totalQty * rate * 100) / 100,
      })
    }

    // ── Accounting Integration ───────────────────────────────────────────
    try {
      await AccountingIntegration.postReceive({
        receive,
        items,
        trx,
        companyId: req.companyId,
        userId:    req.user.id,
        ipAddress: req.ip,
      })
    } catch (acctErr) {
      if (acctErr.status !== 422) {
        try { await trx.rollback() } catch {}
        return res.status(acctErr.status || 400).json({ success: false, message: acctErr.message })
      }
      console.warn(`[ACCOUNTING] COA not configured — receive saved without journal. ${acctErr.message}`)
    }

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CREATE_RECEIVE', 'receives', receive.id, {}, req.ip)
    return successResponse(res, receive, 'Stock received', 201)
  } catch (err) {
    try { await trx.rollback() } catch {}
    next(err)
  }
})

/* ── DELETE /receives/:id ─────────────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const receive = await trx('receives').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!receive) { await trx.rollback(); return res.status(404).json({ success: false, message: 'Receive not found' }) }

    const items = await trx('receive_items').where({ receive_id: receive.id })
    for (const item of items) {
      if (!item.product_id) continue
      const totalQty = (item.qty || 0) + (item.bonus || 0)
      const batch = await trx(T)
        .where({ product_id: item.product_id, company_id: req.companyId, batch_no: item.batch_no || 'RCV' })
        .orderBy('created_at', 'desc').first()
      if (batch) {
        await trx(T).where({ id: batch.id }).update({
          qty_remaining: Math.max(0, Number(batch.qty_remaining) - totalQty),
        })
      }
    }

    await trx('receive_items').where({ receive_id: receive.id }).del()
    await trx('receives').where({ id: receive.id }).del()
    await trx.commit()
    return successResponse(res, null, 'Receive deleted')
  } catch (err) {
    try { await trx.rollback() } catch {}
    next(err)
  }
})

function parseExpiryToDate(expiry) {
  if (!expiry) return null
  try {
    const [mm, yy] = expiry.split('/')
    if (!mm || !yy) return null
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy)
    const month = Number(mm)
    if (isNaN(year) || isNaN(month)) return null
    const lastDay = new Date(year, month, 0).getDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } catch { return null }
}

module.exports = router
