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

const otpService = new OTPService(db)

/* ── Shared error class ─────────────────────────────────────────────────── */
class AppError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status }
}

/* ── JWT helpers ─────────────────────────────────────────────────────────── */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' })
}
function signRefresh(userId) {
  return jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  )
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
        if (!user) throw new AppError('No account found with this email address.', 404)
        if (!user.is_active) throw new AppError('Account is disabled.', 403)
        userId = user.id
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
        if (!user) throw new AppError('No account found with this phone number.', 404)
        if (!user.phone_verified) throw new AppError('Phone not verified. Please complete signup.', 400)
        if (!user.is_active) throw new AppError('Account is disabled.', 403)
        userId = user.id
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

      await db('users').where({ id: user.id }).update({ last_login_at: new Date() })
      const company = await db('companies').where({ id: user.company_id }).first()
      const token   = signToken({ userId: user.id, email: user.email, role: user.role, companyId: user.company_id })
      const refresh_token = signRefresh(user.id)
      const { password_hash: _, ...safeUser } = user

      await AuditLogger.log(db, {
        companyId: user.company_id, userId: user.id,
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

        await seedDefaultAccounts(trx, companyId)

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

        const user    = await trx('users').where({ id: userId }).first()
        const company = await trx('companies').where({ id: companyId }).first()
        const jwtTok  = signToken({ userId, email: user.email, role: user.role, companyId })
        const refresh = signRefresh(userId)
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

      await seedDefaultAccounts(trx, companyId)

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

      const user    = await trx('users').where({ id: userId }).first()
      const company = await trx('companies').where({ id: companyId }).first()
      const tok     = signToken({ userId, email: user.email, role: user.role, companyId })
      const refresh = signRefresh(userId)
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
    await db('users').where({ id: user.id }).update({ last_login_at: new Date() })
    const company     = await db('companies').where({ id: user.company_id }).first()
    const token       = signToken({ userId: user.id, email: user.email, role: user.role, companyId: user.company_id })
    const refresh_token = signRefresh(user.id)
    const { password_hash: _, ...safeUser } = user
    await AuditLogger.log(db, { companyId: user.company_id, userId: user.id, action: 'LOGIN', entityType: 'auth', entityId: user.id, ipAddress: req.ip })
    return res.json({ success: true, data: { token, refresh_token, user: safeUser, company } })
  } catch (err) { next(err) }
})

router.post('/logout', authenticate, async (req, res) => {
  await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'LOGOUT', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
  return res.json({ success: true, message: 'Logged out' })
})

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user    = await db('users').where({ id: req.user.id }).first()
    const company = await db('companies').where({ id: req.companyId }).first()
    if (!user) throw new AppError('User not found', 404)
    const { password_hash: _, ...safeUser } = user
    return res.json({ success: true, data: { user: safeUser, company } })
  } catch (err) { next(err) }
})

router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body
    if (!refresh_token) throw new AppError('Refresh token required', 400)
    const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET)
    if (payload.type !== 'refresh') throw new AppError('Invalid refresh token', 401)
    const user = await db('users').where({ id: payload.userId }).first()
    if (!user || !user.is_active) throw new AppError('User not found or disabled', 401)
    const token = signToken({ userId: user.id, email: user.email, role: user.role, companyId: user.company_id })
    return res.json({ success: true, data: { token } })
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
    SALES:'G_INCOME', OTHER_INC:'G_INCOME',
    COGS:'G_EXP', PURCHASE:'G_EXP', SALARY:'G_EXP', RENT:'G_EXP', UTILITY:'G_EXP',
  }
  for (const [child, parent] of Object.entries(parentMap)) {
    if (ids[child] && ids[parent]) await trx('accounts').where({ id: ids[child] }).update({ parent_id: ids[parent] })
  }
  return ids
}

module.exports = router
module.exports.seedDefaultAccounts = seedDefaultAccounts
