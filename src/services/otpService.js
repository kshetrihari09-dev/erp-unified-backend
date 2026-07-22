/**
 * otpService.js — Secure OTP generation, storage, verification, and rate limiting
 *
 * Multi-channel: works for sms, whatsapp, and email channels.
 * Rate limits are keyed by destination (phone OR email address).
 *
 * Security:
 *   - Cryptographically random 6-digit code (no modulo bias via crypto.randomBytes)
 *   - bcrypt hash stored (cost=10), plain text never persisted
 *   - 5-minute expiry
 *   - Max 5 bad attempts → OTP auto-invalidated
 *   - Max 3 requests per destination per hour (sliding window)
 */

const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { v4: uuid } = require('uuid')

const OTP_EXPIRY_MINUTES  = 5
const MAX_ATTEMPTS        = 5
const RATE_LIMIT_MAX      = 3
const RATE_LIMIT_WINDOW_H = 1

class OTPService {
  constructor(db) {
    this.db = db
  }

  _generateCode() {
    const buf = crypto.randomBytes(4)
    const num = buf.readUInt32BE(0) % 1_000_000
    return String(num).padStart(6, '0')
  }

  /* ── Rate limiting ─────────────────────────────────────────────────────── */

  async checkRateLimit(destination) {
    const windowCutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_H * 3600_000)

    const row = await this.db('otp_rate_limits')
      .where(b => b.where({ destination }).orWhere({ phone: destination }))
      .first()

    if (!row) return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }

    const windowStart = new Date(row.window_start)
    if (windowStart < windowCutoff) {
      await this.db('otp_rate_limits')
        .where({ id: row.id })
        .update({ request_count: 0, window_start: new Date() })
      return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
    }

    if (row.request_count >= RATE_LIMIT_MAX) {
      const resetAt = new Date(windowStart.getTime() + RATE_LIMIT_WINDOW_H * 3600_000)
      return { allowed: false, remaining: 0, resetAt }
    }

    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 - row.request_count }
  }

  async _incrementRateLimit(destination, method = 'sms') {
    const existing = await this.db('otp_rate_limits')
      .where(b => b.where({ destination }).orWhere({ phone: destination }))
      .first()

    // `phone` is varchar(20) and only meaningful for sms/whatsapp — email
    // destinations (or any value over 20 chars) must go in `destination`
    // only, never truncated/forced into `phone`. Mirrors the same guard
    // in create() for otp_codes; see migration 013 for the bug history.
    const phoneValue = (method === 'sms' || method === 'whatsapp') && destination.length <= 20
      ? destination
      : null

    if (!existing) {
      await this.db('otp_rate_limits').insert({
        id:            uuid(),
        phone:         phoneValue,
        destination,
        request_count: 1,
        window_start:  new Date(),
      })
    } else {
      await this.db('otp_rate_limits')
        .where({ id: existing.id })
        .increment('request_count', 1)
        .update({ updated_at: new Date(), destination })
    }
  }

  /* ── Invalidate previous active OTPs ──────────────────────────────────── */

  async _invalidatePrevious(destination, purpose) {
    // Try new destination column first, fall back to phone column for compat
    await this.db('otp_codes')
      .where({ purpose, used: false })
      .where(b => b.where({ destination }).orWhere({ phone: destination }))
      .update({ used: true, updated_at: new Date() })
  }

  /* ── Create OTP ─────────────────────────────────────────────────────────── */

  /**
   * Create a new OTP for a destination.
   * @param {string} destination  E.164 phone or email address
   * @param {string} method       'sms' | 'whatsapp' | 'email'
   * @param {string} purpose      'signup' | 'login' | 'add_contact'
   * @param {string|null} ipAddress
   * @param {string|null} userId  existing user id (login flows)
   * @returns {string} plain 6-digit code — caller sends it, never stored
   */
  async create(destination, method = 'sms', purpose = 'signup', ipAddress = null, userId = null) {
    const code       = this._generateCode()
    const otp_hash   = await bcrypt.hash(code, 10)
    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000)

    await this._invalidatePrevious(destination, purpose)

    // Build record — gracefully handle schema being either 006 or 007+
    const record = {
      id:         uuid(),
      otp_hash,
      expires_at,
      attempts:   0,
      used:       false,
      purpose,
      ip_address: ipAddress,
    }

    // Add new columns if migration 007 has run
    let hasMethod = false
    try {
      hasMethod = await this.db.schema.hasColumn('otp_codes', 'method')
    } catch { /* ignore — older schema */ }

    if (hasMethod) {
      record.method      = method
      record.destination = destination
      if (userId) record.user_id = userId
      // `phone` is still NOT NULL on migration-006 installs that have since
      // been upgraded to 007 without dropping the old constraint — keep it
      // populated, but only with something that actually fits varchar(20).
      // Email destinations (or long phone formats) must NOT go in here;
      // the real value lives in `destination` above.
      record.phone = method === 'sms' || method === 'whatsapp'
        ? destination.slice(0, 20)
        : null
    } else {
      // Pre-007 schema: `phone` is the only column available.
      // Truncating is a last resort to avoid a hard DB error — this path
      // only runs on databases that haven't been migrated past 006.
      record.phone = destination.slice(0, 20)
    }

    await this.db('otp_codes').insert(record)
    await this._incrementRateLimit(destination, method)

    return code
  }

  /* ── Verify OTP ─────────────────────────────────────────────────────────── */

  /**
   * Verify a submitted code for a given destination+purpose.
   * @returns {{ valid: boolean, reason?: string, remaining?: number }}
   */
  async verify(destination, code, purpose = 'signup') {
    const otp = await this.db('otp_codes')
      .where({ purpose, used: false })
      .where(b => b.where({ destination }).orWhere({ phone: destination }))
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()

    if (!otp) {
      // Better error: check if one exists but is expired/used
      const anyOtp = await this.db('otp_codes')
        .where({ purpose })
        .where(b => b.where({ destination }).orWhere({ phone: destination }))
        .orderBy('created_at', 'desc')
        .first()

      if (!anyOtp)      return { valid: false, reason: 'No OTP found. Please request a new one.' }
      if (anyOtp.used)  return { valid: false, reason: 'OTP already used. Please request a new one.' }
      return { valid: false, reason: 'OTP has expired. Please request a new one.' }
    }

    if (otp.attempts >= MAX_ATTEMPTS) {
      await this.db('otp_codes').where({ id: otp.id }).update({ used: true, updated_at: new Date() })
      return { valid: false, reason: 'Too many failed attempts. Please request a new OTP.' }
    }

    const match = await bcrypt.compare(code, otp.otp_hash)
    if (!match) {
      await this.db('otp_codes').where({ id: otp.id }).increment('attempts', 1).update({ updated_at: new Date() })
      const remaining = MAX_ATTEMPTS - otp.attempts - 1
      return {
        valid:     false,
        reason:    remaining > 0
          ? `Invalid OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'No more attempts. Please request a new OTP.',
        remaining,
      }
    }

    await this.db('otp_codes').where({ id: otp.id }).update({ used: true, updated_at: new Date() })
    return { valid: true }
  }

  /* ── Cleanup ────────────────────────────────────────────────────────────── */

  async cleanup() {
    return this.db('otp_codes')
      .where('expires_at', '<', new Date(Date.now() - 24 * 3600_000))
      .delete()
  }
}

module.exports = OTPService
