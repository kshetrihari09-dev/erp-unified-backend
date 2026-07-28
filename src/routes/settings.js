/* ═══════════════════════════════════════════════════════════════════════
   settings.js
═══════════════════════════════════════════════════════════════════════ */
const router = require('express').Router()
const db     = require('../db/knex')
const bcrypt = require('bcryptjs')
const fs     = require('fs')
const { v4: uuid } = require('uuid')
const { authenticate, requireRole, requireSensitiveConfirm } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { auditLog } = require('../utils/helpers')
const { withDefaults, mergeSettings } = require('../utils/settingsDefaults')
const backupService = require('../services/backupService')

router.use(authenticate)

/* ── GET /settings/company ──────────────────────────────────────────── */
router.get('/company', async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first()
    return successResponse(res, company)
  } catch (err) { next(err) }
})

/* ── PUT /settings/company ──────────────────────────────────────────── */
router.put('/company', requireRole('admin', 'manager'), requireSensitiveConfirm('companySettings'), async (req, res, next) => {
  try {
    const allowed = ['name','address','phone','email','website','pan_no','registration_no','date_system','invoice_prefix','vat_percent']
    const updates = {}
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k] }
    const [updated] = await db('companies').where({ id: req.companyId }).update({ ...updates, updated_at: new Date() }).returning('*')
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'company', req.companyId, updates, req.ip)
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── GET /settings/preferences ─────────────────────────────────────────
 * Backs General / Sales & Purchase / Accounting & Vouchers / Notifications
 * / sensitive-action toggles. All new (non-typed-column) settings live in
 * companies.settings jsonb, merged with defaults so the frontend always
 * gets a complete, predictable shape even for a company that has never
 * saved preferences before. */
router.get('/preferences', async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first('settings')
    return successResponse(res, withDefaults(company?.settings || {}))
  } catch (err) { next(err) }
})

/* ── PUT /settings/preferences ─────────────────────────────────────────
 * Body may contain any subset of { general, salesPurchase, accounting,
 * notifications, sensitiveActions, backup } — each section is merged
 * (not replaced) with what's already stored, so partial saves from one
 * settings tab never clobber another tab's values. */
router.put('/preferences', requireRole('admin', 'manager'), requireSensitiveConfirm('companySettings'), async (req, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first('settings')
    const merged = mergeSettings(company?.settings || {}, req.body || {})
    await db('companies').where({ id: req.companyId }).update({ settings: JSON.stringify(merged), updated_at: new Date() })
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'company_settings', req.companyId, Object.keys(req.body || {}), req.ip)
    return successResponse(res, merged, 'Preferences saved')
  } catch (err) { next(err) }
})

/* ── GET /settings/users ────────────────────────────────────────────── */
router.get('/users', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const [{ count }] = await db('users').where({ company_id: req.companyId }).count('id as count')
    const data = await db('users').where({ company_id: req.companyId }).select(
      'id','name','email','phone','role','is_active','last_login_at','created_at',
      'can_post_vouchers','can_approve_vouchers','can_lock_periods','can_reverse_entries'
    ).orderBy('name').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── POST /settings/users ───────────────────────────────────────────── */
router.post('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, password, role, phone } = req.body
    if (!name || !email || !password) return res.status(400).json({ success: false, message: 'Name, email and password required' })
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' })

    const exists = await db('users').where({ company_id: req.companyId, email: email.toLowerCase() }).first()
    if (exists) return res.status(409).json({ success: false, message: 'Email already exists in this company' })

    const password_hash = await bcrypt.hash(password, 12)
    const [user] = await db('users').insert({
      id: uuid(), company_id: req.companyId,
      name, email: email.toLowerCase(), password_hash,
      phone: phone || null, role: role || 'cashier', is_active: true,
    }).returning('id','name','email','phone','role','is_active','created_at','can_post_vouchers','can_approve_vouchers','can_lock_periods','can_reverse_entries')

    await auditLog(req.companyId, req.user.id, 'CREATE_USER', 'users', user.id, { name, email, role }, req.ip)
    return successResponse(res, user, 'User created', 201)
  } catch (err) { next(err) }
})

/* ── PUT /settings/users/:id ────────────────────────────────────────── */
router.put('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const user = await db('users').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!user) return res.status(404).json({ success: false, message: 'User not found' })

    const updates = {}
    if (req.body.name)      updates.name      = req.body.name
    if (req.body.phone)     updates.phone     = req.body.phone
    if (req.body.role)      updates.role      = req.body.role
    if (req.body.is_active !== undefined) updates.is_active = req.body.is_active
    // Real, backend-enforced permission flags (see requirePermission() in
    // middleware/index.js) — surfaced in Settings → Users & Permissions.
    // Admin-only route already (see requireRole('admin') above).
    for (const flag of ['can_post_vouchers', 'can_approve_vouchers', 'can_lock_periods', 'can_reverse_entries']) {
      if (req.body[flag] !== undefined) updates[flag] = !!req.body[flag]
    }
    if (req.body.password) {
      if (req.body.password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' })
      updates.password_hash = await bcrypt.hash(req.body.password, 12)
    }
    const [updated] = await db('users').where({ id: req.params.id }).update({ ...updates, updated_at: new Date() }).returning(
      'id','name','email','phone','role','is_active','can_post_vouchers','can_approve_vouchers','can_lock_periods','can_reverse_entries'
    )
    await auditLog(req.companyId, req.user.id, 'UPDATE_USER', 'users', req.params.id, { name: updates.name }, req.ip)
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── GET /settings/invoice-templates ───────────────────────────────── */
router.get('/invoice-templates', async (req, res, next) => {
  try {
    const data = await db('invoice_templates').where({ company_id: req.companyId }).orderBy('created_at')
    return successResponse(res, data)
  } catch (err) { next(err) }
})

/* ── POST /settings/invoice-templates ──────────────────────────────── */
router.post('/invoice-templates', requireRole('admin','manager'), async (req, res, next) => {
  try {
    const { name, config } = req.body
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Template name required' })
    const [tpl] = await db('invoice_templates').insert({ id: uuid(), company_id: req.companyId, name, config: JSON.stringify(config || {}), is_default: false }).returning('*')
    return successResponse(res, tpl, 'Template created', 201)
  } catch (err) { next(err) }
})

/* ── PUT /settings/invoice-templates/:id ───────────────────────────── */
router.put('/invoice-templates/:id', requireRole('admin','manager'), async (req, res, next) => {
  try {
    const { name, config } = req.body
    const updates = {}
    if (name)   updates.name   = name
    if (config) updates.config = JSON.stringify(config)
    const [updated] = await db('invoice_templates').where({ id: req.params.id, company_id: req.companyId }).update({ ...updates, updated_at: new Date() }).returning('*')
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── PUT /settings/invoice-templates/:id/set-default ───────────────── */
router.put('/invoice-templates/:id/set-default', requireRole('admin','manager'), async (req, res, next) => {
  try {
    await db('invoice_templates').where({ company_id: req.companyId }).update({ is_default: false })
    const [updated] = await db('invoice_templates').where({ id: req.params.id, company_id: req.companyId }).update({ is_default: true }).returning('*')
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── DELETE /settings/invoice-templates/:id ─────────────────────────── */
router.delete('/invoice-templates/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const tpl = await db('invoice_templates').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' })
    if (tpl.is_default) return res.status(400).json({ success: false, message: 'Cannot delete the default template' })
    await db('invoice_templates').where({ id: req.params.id }).del()
    return successResponse(res, null, 'Template deleted')
  } catch (err) { next(err) }
})

/* ── GET /settings/fiscal-years ─────────────────────────────────────── */
router.get('/fiscal-years', async (req, res, next) => {
  try {
    const data = await db('fiscal_years').where({ company_id: req.companyId }).orderBy('start_date_ad', 'desc')
    return successResponse(res, data)
  } catch (err) { next(err) }
})

/* ── POST /settings/fiscal-years ────────────────────────────────────── */
router.post('/fiscal-years', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, start_date_ad, end_date_ad, start_date_bs, end_date_bs } = req.body
    if (!name || !start_date_ad || !end_date_ad) return res.status(400).json({ success: false, message: 'Name, start and end dates required' })
    const [fy] = await db('fiscal_years').insert({ id: uuid(), company_id: req.companyId, name, start_date_ad, end_date_ad, start_date_bs: start_date_bs||null, end_date_bs: end_date_bs||null }).returning('*')
    return successResponse(res, fy, 'Fiscal year created', 201)
  } catch (err) { next(err) }
})

/* ── GET /settings/audit-log ─────────────────────────────────────────────────
 * Filters (all optional, all real — none of these are decorative):
 *   search      — matches user name/email, action, entity_type, or IP
 *   date_from / date_to — inclusive created_at range (YYYY-MM-DD)
 *   user_id     — exact match on a.user_id
 *   action      — exact match on a.action (e.g. CREATE, CANCEL)
 *   entity_type — exact match on a.entity_type
 */
router.get('/audit-log', requireRole('admin', 'manager', 'accountant'), async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 50)
    const { search, date_from, date_to, user_id, action, entity_type } = req.query

    const q = db('audit_log as a')
      .leftJoin('users as u', 'a.user_id', 'u.id')
      .where('a.company_id', req.companyId)
      .select('a.*', 'u.name as user_name', 'u.email as user_email')

    if (user_id)     q.where('a.user_id', user_id)
    if (action)      q.where('a.action', action)
    if (entity_type) q.where('a.entity_type', entity_type)
    if (date_from)   q.where('a.created_at', '>=', new Date(`${date_from}T00:00:00`))
    if (date_to)     q.where('a.created_at', '<=', new Date(`${date_to}T23:59:59`))
    if (search) {
      const term = `%${String(search).toLowerCase()}%`
      q.where((qb) => {
        qb.whereRaw('LOWER(u.name) LIKE ?', [term])
          .orWhereRaw('LOWER(u.email) LIKE ?', [term])
          .orWhereRaw('LOWER(a.action) LIKE ?', [term])
          .orWhereRaw('LOWER(a.entity_type) LIKE ?', [term])
          .orWhereRaw('LOWER(a.ip_address) LIKE ?', [term])
      })
    }

    const [{ count }] = await q.clone().clearSelect().clearOrder().count('a.id as count')
    const data = await q.orderBy('a.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── Backup & Cloud (local backups) ─────────────────────────────────────
 * Real, working local backups — distinct from the OAuth cloud-storage
 * connections in cloudStorage.js. See src/services/backupService.js. */

/* ── GET /settings/backup ─────────────────────────────────────────────
 * History list, most recent first — backs "Last backup status". */
router.get('/backup', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20)
    const [{ count }] = await db('backups').where({ company_id: req.companyId }).count('id as count')
    const data = await db('backups').where({ company_id: req.companyId }).orderBy('created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── POST /settings/backup/run ────────────────────────────────────────
 * Manual backup, triggered from the Settings UI. */
router.post('/backup/run', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const backup = await backupService.runBackup(req.companyId, 'manual', req.user.id)
    if (backup.status !== 'success') {
      return res.status(500).json({ success: false, message: backup.error_message || 'Backup failed', data: backup })
    }
    await auditLog(req.companyId, req.user.id, 'CREATE', 'backup', backup.id, { type: 'manual', size_bytes: backup.size_bytes }, req.ip)
    return successResponse(res, backup, 'Backup completed', 201)
  } catch (err) { next(err) }
})

/* ── GET /settings/backup/:id/download ────────────────────────────────── */
router.get('/backup/:id/download', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const backup = await db('backups').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!backup || backup.status !== 'success' || !backup.file_path || !fs.existsSync(backup.file_path)) {
      return res.status(404).json({ success: false, message: 'Backup file not found' })
    }
    res.download(backup.file_path, backup.file_name)
  } catch (err) { next(err) }
})

/* ── POST /settings/backup/:id/verify ─────────────────────────────────── */
router.post('/backup/:id/verify', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const result = await backupService.verifyBackup(req.companyId, req.params.id)
    return successResponse(res, result, result.verified ? 'Backup verified — checksum matches' : 'Backup verification failed')
  } catch (err) { next(err) }
})

module.exports = router
