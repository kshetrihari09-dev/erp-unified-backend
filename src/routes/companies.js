/**
 * companies.js — Multi-Company management
 *
 * Reuses the existing company_id-scoped data model entirely: creating a
 * company here goes through the exact same seeding path (chart of
 * accounts, opening fiscal year, default invoice template) as signup
 * always has. Nothing about how sales/purchases/vouchers/etc. are scoped
 * changes — this file only manages the company_id/company records
 * themselves and which companies a user may switch into.
 *
 * Routes:
 *   GET    /companies              list companies the current user can access
 *   POST   /companies              create a new company (adds current user as a member)
 *   PUT    /companies/:id          edit a company's own info (member-only)
 *   DELETE /companies/:id          deactivate ("delete") a company (member-only, owner/admin, password-confirmed)
 *   POST   /companies/:id/restore  reactivate a previously deleted company (member-only, owner/admin)
 *   POST   /companies/:id/switch   re-issue a token scoped to another company
 *   PUT    /companies/:id/default  mark a company as this user's default
 */
const router = require('express').Router()
const { v4: uuid } = require('uuid')
const bcrypt = require('bcryptjs')
const db = require('../db/knex')
const { authenticate, requireRole } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { auditLog } = require('../utils/helpers')
const { seedDefaultAccounts, seedAccountDefaults, signToken, signRefresh } = require('./auth')

class AppError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status }
}

router.use(authenticate)

/* ── GET /companies — companies this user can access ─────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const rows = await db('user_companies as uc')
      .join('companies as c', 'c.id', 'uc.company_id')
      .where('uc.user_id', req.user.id)
      .orderBy('c.name', 'asc')
      .select(
        'c.id', 'c.name', 'c.address', 'c.phone', 'c.email', 'c.website',
        'c.pan_no', 'c.registration_no', 'c.logo_url', 'c.date_system',
        'c.invoice_prefix', 'c.currency', 'c.vat_percent', 'c.is_active',
        'uc.is_default'
      )

    const data = rows.map((c) => ({ ...c, is_current: c.id === req.companyId }))
    return successResponse(res, data)
  } catch (err) { next(err) }
})

/* ── POST /companies — create a new company ───────────────────────────────
 * Any authenticated user may create an additional company; they become a
 * member of it immediately (and its default, if it's their very first
 * one). Seeds the same chart-of-accounts / fiscal year / invoice template
 * defaults as the signup flow, so a newly created company is immediately
 * usable exactly like one created via signup. */
router.post('/', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const {
      name, address, phone, email, website,
      pan_no, registration_no, date_system, invoice_prefix, currency, vat_percent,
      make_default,
    } = req.body

    if (!name?.trim()) throw new AppError('Company name is required', 400)

    const result = await db.transaction(async (trx) => {
      const companyId = uuid()
      await trx('companies').insert({
        id:              companyId,
        name:            name.trim(),
        address:         address?.trim()  || null,
        phone:           phone?.trim()    || null,
        email:           email?.trim()    || null,
        website:         website?.trim()  || null,
        pan_no:          pan_no?.trim()   || null,
        registration_no: registration_no?.trim() || null,
        date_system:     date_system || 'BS',
        invoice_prefix:  (invoice_prefix || 'INV').toUpperCase().slice(0, 6),
        currency:        currency || 'NPR',
        vat_percent:     vat_percent ?? 13,
      })

      const seededAccountIds = await seedDefaultAccounts(trx, companyId)
      await seedAccountDefaults(trx, companyId, seededAccountIds)

      const year = new Date().getFullYear()
      await trx('accounting_periods').insert({
        id: uuid(), company_id: companyId,
        name: `FY ${year}`, start_date: `${year}-01-01`, end_date: `${year}-12-31`,
      })

      await trx('invoice_templates').insert({
        id: uuid(), company_id: companyId, name: 'Default A4',
        config: JSON.stringify({ _name: 'Default A4', layout: 'a4', show_logo: true, accent: '#2563eb', font_size: 12 }),
        is_default: true,
      })

      const existingCount = await trx('user_companies').where({ user_id: req.user.id }).count('id as c').first()
      const isFirstCompany = Number(existingCount.c) === 0
      const shouldBeDefault = isFirstCompany || !!make_default

      if (shouldBeDefault) {
        await trx('user_companies').where({ user_id: req.user.id }).update({ is_default: false })
      }

      await trx('user_companies').insert({
        id: uuid(), user_id: req.user.id, company_id: companyId, is_default: shouldBeDefault,
      })

      const company = await trx('companies').where({ id: companyId }).first()
      return company
    })

    await auditLog(result.id, req.user.id, 'CREATE', 'company', result.id, { name: result.name }, req.ip)

    return successResponse(res, result, 'Company created', 201)
  } catch (err) { next(err) }
})

/* ── PUT /companies/:id — edit a company's own info ───────────────────────
 * Same allowed-field set as PUT /settings/company (which edits only the
 * CURRENT active company); this lets a user edit any company they belong
 * to without having to switch into it first. Requires membership plus the
 * same admin/manager role check used for the single-company settings edit. */
router.put('/:id', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const membership = await db('user_companies')
      .where({ user_id: req.user.id, company_id: req.params.id })
      .first()
    if (!membership) throw new AppError('You do not have access to this company', 403)

    const allowed = [
      'name', 'address', 'phone', 'email', 'website', 'pan_no',
      'registration_no', 'logo_url', 'date_system', 'invoice_prefix',
      'currency', 'vat_percent',
    ]
    const updates = {}
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k] }

    const [updated] = await db('companies')
      .where({ id: req.params.id })
      .update({ ...updates, updated_at: new Date() })
      .returning('*')
    if (!updated) throw new AppError('Company not found', 404)

    await auditLog(req.params.id, req.user.id, 'UPDATE', 'company', req.params.id, updates, req.ip)
    return successResponse(res, updated, 'Company updated')
  } catch (err) { next(err) }
})

/* ── DELETE /companies/:id — "delete" a company ────────────────────────────
 * Companies are never hard-deleted. Dozens of tables (vouchers, journal
 * entries, ledger accounts, even users' own home company) reference
 * company_id, and for an accounting system historical records must be
 * retained regardless of whether a company is still "open" — this mirrors
 * standard accounting-software practice (e.g. Tally/QuickBooks "delete
 * company" is really an archive). "Delete" here means: is_active = false.
 * The company and every record scoped to it are completely untouched —
 * it's just hidden from active pickers and can't be switched into again
 * until it's restored (see POST /companies/:id/restore, right below).
 *
 * Guards, in order:
 *   - requester must be owner/admin (requireRole('owner') — 'owner' and
 *     'admin' always pass that check; every other role is denied, unlike
 *     PUT /:id above which also allows 'manager')
 *   - requester must actually be a member of the target company
 *   - can't delete the company that's active in THIS session's token —
 *     switch to a different one first, so the client never ends up
 *     holding a token for a company that just got deactivated
 *   - always requires password confirmation, regardless of the
 *     sensitiveActions settings toggle — deletion is destructive enough
 *     from the user's point of view to always ask, even though it's
 *     reversible. Uses the same `requiresPasswordConfirm` response shape
 *     as requireSensitiveConfirm() so the existing useSensitiveConfirm()
 *     frontend hook works here without any special-casing.
 *   - can't delete a user's last remaining active company — they must
 *     always have somewhere to land
 *   - can't delete a company that has other members — a single member
 *     deactivating it would silently lock everyone else out; remove them
 *     first (existing member-management flow, unaffected by this change)
 *
 * If the deleted company was this user's default, another of their active
 * companies is automatically promoted to default so they're never left
 * without one. */
router.delete('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const membership = await db('user_companies')
      .where({ user_id: req.user.id, company_id: req.params.id })
      .first()
    if (!membership) throw new AppError('You do not have access to this company', 403)

    if (req.params.id === req.companyId) {
      throw new AppError('Switch to a different company before deleting this one', 400)
    }

    const company = await db('companies').where({ id: req.params.id }).first()
    if (!company) throw new AppError('Company not found', 404)
    if (company.is_active === false) throw new AppError('This company is already deleted', 400)

    const { confirmPassword } = req.body || {}
    if (!confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Password confirmation is required to delete a company',
        requiresPasswordConfirm: true,
      })
    }
    const user = await db('users').where({ id: req.user.id }).first()
    const passwordOk = user?.password_hash && await bcrypt.compare(confirmPassword, user.password_hash)
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Incorrect password', requiresPasswordConfirm: true })
    }

    const otherActiveMembership = await db('user_companies as uc')
      .join('companies as c', 'c.id', 'uc.company_id')
      .where('uc.user_id', req.user.id)
      .andWhere('uc.company_id', '!=', req.params.id)
      .andWhere('c.is_active', true)
      .first()
    if (!otherActiveMembership) {
      throw new AppError('You must have at least one other active company. Create one before deleting this one.', 400)
    }

    const memberCount = await db('user_companies').where({ company_id: req.params.id }).count('id as c').first()
    if (Number(memberCount.c) > 1) {
      throw new AppError('This company has other members — remove them first, or contact an administrator.', 400)
    }

    await db.transaction(async (trx) => {
      await trx('companies').where({ id: req.params.id }).update({ is_active: false, updated_at: new Date() })

      if (membership.is_default) {
        const nextDefault = await trx('user_companies as uc')
          .join('companies as c', 'c.id', 'uc.company_id')
          .where('uc.user_id', req.user.id)
          .andWhere('uc.company_id', '!=', req.params.id)
          .andWhere('c.is_active', true)
          .select('uc.id')
          .first()
        if (nextDefault) {
          await trx('user_companies').where({ id: nextDefault.id }).update({ is_default: true })
        }
      }
    })

    await auditLog(req.params.id, req.user.id, 'DELETE', 'company', req.params.id, { name: company.name }, req.ip)

    return successResponse(res, { id: req.params.id }, 'Company deleted')
  } catch (err) { next(err) }
})

/* ── POST /companies/:id/restore — undo a delete ───────────────────────────
 * Reactivates a company that was previously soft-deleted above. Since
 * nothing was ever destroyed, this simply flips is_active back on — every
 * account, voucher, and journal entry the company had is exactly as it
 * was. Not password-confirmed since it's non-destructive. */
router.post('/:id/restore', requireRole('owner'), async (req, res, next) => {
  try {
    const membership = await db('user_companies')
      .where({ user_id: req.user.id, company_id: req.params.id })
      .first()
    if (!membership) throw new AppError('You do not have access to this company', 403)

    const existing = await db('companies').where({ id: req.params.id }).first()
    if (!existing) throw new AppError('Company not found', 404)
    if (existing.is_active !== false) throw new AppError('This company is not deleted', 400)

    const [company] = await db('companies')
      .where({ id: req.params.id })
      .update({ is_active: true, updated_at: new Date() })
      .returning('*')

    await auditLog(req.params.id, req.user.id, 'RESTORE', 'company', req.params.id, { name: company.name }, req.ip)

    return successResponse(res, company, 'Company restored')
  } catch (err) { next(err) }
})

/* ── POST /companies/:id/switch — change the active company ───────────────
 * Verifies membership, then issues a fresh token scoped to the new
 * company. The client must swap in the new token — subsequent requests
 * (and every existing route, unchanged) will then be scoped to the new
 * company automatically via req.companyId. */
router.post('/:id/switch', async (req, res, next) => {
  try {
    const membership = await db('user_companies')
      .where({ user_id: req.user.id, company_id: req.params.id })
      .first()
    if (!membership) throw new AppError('You do not have access to this company', 403)

    const company = await db('companies').where({ id: req.params.id }).first()
    if (!company) throw new AppError('Company not found', 404)
    if (company.is_active === false) throw new AppError('This company has been deactivated', 403)

    const user = await db('users').where({ id: req.user.id }).first()
    if (!user || !user.is_active) throw new AppError('Account not found or disabled', 401)

    await db('users').where({ id: req.user.id }).update({ last_active_company_id: company.id })

    const token   = signToken({ userId: user.id, email: user.email, role: user.role, companyId: company.id })
    const refresh_token = signRefresh(user.id)
    const { password_hash: _, ...safeUser } = user

    await auditLog(company.id, req.user.id, 'SWITCH_COMPANY', 'company', company.id, null, req.ip)

    return successResponse(res, { token, refresh_token, user: safeUser, company }, 'Switched company')
  } catch (err) { next(err) }
})

/* ── PUT /companies/:id/default — mark as this user's default company ───── */
router.put('/:id/default', async (req, res, next) => {
  try {
    const membership = await db('user_companies')
      .where({ user_id: req.user.id, company_id: req.params.id })
      .first()
    if (!membership) throw new AppError('You do not have access to this company', 403)

    await db.transaction(async (trx) => {
      await trx('user_companies').where({ user_id: req.user.id }).update({ is_default: false })
      await trx('user_companies').where({ user_id: req.user.id, company_id: req.params.id }).update({ is_default: true })
    })

    return successResponse(res, { id: req.params.id }, 'Default company updated')
  } catch (err) { next(err) }
})

module.exports = router
