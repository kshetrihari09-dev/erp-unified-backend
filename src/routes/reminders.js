/**
 * routes/reminders.js — Smart Reminder & Follow-up Module (section 18/19).
 *
 * Thin HTTP layer over services/reminderService.js — every rule (who can
 * edit what, dedupe, recurrence, validation) lives there so the
 * automatic-reminder scheduler (services/reminderScheduler.js) and this
 * route can never disagree about them.
 *
 * Company isolation: every query in reminderService.js is scoped by
 * company_id taken from req.companyId (never from the request body/query
 * — same pattern as sales.js/parties.js), and `authenticate` has already
 * re-verified this user still has live membership to that company on
 * every request. A reminder ID from another company simply won't match
 * `where({ id, company_id })` and comes back 404, not 403 — never
 * confirming to a caller that a given ID exists in someone else's company.
 */
const router = require('express').Router()
const db = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { parsePagination } = require('../middleware/helpers')
const { auditLog } = require('../utils/helpers')
const svc = require('./../services/reminderService')

router.use(authenticate)

// Re-resolve the acting user's own row (role + can_manage_reminders) once
// per request — same "never trust the JWT for authorization data" stance
// middleware/index.js's authenticate already takes for req.user.role.
router.use(async (req, res, next) => {
  try {
    const user = await db('users').where({ id: req.user.id }).first('id', 'role', 'can_manage_reminders')
    if (!user) return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: 'Account not found.' })
    req.reminderUser = user
    next()
  } catch (err) { next(err) }
})

/* ── GET /reminders/types ─────────────────────────────────────────────────
 * Friendly-name lookup for the UI's type picker/filter — never hardcode
 * the enum list twice in two places. */
router.get('/types', (req, res) => {
  res.json({ success: true, data: svc.TYPES.map(value => ({ value, label: svc.TYPE_LABELS[value] })) })
})

/* ── GET /reminders/counts ────────────────────────────────────────────────
 * Today/Overdue/Upcoming/Completed — the dashboard's header counts. */
router.get('/counts', async (req, res, next) => {
  try {
    const counts = await svc.getCounts(req.companyId, req.reminderUser)
    res.json({ success: true, data: counts })
  } catch (err) { next(err) }
})

/* ── GET /reminders/assignable-users ──────────────────────────────────────
 * Deliberately lighter than GET /settings/users (admin/manager-only,
 * returns permission flags) — this is just "who can I assign a reminder
 * to", available to anyone who can create a reminder at all. Scoped via
 * user_companies (migration 019), the same multi-company membership
 * table `authenticate` itself checks, not the legacy users.company_id. */
router.get('/assignable-users', async (req, res, next) => {
  try {
    const rows = await db('user_companies as uc')
      .join('users as u', 'u.id', 'uc.user_id')
      .where('uc.company_id', req.companyId)
      .where('u.is_active', true)
      .orderBy('u.name')
      .select('u.id', 'u.name')
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

/* ── GET /reminders ───────────────────────────────────────────────────────
 * ?bucket=today|upcoming|overdue|completed|all, plus status/priority/
 * reminder_type/assigned_user_id/customer_id/search/sort/page/limit. */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = parsePagination(req.query)
    const result = await svc.listReminders(req.companyId, { ...req.query, page, limit }, req.reminderUser)
    res.json({
      success: true, data: result.data,
      pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: Math.ceil(result.total / result.limit) },
    })
  } catch (err) { next(err) }
})

/* ── GET /reminders/:id ───────────────────────────────────────────────────
 * Own/assigned reminder is always visible; a team member's requires
 * can_manage_reminders — same "view your own, managers see the team's"
 * split listReminders() applies, enforced here for the single-record read. */
router.get('/:id', async (req, res, next) => {
  try {
    const reminder = await db('reminders').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!reminder) return res.status(404).json({ success: false, message: 'Reminder not found' })
    if (!svc.canManage(reminder, req.reminderUser) && reminder.created_by !== req.reminderUser.id && reminder.assigned_user_id !== req.reminderUser.id) {
      return res.status(403).json({ success: false, message: 'You do not have permission to view this reminder.' })
    }
    res.json({ success: true, data: await svc.getReminder(req.companyId, req.params.id) })
  } catch (err) { next(err) }
})

/* ── POST /reminders ──────────────────────────────────────────────────────
 * Server-side validation only — never trust the frontend form
 * (requirement #18: "Never rely only on frontend validation"). */
router.post('/', async (req, res, next) => {
  try {
    const reminder = await svc.createReminder(req.companyId, req.user.id, req.body)
    await auditLog(req.companyId, req.user.id, 'CREATE', 'reminder', reminder.id, { title: reminder.title, reminder_type: reminder.reminder_type }, req.ip)
    res.status(201).json({ success: true, data: reminder })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message })
    next(err)
  }
})

/* ── PATCH /reminders/:id ─────────────────────────────────────────────── */
router.patch('/:id', async (req, res, next) => {
  try {
    const reminder = await svc.updateReminder(req.companyId, req.params.id, req.user.id, req.reminderUser, req.body)
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'reminder', reminder.id, Object.keys(req.body || {}), req.ip)
    res.json({ success: true, data: reminder })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message })
    next(err)
  }
})

/* ── DELETE /reminders/:id ────────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await svc.deleteReminder(req.companyId, req.params.id, req.reminderUser)
    await auditLog(req.companyId, req.user.id, 'DELETE', 'reminder', deleted.id, { title: deleted.title }, req.ip)
    res.json({ success: true, message: 'Reminder deleted' })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message })
    next(err)
  }
})

/* ── POST /reminders/:id/complete ─────────────────────────────────────── */
router.post('/:id/complete', async (req, res, next) => {
  try {
    const reminder = await svc.completeReminder(req.companyId, req.params.id, req.reminderUser)
    await auditLog(req.companyId, req.user.id, 'COMPLETE', 'reminder', req.params.id, null, req.ip)
    res.json({ success: true, data: reminder })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message })
    next(err)
  }
})

/* ── POST /reminders/:id/reopen ───────────────────────────────────────── */
router.post('/:id/reopen', async (req, res, next) => {
  try {
    const reminder = await svc.reopenReminder(req.companyId, req.params.id, req.reminderUser)
    await auditLog(req.companyId, req.user.id, 'REOPEN', 'reminder', req.params.id, null, req.ip)
    res.json({ success: true, data: reminder })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message })
    next(err)
  }
})

/* ── POST /reminders/:id/snooze ───────────────────────────────────────────
 * Body: either { preset: '10m'|'30m'|'1h'|'tonight'|'tomorrow_morning'|
 * 'tomorrow'|'next_working_day' } or { snoozed_until: <ISO datetime> } for
 * the "Custom" option. */
router.post('/:id/snooze', async (req, res, next) => {
  try {
    const { preset, snoozed_until, timezone } = req.body || {}
    const until = preset ? svc.resolveSnoozePreset(preset, timezone) : snoozed_until
    if (!until) return res.status(400).json({ success: false, message: 'Provide either a preset or snoozed_until.' })
    const reminder = await svc.snoozeReminder(req.companyId, req.params.id, req.reminderUser, until)
    await auditLog(req.companyId, req.user.id, 'SNOOZE', 'reminder', req.params.id, { snoozed_until: until }, req.ip)
    res.json({ success: true, data: reminder })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'INVALID_REQUEST', message: err.message })
    next(err)
  }
})

module.exports = router
