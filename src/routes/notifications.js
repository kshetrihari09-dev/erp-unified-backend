/**
 * routes/notifications.js — generic in-app notification feed.
 *
 * No notification module existed in this codebase before this feature
 * (see migration 032 header). Minimal by design: a notification is either
 * per-user (user_id set) or company-wide (user_id null — visible to
 * everyone in the company, e.g. a credit-risk alert any manager should
 * see). Credit-Risk (services/creditRiskRecalc.js) is the first writer;
 * `category` lets the UI/future features distinguish their own without
 * another migration.
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')

router.use(authenticate)

/* ── GET /notifications ──────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { category, unread_only } = req.query
    let q = db('notifications')
      .where('company_id', req.companyId)
      .where(b => b.whereNull('user_id').orWhere('user_id', req.user.id))
    if (category)               q = q.where('category', category)
    if (unread_only === 'true') q = q.where('is_read', false)

    const [{ count }] = await q.clone().count('id as count')
    const [{ count: unreadCount }] = await q.clone().where('is_read', false).count('id as count')
    const data = await q.orderBy('created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit, meta: { unread_count: Number(unreadCount) } })
  } catch (err) { next(err) }
})

/* ── PUT /notifications/:id/read ─────────────────────────────────────────── */
router.put('/:id/read', async (req, res, next) => {
  try {
    const notif = await db('notifications')
      .where({ id: req.params.id, company_id: req.companyId })
      .andWhere(b => b.whereNull('user_id').orWhere('user_id', req.user.id))
      .first()
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' })
    const [updated] = await db('notifications').where({ id: notif.id }).update({ is_read: true, updated_at: new Date() }).returning('*')
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── PUT /notifications/read-all ─────────────────────────────────────────── */
router.put('/read-all', async (req, res, next) => {
  try {
    await db('notifications')
      .where('company_id', req.companyId)
      .andWhere(b => b.whereNull('user_id').orWhere('user_id', req.user.id))
      .andWhere('is_read', false)
      .update({ is_read: true, updated_at: new Date() })
    return successResponse(res, null, 'All notifications marked read')
  } catch (err) { next(err) }
})

module.exports = router
