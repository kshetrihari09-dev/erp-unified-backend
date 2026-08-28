/**
 * routes/purchaseOrders.js — Purchase Order workflow
 *
 * This table didn't exist before Smart Purchase Suggestions (migration
 * 031) — `purchases` (routes/purchases.js) has always represented an
 * already-received supplier bill. A purchase_orders row is the planning/
 * ordering document that sits *before* that: pending → approved →
 * (partially_received | received) | cancelled.
 *
 * Receiving happens through the EXISTING purchase workflow: when the
 * supplier bill arrives, the user records it via POST /purchases as
 * before, optionally passing `purchase_order_id` to link it — that's what
 * advances a PO's status and qty_received (see purchases.js). This file
 * only covers the ordering side: list, detail, manual create, approve,
 * cancel.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { v4: uuid } = require('uuid')
const { authenticate, requireRole } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { auditLog, nextOrderNo } = require('../utils/helpers')

router.use(authenticate)

/* ── GET /purchase-orders ─────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { status, supplier_id, search } = req.query

    let q = db('purchase_orders as po')
      .leftJoin('parties as s', 'po.supplier_id', 's.id')
      .where('po.company_id', req.companyId)
      .select('po.*', 's.name as supplier_name')

    if (status)      q = q.andWhere('po.status', status)
    if (supplier_id) q = q.andWhere('po.supplier_id', supplier_id)
    if (search)      q = q.andWhere(b => b.whereILike('po.order_no', `%${search}%`).orWhereILike('s.name', `%${search}%`))

    const [{ count }] = await q.clone().clearSelect().count('po.id as count')
    const data = await q.orderBy('po.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /purchase-orders/:id ─────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const order = await db('purchase_orders as po')
      .leftJoin('parties as s', 'po.supplier_id', 's.id')
      .where('po.id', req.params.id).andWhere('po.company_id', req.companyId)
      .select('po.*', 's.name as supplier_name')
      .first()
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' })
    const items = await db('purchase_order_items').where({ purchase_order_id: order.id })
    // Bills already recorded against this PO (see purchases.js purchase_order_id link)
    const bills = await db('purchases').where({ purchase_order_id: order.id }).select('id', 'bill_no', 'date_ad', 'net_total', 'status')
    return successResponse(res, { ...order, items, bills })
  } catch (err) { next(err) }
})

/* ── POST /purchase-orders ────────────────────────────────────────────────
 * Manual creation (not via Smart Purchase Suggestions — see
 * routes/purchaseSuggestions.js POST /create-purchase-orders for that path,
 * which shares the same underlying tables).
 * ──────────────────────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { supplier_id, expected_date, notes, items } = req.body
    if (!Array.isArray(items) || !items.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'At least one item is required' })
    }

    const orderItems = items.map(i => {
      const qty  = Number(i.qty_ordered ?? i.qty) || 0
      const rate = Number(i.rate) || 0
      return {
        id: uuid(),
        product_id:   i.product_id || null,
        product_name: i.product_name || '',
        qty_ordered:  qty,
        rate,
        amount: Math.round(qty * rate * 100) / 100,
      }
    }).filter(i => i.qty_ordered > 0)

    if (!orderItems.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'No valid items to order' })
    }

    const orderNo = await nextOrderNo(trx, req.companyId)
    const estimatedTotal = orderItems.reduce((s, i) => s + i.amount, 0)

    const [order] = await trx('purchase_orders').insert({
      id: uuid(),
      company_id:   req.companyId,
      supplier_id:  supplier_id || null,
      created_by:   req.user.id,
      order_no:     orderNo,
      order_date:   new Date().toISOString().split('T')[0],
      expected_date: expected_date || null,
      source: 'manual',
      status: 'pending',
      estimated_total: Math.round(estimatedTotal * 100) / 100,
      notes: notes || null,
    }).returning('*')

    await trx('purchase_order_items').insert(orderItems.map(i => ({ ...i, purchase_order_id: order.id })))
    await auditLog(req.companyId, req.user.id, 'CREATE', 'purchase_orders', order.id, { order_no: orderNo }, req.ip)

    await trx.commit()
    return successResponse(res, { ...order, items: orderItems }, 'Purchase order created', 201)
  } catch (err) { await trx.rollback(); next(err) }
})

/* ── PUT /purchase-orders/:id/approve ────────────────────────────────────── */
router.put('/:id/approve', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const order = await db('purchase_orders').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' })
    if (order.status !== 'pending') return res.status(400).json({ success: false, message: `Cannot approve a purchase order in '${order.status}' status` })
    const [updated] = await db('purchase_orders').where({ id: order.id }).update({ status: 'approved', updated_at: new Date() }).returning('*')
    await auditLog(req.companyId, req.user.id, 'APPROVE', 'purchase_orders', order.id, {}, req.ip)
    return successResponse(res, updated, 'Purchase order approved')
  } catch (err) { next(err) }
})

/* ── PUT /purchase-orders/:id/cancel ─────────────────────────────────────── */
router.put('/:id/cancel', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const order = await db('purchase_orders').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' })
    if (['received', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel a purchase order in '${order.status}' status` })
    }
    const [updated] = await db('purchase_orders').where({ id: order.id }).update({ status: 'cancelled', updated_at: new Date() }).returning('*')
    await auditLog(req.companyId, req.user.id, 'CANCEL', 'purchase_orders', order.id, {}, req.ip)
    return successResponse(res, updated, 'Purchase order cancelled')
  } catch (err) { next(err) }
})

module.exports = router
