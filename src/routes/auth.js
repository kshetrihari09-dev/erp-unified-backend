/**
 * auth.js — Unified multi-channel authentication route
 *
 * OTP delivery methods:
 *   - whatsapp  via WhatsApp Business API
 *   - email     via SMTP / SendGrid / Mailgun
 *   - sms       via Sparrow / Aakash / Twilio SMS (legacy, preserved)
 *
 * Flows:
 *   POST /auth/send-otp    accept { method, phone?, email?, purpose }
 *   POST /auth/verify-otp  accept { method, destination, otp, purpose }
 *   POST /auth/register    complete signup (phone_token or email_token or legacy)
 *   POST /auth/login       legacy email+password (preserved, no breaking change)
 *   POST /auth/add-contact authenticated users add/verify phone or email
 *   + all existing routes unchanged
 */

const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { v4: uuid } = require('uuid')
const db      = require('../db/knex')
const AuditLogger  = require('../utils/auditLogger')
const { authenticate } = require('../middleware/index')
const OTPService      = require('../services/otpService')
const smsService      = require('../services/smsService')
const whatsappService = require('../services/whatsappService')
const emailService    = require('../services/emailService')
const { resolveActiveCompanyId } = require('../services/companyContext')
const { signStepUpToken, STEP_UP_TTL_SECONDS } = require('../utils/stepUp')
const { verifyStepUpCredential } = require('../utils/pinAuth')
const { issueRefreshToken, rotateRefreshToken, revokeToken, revokeAllForUser } = require('../utils/refreshTokens')

const otpService = new OTPService(db)

/* ── Shared error class ─────────────────────────────────────────────────── */
class AppError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status }
}

/* ── JWT helpers ─────────────────────────────────────────────────────────── */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' })
}
/**
 * Issues a new server-tracked refresh-token session (see utils/refreshTokens.js)
 * and returns just the raw bearer string — the DB row (hash, family, expiry)
 * is what actually backs revocation/rotation/reuse-detection, the JWT-style
 * signing this used to do is gone entirely.
 */
async function signRefresh(userId, req) {
  const { raw } = await issueRefreshToken({ userId, ip: req?.ip, userAgent: req?.headers?.['user-agent'] })
  return raw
}

/* ── Validation helpers ──────────────────────────────────────────────────── */
function normalizePhone(raw) {
  const c = raw.replace(/[\s\-().]/g, '')
  if (/^\+977[0-9]{9,10}$/.test(c)) return c
  if (/^977[0-9]{9,10}$/.test(c))   return '+' + c
  if (/^9[6-9][0-9]{8}$/.test(c))   return '+977' + c
  if (/^0[0-9]{9}$/.test(c))        return '+977' + c.slice(1)
  if (c.startsWith('+'))             return c
  return null
}

function validatePhone(raw) {
  if (!raw?.trim()) return { valid: false, message: 'Phone number is required' }
  const normalized = normalizePhone(raw.trim())
  if (!normalized)  return { valid: false, message: 'Invalid phone number. Use format: 98XXXXXXXX or +9779XXXXXXXX' }
  return { valid: true, normalized }
}

function validateEmail(raw) {
  if (!raw?.trim()) return { valid: false, message: 'Email is required' }
  const norm = raw.toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return { valid: false, message: 'Invalid email address' }
  return { valid: true, normalized: norm }
}

function maskDestination(dest) {
  if (dest.includes('@')) {
    const [local, domain] = dest.split('@')
    return local.slice(0, 2) + '***@' + domain
  }
  return dest.replace(/(\+\d{3})(\d{2})\d{5}(\d{3})/, '$1 $2*****$3')
}

/* ── OTP delivery dispatcher ─────────────────────────────────────────────── */
async function dispatchOTP(method, destination, otp, userName = '') {
  switch (method) {
    case 'whatsapp':
      return whatsappService.sendOTP(destination, otp)
    case 'email':
      return emailService.sendOTP(destination, otp, userName)
    case 'sms':
    default:
      return smsService.sendOTP(destination, otp)
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   POST /auth/send-otp
   Body: { method: 'whatsapp'|'email'|'sms', phone?, email?, purpose? }
═══════════════════════════════════════════════════════════════════════════ */
router.post('/send-otp', async (req, res, next) => {
  try {
    const {
      method   = 'whatsapp',
      phone,
      email,
      purpose  = 'signup',
    } = req.body

    /* ── validate method ─────────────────────────────────────────────────── */
    const validMethods = ['whatsapp', 'email', 'sms']
    if (!validMethods.includes(method)) {
      throw new AppError(`Invalid method. Must be one of: ${validMethods.join(', ')}`, 400)
    }

    const validPurposes = ['signup', 'login', 'add_contact']
    if (!validPurposes.includes(purpose)) {
      throw new AppError(`Invalid purpose. Must be one of: ${validPurposes.join(', ')}`, 400)
    }

    /* ── resolve destination ─────────────────────────────────────────────── */
    let destination, userId = null

    if (method === 'email') {
      const emailCheck = validateEmail(email)
      if (!emailCheck.valid) throw new AppError(emailCheck.message, 400)
      destination = emailCheck.normalized

      if (purpose === 'signup') {
        const existing = await db('users').where({ email: destination }).first()
        if (existing) throw new AppError('An account with this email already exists. Please log in.', 409)
      }
      if (purpose === 'login') {
        const user = await db('users').where({ email: destination }).first()
        // Deliberately generic from here on regardless of whether the
        // account exists, is disabled, or is unverified — a distinguishable
        // response for each case lets an attacker enumerate which emails
        // have accounts on this system. If the account is real, active,
        // and eligible, userId is set and an OTP actually goes out below;
        // otherwise the code silently no-ops but still returns the same
        // generic success response.
        if (user && user.is_active) userId = user.id
      }
    } else {
      // whatsapp or sms — needs phone
      const phoneCheck = validatePhone(phone)
      if (!phoneCheck.valid) throw new AppError(phoneCheck.message, 400)
      destination = phoneCheck.normalized

      if (purpose === 'signup') {
        const existing = await db('users').where({ phone: destination }).first()
        if (existing) throw new AppError('This phone number is already registered. Please log in.', 409)
      }
      if (purpose === 'login') {
        const user = await db('users').where({ phone: destination }).first()
        // Same generic-response reasoning as the email branch above.
        if (user && user.is_active && user.phone_verified) userId = user.id
      }
    }

    /* ── rate limit ──────────────────────────────────────────────────────── */
    const rateCheck = await otpService.checkRateLimit(destination)
    if (!rateCheck.allowed) {
      const resetStr = rateCheck.resetAt
        ? ` Try again after ${new Date(rateCheck.resetAt).toLocaleTimeString()}.`
        : ''
      throw new AppError(`Too many OTP requests (max 3/hour).${resetStr}`, 429)
    }

    /* ── generate & send ─────────────────────────────────────────────────── */
    const code = await otpService.create(destination, method, purpose, req.ip, userId)
    const result = await dispatchOTP(method, destination, code)

    if (!result.success) {
      console.error(`[send-otp] ${method} delivery failed:`, result.error)
      if (process.env.NODE_ENV === 'production') {
        throw new AppError('Failed to send OTP. Please try again or choose a different method.', 503)
      }
    }

    const devPayload = process.env.NODE_ENV !== 'production' ? { _dev_otp: code } : {}

    return res.json({
      success: true,
      message: `OTP sent via ${method} to ${maskDestination(destination)}`,
      data: {
        method,
        destination: maskDestination(destination),
        expires_in:  300,
        ...devPayload,
      },
    })
  } catch (err) { next(err) }
})

/* ═══════════════════════════════════════════════════════════════════════════
   POST /auth/verify-otp
   Body: { method, destination (phone or email), otp, purpose? }
═══════════════════════════════════════════════════════════════════════════ */
router.post('/verify-otp', async (req, res, next) => {
  try {
    const {
      method      = 'whatsapp',
      destination,
      phone,         // legacy alias
      otp,
      purpose     = 'signup',
    } = req.body

    if (!otp?.trim())             throw new AppError('OTP is required', 400)
    if (!/^\d{6}$/.test(otp.trim())) throw new AppError('OTP must be exactly 6 digits', 400)

    // Accept destination OR phone/email aliases
    let normalizedDest = destination?.trim()
    if (!normalizedDest) {
      if (method === 'email') {
        const emailCheck = validateEmail(req.body.email)
        if (!emailCheck.valid) throw new AppError(emailCheck.message, 400)
        normalizedDest = emailCheck.normalized
      } else {
        const phoneCheck = validatePhone(phone)
        if (!phoneCheck.valid) throw new AppError(phoneCheck.message, 400)
        normalizedDest = phoneCheck.normalized
      }
    }

    const result = await otpService.verify(normalizedDest, otp.trim(), purpose)
    if (!result.valid) throw new AppError(result.reason, 400)

    /* ── login flow: issue tokens immediately ────────────────────────────── */
    if (purpose === 'login') {
      const user = method === 'email'
        ? await db('users').where({ email: normalizedDest }).first()
        : await db('users').where({ phone: normalizedDest }).first()

      if (!user || !user.is_active) throw new AppError('Account not found or disabled', 401)

      const companyId = await resolveActiveCompanyId(user)
      await db('users').where({ id: user.id }).update({ last_login_at: new Date(), last_active_company_id: companyId })
      const company = await db('companies').where({ id: companyId }).first()
      const token   = signToken({ userId: user.id, email: user.email, role: user.role, companyId })
      const refresh_token = await signRefresh(user.id, req)
      const { password_hash: _, ...safeUser } = user

      await AuditLogger.log(db, {
        companyId, userId: user.id,
        action: `LOGIN_OTP_${method.toUpperCase()}`,
        entityType: 'auth', entityId: user.id, ipAddress: req.ip,
      })

      return res.json({
        success: true,
        message: 'Login successful',
        data: { token, refresh_token, user: safeUser, company, flow: 'login', method },
      })
    }

    /* ── signup / add_contact flow: return short-lived verified token ─────── */
    // Encode method in token so register knows which field to mark verified
    const verifiedToken = jwt.sign(
      { destination: normalizedDest, method, purpose, verified: true },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    )

    return res.json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        destination: normalizedDest,
        method,
        verified: true,
        purpose,
        verified_token: verifiedToken,
        // legacy alias
        phone_token: verifiedToken,
      },
    })
  } catch (err) { next(err) }
})

/* ═══════════════════════════════════════════════════════════════════════════
   POST /auth/register
   Supports:
     A) OTP-verified signup  — requires verified_token from verify-otp
     B) Legacy email signup  — requires email + password (backward compat)
═══════════════════════════════════════════════════════════════════════════ */
router.post('/register', async (req, res, next) => {
  try {
    const {
      verified_token,
      phone_token,          // legacy alias
      name,
      password,
      phone,
      email,
      company_name, company_address, company_phone,
      pan_no, registration_no, date_system, invoice_prefix, currency,
    } = req.body

    if (!name?.trim())         throw new AppError('Full name is required', 400)
    if (!company_name?.trim()) throw new AppError('Company name is required', 400)

    const token = verified_token || phone_token

    /* ── A: OTP-verified signup ──────────────────────────────────────────── */
    if (token) {
      let payload
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET)
      } catch {
        throw new AppError('Verification token is invalid or expired. Please verify again.', 400)
      }

      if (!payload.verified || payload.purpose !== 'signup') {
        throw new AppError('Invalid verification token', 400)
      }

      const { destination, method } = payload
      const isEmail = method === 'email'

      // Duplicate guard (race condition)
      if (isEmail) {
        const ex = await db('users').where({ email: destination }).first()
        if (ex) throw new AppError('This email is already registered', 409)
      } else {
        const ex = await db('users').where({ phone: destination }).first()
        if (ex) throw new AppError('This phone number is already registered', 409)
      }

      let password_hash = null
      if (password) {
        if (password.length < 8) throw new AppError('Password must be at least 8 characters', 400)
        password_hash = await bcrypt.hash(password, 12)
      }

      await db.transaction(async (trx) => {
        const companyId = uuid()
        await trx('companies').insert({
          id:              companyId,
          name:            company_name.trim(),
          address:         company_address?.trim() || null,
          phone:           company_phone?.trim()   || (!isEmail ? destination : null),
          pan_no:          pan_no?.trim()          || null,
          registration_no: registration_no?.trim() || null,
          date_system:     date_system  || 'BS',
          invoice_prefix:  (invoice_prefix || 'INV').toUpperCase().slice(0, 6),
          currency:        currency || 'NPR',
          vat_percent:     13,
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

        // Pre-check email_verified column existence OUTSIDE the transaction.
        // A failed INSERT inside a PG transaction aborts the whole transaction —
        // try/catch cannot rescue it. We must know the schema before we insert.
        const hasEmailVerified = await db.schema.hasColumn('users', 'email_verified')

        const userId = uuid()
        const userRecord = {
          id:                   userId,
          company_id:           companyId,
          name:                 name.trim(),
          password_hash,
          role:                 'owner',
          can_post_vouchers:    true,
          can_approve_vouchers: true,
          can_lock_periods:     true,
          can_reverse_entries:  true,
          is_active:            true,
          phone_verified:       false,
        }

        if (hasEmailVerified) {
          userRecord.email_verified = false
        }

        if (isEmail) {
          userRecord.email = destination
          if (hasEmailVerified) userRecord.email_verified = true
          userRecord.phone = phone?.trim() || null
        } else {
          // Phone-only signup: email column is NOT NULL in the schema.
          // Use a unique placeholder so the constraint is satisfied.
          // The user can add a real email later from their profile.
          const cleanPhone = destination.replace(/[^0-9]/g, '')
          userRecord.phone          = destination
          userRecord.phone_verified = true
          userRecord.email          = email?.toLowerCase().trim() ||
                                      `phone_${cleanPhone}@placeholder.local`
        }

        await trx('users').insert(userRecord)

        // Multi-company membership — this is the user's first company, so
        // it's also their default one.
        await trx('user_companies').insert({
          id: uuid(), user_id: userId, company_id: companyId, is_default: true,
        })
        await trx('users').where({ id: userId }).update({ last_active_company_id: companyId })

        const user    = await trx('users').where({ id: userId }).first()
        const company = await trx('companies').where({ id: companyId }).first()
        const jwtTok  = signToken({ userId, email: user.email, role: user.role, companyId })
        const refresh = await signRefresh(userId, req)
        const { password_hash: _, ...safeUser } = user

        await AuditLogger.log(db, {
          companyId, userId,
          action: `REGISTER_OTP_${method.toUpperCase()}`,
          entityType: 'auth', entityId: userId, ipAddress: req.ip,
        })

        return res.status(201).json({
          success: true,
          message: 'Account created successfully',
          data: { token: jwtTok, refresh_token: refresh, user: safeUser, company },
        })
      })
      return
    }

    /* ── B: Legacy email + password signup ───────────────────────────────── */
    if (!email?.trim())        throw new AppError('Email is required', 400)
    if (!password)             throw new AppError('Password is required', 400)
    if (password.length < 8)  throw new AppError('Password must be at least 8 characters', 400)

    const existing = await db('users').where({ email: email.toLowerCase().trim() }).first()
    if (existing) throw new AppError('An account with this email already exists', 409)

    const password_hash = await bcrypt.hash(password, 12)

    await db.transaction(async (trx) => {
      const companyId = uuid()
      await trx('companies').insert({
        id:              companyId,
        name:            company_name.trim(),
        address:         company_address?.trim() || null,
        phone:           company_phone?.trim()   || null,
        pan_no:          pan_no?.trim()          || null,
        registration_no: registration_no?.trim() || null,
        date_system:     date_system  || 'BS',
        invoice_prefix:  (invoice_prefix || 'INV').toUpperCase().slice(0, 6),
        currency:        currency || 'NPR',
        vat_percent:     13,
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

      const hasEmailVerifiedB = await db.schema.hasColumn('users', 'email_verified')
      const userId = uuid()
      const userRecord = {
        id: userId, company_id: companyId,
        name: name.trim(), email: email.toLowerCase().trim(), password_hash,
        phone: phone?.trim() || null, phone_verified: false,
        role: 'owner', can_post_vouchers: true, can_approve_vouchers: true,
        can_lock_periods: true, can_reverse_entries: true, is_active: true,
      }
      if (hasEmailVerifiedB) userRecord.email_verified = false
      await trx('users').insert(userRecord)

      // Multi-company membership — this is the user's first company, so
      // it's also their default one.
      await trx('user_companies').insert({
        id: uuid(), user_id: userId, company_id: companyId, is_default: true,
      })
      await trx('users').where({ id: userId }).update({ last_active_company_id: companyId })

      const user    = await trx('users').where({ id: userId }).first()
      const company = await trx('companies').where({ id: companyId }).first()
      const tok     = signToken({ userId, email: user.email, role: user.role, companyId })
      const refresh = await signRefresh(userId, req)
      const { password_hash: _, ...safeUser } = user

      return res.status(201).json({
        success: true, message: 'Account created',
        data: { token: tok, refresh_token: refresh, user: safeUser, company },
      })
    })
  } catch (err) { next(err) }
})

/* ── POST /auth/add-contact — add/verify phone or email while authenticated ─ */
router.post('/add-contact', authenticate, async (req, res, next) => {
  try {
    const { verified_token, phone_token } = req.body
    const token = verified_token || phone_token
    if (!token) throw new AppError('verified_token is required', 400)

    let payload
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET)
    } catch {
      throw new AppError('Verification token is invalid or expired', 400)
    }

    if (!payload.verified || payload.purpose !== 'add_contact') {
      throw new AppError('Invalid verification token', 400)
    }

    const { destination, method } = payload
    const isEmail = method === 'email'
    const updates = {}

    if (isEmail) {
      const clash = await db('users').where({ email: destination }).whereNot({ id: req.user.id }).first()
      if (clash) throw new AppError('This email is already linked to another account', 409)
      updates.email          = destination
      try { updates.email_verified = true } catch { /* column may not exist */ }
    } else {
      const clash = await db('users').where({ phone: destination }).whereNot({ id: req.user.id }).first()
      if (clash) throw new AppError('This phone number is already linked to another account', 409)
      updates.phone          = destination
      updates.phone_verified = true
    }

    await db('users').where({ id: req.user.id }).update({ ...updates, updated_at: new Date() })

    await AuditLogger.log(db, {
      companyId: req.companyId, userId: req.user.id,
      action: `ADD_CONTACT_${method.toUpperCase()}`,
      entityType: 'auth', entityId: req.user.id, ipAddress: req.ip,
    })

    return res.json({
      success: true,
      message: `${isEmail ? 'Email' : 'Phone'} verified and linked to your account`,
    })
  } catch (err) { next(err) }
})

/* ── POST /auth/add-phone (legacy alias) ─────────────────────────────────── */
router.post('/add-phone', authenticate, async (req, res, next) => {
  req.body.verified_token = req.body.verified_token || req.body.phone_token
  if (!req.body.verified_token) {
    return next(new AppError('phone_token is required', 400))
  }
  // Decode and re-sign with add_contact purpose if it was add_phone purpose
  try {
    const p = jwt.verify(req.body.verified_token, process.env.JWT_SECRET)
    if (p.purpose === 'add_phone') {
      req.body.verified_token = jwt.sign(
        { ...p, purpose: 'add_contact' }, process.env.JWT_SECRET, { expiresIn: '15m' }
      )
    }
  } catch { /* let add-contact handler report the error */ }
  req.url = '/add-contact'
  router.handle(req, res, next)
})

/* ═══════════════════════════════════════════════════════════════════════════
   EXISTING ROUTES — NO BREAKING CHANGES
═══════════════════════════════════════════════════════════════════════════ */

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) throw new AppError('Email and password required', 400)
    const user = await db('users').where({ email: email.toLowerCase().trim() }).first()
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      throw new AppError('Invalid email or password', 401)
    }
    if (!user.is_active) throw new AppError('Account is disabled', 403)
    const companyId = await resolveActiveCompanyId(user)
    await db('users').where({ id: user.id }).update({ last_login_at: new Date(), last_active_company_id: companyId })
    const company     = await db('companies').where({ id: companyId }).first()
    const token       = signToken({ userId: user.id, email: user.email, role: user.role, companyId })
    const refresh_token = await signRefresh(user.id, req)
    const { password_hash: _, ...safeUser } = user
    await AuditLogger.log(db, { companyId, userId: user.id, action: 'LOGIN', entityType: 'auth', entityId: user.id, ipAddress: req.ip })
    return res.json({ success: true, data: { token, refresh_token, user: safeUser, company } })
  } catch (err) { next(err) }
})

router.post('/logout', authenticate, async (req, res) => {
  // Revoke the specific session's refresh token so a copy of it (already
  // leaked, or retained by a "retried" client) can't keep minting new
  // access tokens after the user explicitly signed out. Best-effort: a
  // missing/already-invalid token here just means there's nothing to
  // revoke, never a reason to fail the logout itself.
  if (req.body?.refresh_token) {
    await revokeToken(req.body.refresh_token, 'logout').catch(() => {})
  }
  await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'LOGOUT', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
  return res.json({ success: true, message: 'Logged out' })
})

/* ── POST /auth/revoke-sessions ───────────────────────────────────────────
 * "Log out everywhere" — revokes every refresh-token session for the
 * current user (including the one that made this request; the caller's
 * own access token remains valid until it naturally expires, since access
 * tokens are short-lived and not tracked server-side, but no session will
 * be able to silently refresh past that point). */
router.post('/revoke-sessions', authenticate, async (req, res, next) => {
  try {
    await revokeAllForUser(req.user.id, 'user_requested')
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'REVOKE_ALL_SESSIONS', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
    return res.json({ success: true, message: 'All sessions have been signed out.' })
  } catch (err) { next(err) }
})

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user    = await db('users').where({ id: req.user.id }).first()
    const company = await db('companies').where({ id: req.companyId }).first()
    if (!user) throw new AppError('User not found', 404)
    const { password_hash: _, pin_hash: __, pin_failed_attempts: ___, ...safeUser } = user
    return res.json({ success: true, data: { user: { ...safeUser, hasPin: !!user.pin_hash }, company } })
  } catch (err) { next(err) }
})

/* ── POST /auth/verify-password ─────────────────────────────────────────────
 * Step-up re-authentication for sensitive actions (voucher edit, payment
 * mode changes, invoice cancellation, etc — see middleware/index.js
 * requireSensitiveConfirm / requireStepUp).
 *
 * Accepts EITHER `{ password }` (the existing behavior, unchanged for
 * any caller that doesn't know about PINs yet) OR `{ pin }` (the new
 * preferred 6-digit Security PIN). Confirms the CURRENT session's user
 * knows one of their own credentials — does not log the user in, issue
 * new session tokens, or touch last_login_at.
 *
 * On success, returns a short-lived `stepUpToken` (see utils/stepUp.js)
 * the frontend can attach as `X-Step-Up-Token` on subsequent sensitive
 * requests for the next ~10 minutes, instead of re-prompting for a
 * credential on every single one — see requirement: no permanent
 * "verified" flag, but also no re-asking every request.
 *
 * Per-account lockout after repeated failures is handled by
 * verifyStepUpCredential() (utils/pinAuth.js) — shared with
 * /auth/security-pin so there's exactly one lockout implementation.
 */
router.post('/verify-password', authenticate, async (req, res, next) => {
  try {
    const { password, pin, action } = req.body || {}
    if (!password && !pin) throw new AppError('Password or PIN is required', 400)

    const result = await verifyStepUpCredential({
      userId: req.user.id, companyId: req.companyId, pin, password, ip: req.ip,
    })
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message, needsPinSetup: result.needsPinSetup })
    }

    // `action`, when the caller knows which specific mandatory
    // (requireStepUp) action it's about to perform, scopes the token to
    // just that action (see utils/stepUp.js). Omitted → a general-purpose
    // token, valid for any optional/toggleable sensitive action but not
    // for a strict one.
    const stepUpToken = signStepUpToken({ userId: req.user.id, companyId: req.companyId, action })
    return res.json({
      success: true,
      message: 'Verified',
      data: { stepUpToken, expiresIn: STEP_UP_TTL_SECONDS },
    })
  } catch (err) { next(err) }
})

/* ── POST /auth/security-pin ──────────────────────────────────────────────
 * Sets or changes the acting user's 6-digit Security PIN, used for
 * step-up verification instead of re-typing the full account password.
 *
 * Always requires the CURRENT account password first (even when setting
 * a PIN for the very first time) — never the PIN itself, since a user
 * setting their first PIN by definition doesn't have one yet, and a
 * user CHANGING an existing PIN shouldn't be able to do so with only
 * something that may have been shoulder-surfed. This mirrors how
 * changing a password already requires the current one
 * (PUT /auth/change-password below).
 */
router.post('/security-pin', authenticate, async (req, res, next) => {
  try {
    const { pin, current_password } = req.body || {}
    if (!current_password) throw new AppError('Your current account password is required to set a Security PIN', 400)
    if (!/^\d{6}$/.test(String(pin || ''))) throw new AppError('PIN must be exactly 6 digits', 400)

    const user = await db('users').where({ id: req.user.id }).first()
    if (!user?.password_hash) throw new AppError('No password is set on this account.', 400)
    const validPassword = await bcrypt.compare(current_password, user.password_hash)
    if (!validPassword) {
      await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'PIN_SETUP_FAILED', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
      return res.status(401).json({ success: false, message: 'Incorrect password' })
    }

    const pin_hash = await bcrypt.hash(String(pin), 12)
    await db('users').where({ id: req.user.id }).update({
      pin_hash, pin_set_at: new Date(), pin_failed_attempts: 0, pin_locked_until: null,
    })
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: user.pin_hash ? 'PIN_CHANGED' : 'PIN_CREATED', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })

    // Setting/changing the PIN counts as having just step-up-verified —
    // issue a token immediately so the user isn't asked to re-verify a
    // second time right after proving their password moments ago.
    const stepUpToken = signStepUpToken({ userId: req.user.id, companyId: req.companyId })
    return res.json({ success: true, message: 'Security PIN saved', data: { stepUpToken, expiresIn: STEP_UP_TTL_SECONDS } })
  } catch (err) { next(err) }
})

router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body
    if (!refresh_token) throw new AppError('Refresh token required', 400)

    const result = await rotateRefreshToken({ token: refresh_token, ip: req.ip, userAgent: req.headers['user-agent'] })
    if (!result.ok) {
      if (result.code === 'REUSE_DETECTED') {
        // Don't distinguish this from a normal invalid/expired token in the
        // response — no need to tell a possible attacker their reuse was
        // caught, and the client-side handling is identical either way
        // (force a full re-login). The family-wide revocation already
        // happened inside rotateRefreshToken.
        console.warn('[auth] refresh token reuse detected for user', result.userId)
      }
      return res.status(401).json({ success: false, code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' })
    }

    const user = await db('users').where({ id: result.userId }).first()
    if (!user || !user.is_active) throw new AppError('User not found or disabled', 401)
    // Preserve whatever company the user currently has active (survives a
    // company switch across a silent token refresh) rather than resetting
    // back to their default company on every refresh.
    const companyId = await resolveActiveCompanyId(user)
    const token = signToken({ userId: user.id, email: user.email, role: user.role, companyId })
    return res.json({ success: true, data: { token, refresh_token: result.raw } })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' })
    }
    next(err)
  }
})

router.put('/change-password', authenticate, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body
    if (!current_password || !new_password) throw new AppError('Both passwords required', 400)
    if (new_password.length < 8) throw new AppError('New password must be at least 8 characters', 400)
    const user  = await db('users').where({ id: req.user.id }).first()
    if (!user.password_hash) throw new AppError('Your account uses OTP-only login. Use Settings to set a password.', 400)
    const valid = await bcrypt.compare(current_password, user.password_hash)
    if (!valid) throw new AppError('Current password is incorrect', 400)
    await db('users').where({ id: req.user.id }).update({ password_hash: await bcrypt.hash(new_password, 12) })
    // A stolen refresh token issued before the password change must not
    // keep working after it — revoke every session and force re-login
    // everywhere (this device included; it'll simply mint a fresh pair
    // via the normal login flow the UI already redirects to on a 401).
    await revokeAllForUser(req.user.id, 'password_changed').catch(() => {})
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'CHANGE_PASSWORD', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
    return res.json({ success: true, message: 'Password changed successfully' })
  } catch (err) { next(err) }
})

/* ── Chart of Accounts seeder (unchanged) ───────────────────────────────── */
async function seedDefaultAccounts(trx, companyId) {
  const ids = {}
  const accounts = [
    { key:'G_ASSET',   code:'1000', name:'Current Assets',       type:'asset',     sub_type:null,          normal_balance:'debit',  is_group:true,  is_system:true  },
    { key:'CASH',      code:'1001', name:'Cash in Hand',          type:'asset',     sub_type:'cash',        normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'BANK',      code:'1002', name:'Bank Account',          type:'asset',     sub_type:'bank',        normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'AR',        code:'1100', name:'Accounts Receivable',   type:'asset',     sub_type:'receivable',  normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'INVENTORY', code:'1200', name:'Inventory / Stock',     type:'asset',     sub_type:'inventory',   normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'TAX_IN',    code:'1300', name:'VAT Input (Receivable)',type:'asset',     sub_type:'tax_input',   normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'G_LIAB',    code:'2000', name:'Current Liabilities',   type:'liability', sub_type:null,          normal_balance:'credit', is_group:true,  is_system:true  },
    { key:'AP',        code:'2001', name:'Accounts Payable',      type:'liability', sub_type:'payable',     normal_balance:'credit', is_group:false, is_system:true  },
    { key:'TAX_OUT',   code:'2100', name:'VAT Output (Payable)',  type:'liability', sub_type:'tax_payable', normal_balance:'credit', is_group:false, is_system:true  },
    { key:'G_EQUITY',  code:'3000', name:"Owner's Equity",        type:'equity',    sub_type:null,          normal_balance:'credit', is_group:true,  is_system:true  },
    { key:'CAPITAL',   code:'3001', name:'Capital Account',       type:'equity',    sub_type:'capital',     normal_balance:'credit', is_group:false, is_system:true  },
    { key:'RETAINED',  code:'3100', name:'Retained Earnings',     type:'equity',    sub_type:'retained',    normal_balance:'credit', is_group:false, is_system:true  },
    { key:'G_INCOME',  code:'4000', name:'Revenue',               type:'income',    sub_type:null,          normal_balance:'credit', is_group:true,  is_system:true  },
    { key:'SALES',     code:'4001', name:'Sales Revenue',         type:'income',    sub_type:'sales',       normal_balance:'credit', is_group:false, is_system:true  },
    { key:'OTHER_INC', code:'4100', name:'Other Income',          type:'income',    sub_type:'other',       normal_balance:'credit', is_group:false, is_system:false },
    { key:'G_EXP',     code:'5000', name:'Operating Expenses',    type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:true,  is_system:true  },
    { key:'COGS',      code:'5001', name:'Cost of Goods Sold',    type:'expense',   sub_type:'cogs',        normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'PURCHASE',  code:'5100', name:'Purchase Expense',      type:'expense',   sub_type:'purchase',    normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'SALARY',    code:'5101', name:'Salary Expense',        type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:false, is_system:false },
    { key:'RENT',      code:'5102', name:'Rent Expense',          type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:false, is_system:false },
    { key:'UTILITY',   code:'5103', name:'Utility Expense',       type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:false, is_system:false },
    { key:'DISC_GIVEN',code:'5104', name:'Discount Allowed',      type:'expense',   sub_type:'discount_expense', normal_balance:'debit',  is_group:false, is_system:false },
    { key:'DISC_RECD', code:'4101', name:'Discount Received',     type:'income',    sub_type:'discount_income',  normal_balance:'credit', is_group:false, is_system:false },
  ]
  for (const { key, ...acc } of accounts) {
    const id = uuid()
    ids[key] = id
    await trx('accounts').insert({ id, company_id: companyId, is_active: true, ...acc })
  }
  const parentMap = {
    CASH:'G_ASSET', BANK:'G_ASSET', AR:'G_ASSET', INVENTORY:'G_ASSET', TAX_IN:'G_ASSET',
    AP:'G_LIAB', TAX_OUT:'G_LIAB',
    CAPITAL:'G_EQUITY', RETAINED:'G_EQUITY',
    SALES:'G_INCOME', OTHER_INC:'G_INCOME', DISC_RECD:'G_INCOME',
    COGS:'G_EXP', PURCHASE:'G_EXP', SALARY:'G_EXP', RENT:'G_EXP', UTILITY:'G_EXP', DISC_GIVEN:'G_EXP',
  }
  for (const [child, parent] of Object.entries(parentMap)) {
    if (ids[child] && ids[parent]) await trx('accounts').where({ id: ids[child] }).update({ parent_id: ids[parent] })
  }
  return ids
}

/* ── Engine Setup (account_defaults) seeder ────────────────────────────────
 * Auto-populates PostingEngine's Chart-of-Accounts role mapping so a brand
 * new company can post sales/purchase/payment vouchers immediately, with
 * no manual "Engine Setup" step required.
 *
 * IDEMPOTENT: only ever INSERTs rows that don't already exist
 * (`onConflict(['company_id','role']).ignore()`), so calling this again for
 * a company that already has some/all roles configured never overwrites a
 * setting the user (or a previous run) already set — matching the
 * "if setting exists, keep it; else create the default" rule.
 *
 * Rows created here are flagged is_default=true and remember their
 * originally-assigned account in default_account_id, so the Engine Setup
 * UI can show a "Default" badge and offer "Reset to Default" even after a
 * user changes the mapping later — without ever touching existing
 * transactions, journal entries, or ledger mappings.
 */
const ENGINE_SETUP_ROLE_MAP = {
  accounts_receivable: 'AR',
  accounts_payable:    'AP',
  sales_revenue:        'SALES',
  purchase_expense:     'PURCHASE',
  inventory:             'INVENTORY',
  cogs:                  'COGS',
  cash:                  'CASH',
  bank:                  'BANK',
  tax_payable:           'TAX_OUT',
  tax_input:             'TAX_IN',
  discount_given:        'DISC_GIVEN',
  discount_received:     'DISC_RECD',
}

async function seedAccountDefaults(trx, companyId, accountIds) {
  const rows = []
  for (const [role, key] of Object.entries(ENGINE_SETUP_ROLE_MAP)) {
    const accountId = accountIds[key]
    if (!accountId) continue // account wasn't created for some reason — skip, leave role unmapped
    rows.push({
      id:                 uuid(),
      company_id:         companyId,
      account_id:         accountId,
      role,
      description:        'Auto-assigned default during setup',
      is_active:           true,
      is_default:          true,
      default_account_id: accountId,
    })
  }
  if (rows.length === 0) return
  await trx('account_defaults')
    .insert(rows)
    .onConflict(['company_id', 'role'])
    .ignore()
}

module.exports = router
module.exports.seedDefaultAccounts  = seedDefaultAccounts
module.exports.seedAccountDefaults  = seedAccountDefaults
module.exports.signToken   = signToken
module.exports.signRefresh = signRefresh
