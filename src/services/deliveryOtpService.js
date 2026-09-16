/**
 * services/deliveryOtpService.js — delivery OTP lifecycle.
 *
 * Every decision about whether a delivery may complete lives here. The
 * routes above it (routes/deliveryPartner.js, routes/adminCustomerOrders.js)
 * handle authentication and authorization; this file handles validity.
 * Nothing in the frontend ever computes any of it.
 *
 * Why not reuse services/otpService.js wholesale: that service is keyed
 * by *destination* (a phone number or email) and is built for "prove you
 * control this contact point before we log you in". A delivery OTP is
 * keyed by *order* — it must survive the customer changing their phone
 * number mid-delivery, must not collide with a login OTP the same person
 * is requesting at the same moment, and expires on a delivery clock (30
 * min), not a login clock (5 min). The security properties that matter
 * are copied deliberately (crypto-random code, bcrypt at rest, attempt
 * cap, previous-code invalidation, resend cooldown); the destination
 * keying is not.
 *
 * ── On expiry and slow deliveries (spec §5) ────────────────────────────
 * A code expires 30 minutes after it is issued. But a delivery running
 * long is normal, not suspicious, so an expired code on a still-active
 * out_for_delivery order is a soft failure: the rider is told it expired
 * and the resend cooldown is waived, so a fresh code is one tap away.
 * Expiry never strands a delivery; it just refuses to let a code from an
 * hour ago stay usable.
 */
'use strict'

const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const otpCrypto = require('../utils/otpCrypto')

const OTP_DIGITS              = 6
const OTP_EXPIRY_MINUTES      = 30
const MAX_ATTEMPTS            = 5
const LOCK_MINUTES            = 15
const RESEND_COOLDOWN_SECONDS = 60
const BCRYPT_ROUNDS           = 10

/* ── Code generation ──────────────────────────────────────────────────────
 * Rejection sampling, not `randomUInt32 % 1000000`. The naive modulo is
 * biased — 2^32 is not a multiple of 10^6, so the low ~967k values are
 * very slightly likelier than the rest. The bias is tiny, but discarding
 * the short tail costs nothing and makes the code uniform, which is the
 * property "cryptographically secure random" is actually claiming.
 *
 * Never derived from order id, customer id, phone, or any timestamp —
 * all of those are values a delivery partner can already see.
 */
function generateCode() {
  const range = 10 ** OTP_DIGITS
  const limit = Math.floor(0xFFFFFFFF / range) * range
  let n
  do {
    n = crypto.randomBytes(4).readUInt32BE(0)
  } while (n >= limit)
  return String(n % range).padStart(OTP_DIGITS, '0')
}

/* ── Small helpers ───────────────────────────────────────────────────── */

const isExpired = (order, now = new Date()) =>
  !order.delivery_otp_expires_at || new Date(order.delivery_otp_expires_at) <= now

const isLocked = (order, now = new Date()) =>
  !!order.delivery_otp_locked_until && new Date(order.delivery_otp_locked_until) > now

function secondsUntilResendAllowed(order, now = new Date()) {
  if (!order.delivery_otp_last_sent_at) return 0
  // An already-expired code means the rider is stuck through no fault of
  // their own — don't make them wait out a cooldown to get unstuck.
  if (isExpired(order, now)) return 0
  const elapsedMs = now - new Date(order.delivery_otp_last_sent_at)
  const remaining = Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000)
  return remaining > 0 ? remaining : 0
}

/**
 * The OTP fields that are safe to return to a DELIVERY PARTNER or STAFF.
 * Note what is absent: the code, the hash, and the ciphertext. A rider
 * knowing that a code exists and when it expires is operationally useful
 * and reveals nothing (spec §15/§19).
 */
function publicOtpState(order, now = new Date()) {
  const attempts = Number(order.delivery_otp_attempts || 0)
  return {
    otp_required:        order.fulfillment_type === 'delivery',
    otp_issued:          !!order.delivery_otp_hash,
    otp_verified:        !!order.delivery_otp_verified_at,
    otp_verified_at:     order.delivery_otp_verified_at || null,
    otp_expires_at:      order.delivery_otp_expires_at || null,
    otp_expired:         !!order.delivery_otp_hash && isExpired(order, now),
    otp_locked:          isLocked(order, now),
    otp_locked_until:    isLocked(order, now) ? order.delivery_otp_locked_until : null,
    otp_attempts:        attempts,
    otp_attempts_left:   Math.max(0, MAX_ATTEMPTS - attempts),
    resend_available_in: secondsUntilResendAllowed(order, now),
  }
}

/**
 * The code itself, for the CUSTOMER who owns this order and nobody else.
 * Callers must have already proven ownership. Returns null once the code
 * is verified, expired, or was never issued — there is no reason to keep
 * showing a code that can no longer do anything.
 */
function revealCodeForCustomer(order, now = new Date()) {
  if (!order.delivery_otp_secret) return null
  if (order.delivery_otp_verified_at) return null
  if (isExpired(order, now)) return null
  return otpCrypto.decrypt(order.delivery_otp_secret)
}

/* ── Issue / re-issue ─────────────────────────────────────────────────── */

/**
 * Build the column patch that issues a brand-new code for an order.
 *
 * Returns { code, patch }. The caller writes `patch` inside its own
 * transaction and is responsible for delivering `code` to the customer —
 * this function deliberately does not touch the database or the network,
 * so "generate" is atomic with whatever status change caused it.
 *
 * Issuing always fully supersedes any previous code: a new hash, a new
 * ciphertext, a fresh expiry, and — importantly — attempts and the lock
 * reset to zero (spec §13). There is no path where an old code stays
 * valid alongside a new one, because both live in the same single row.
 */
async function buildIssuePatch(now = new Date()) {
  const code = generateCode()
  return {
    code,
    patch: {
      delivery_otp_hash:         await bcrypt.hash(code, BCRYPT_ROUNDS),
      delivery_otp_secret:       otpCrypto.encrypt(code),
      delivery_otp_created_at:   now,
      delivery_otp_expires_at:   new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60_000),
      delivery_otp_last_sent_at: now,
      delivery_otp_attempts:     0,
      delivery_otp_locked_until: null,
      delivery_otp_verified_at:  null,
      updated_at:                now,
    },
  }
}

/* ── Verification ─────────────────────────────────────────────────────────
 * Pure decision function: given the order row as it exists right now and
 * a submitted code, decide what happens. It returns a patch for the
 * caller to apply rather than writing anything itself, so the caller can
 * apply it in the same transaction that flips the order to `delivered` —
 * which is what makes "verified" and "delivered" impossible to observe
 * separately (spec §16).
 *
 * Every failure returns a `code` for the client to branch on and a
 * `message` safe to show a rider verbatim. Nothing in any message says
 * which digits were right, how close the guess was, or whether a code
 * exists for some other order (spec §11/§26).
 */
async function evaluateVerification(order, submitted, now = new Date()) {
  // Already delivered — idempotent success, not an error (spec §27).
  if (order.delivery_otp_verified_at || order.status === 'delivered') {
    return { outcome: 'already_verified', patch: null }
  }

  const raw = String(submitted ?? '').trim()
  if (!new RegExp(`^\\d{${OTP_DIGITS}}$`).test(raw)) {
    // Malformed input is rejected before any comparison and — crucially —
    // without burning an attempt. Otherwise a rider fat-fingering five
    // characters into the box would lock their own delivery out.
    return {
      outcome: 'invalid_format',
      patch: null,
      code: 'OTP_INVALID_FORMAT',
      message: `Enter the ${OTP_DIGITS}-digit code from the customer.`,
    }
  }

  if (isLocked(order, now)) {
    return {
      outcome: 'locked',
      patch: null,
      code: 'OTP_LOCKED',
      message: 'Too many incorrect attempts. Please request a new OTP or contact the store.',
    }
  }

  if (!order.delivery_otp_hash) {
    return {
      outcome: 'not_issued',
      patch: null,
      code: 'OTP_NOT_ISSUED',
      message: 'No delivery code has been issued for this order yet.',
    }
  }

  if (isExpired(order, now)) {
    return {
      outcome: 'expired',
      patch: null,
      code: 'OTP_EXPIRED',
      message: 'Delivery OTP has expired.',
    }
  }

  const matches = await bcrypt.compare(raw, order.delivery_otp_hash)

  if (!matches) {
    const attempts = Number(order.delivery_otp_attempts || 0) + 1
    const nowLocked = attempts >= MAX_ATTEMPTS
    return {
      outcome: nowLocked ? 'locked_now' : 'incorrect',
      patch: {
        delivery_otp_attempts:     attempts,
        delivery_otp_locked_until: nowLocked ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
        updated_at:                now,
      },
      code: nowLocked ? 'OTP_LOCKED' : 'OTP_INCORRECT',
      message: nowLocked
        ? 'Too many incorrect attempts. Please request a new OTP or contact the store.'
        : 'Incorrect OTP. Please try again.',
      attempts_left: Math.max(0, MAX_ATTEMPTS - attempts),
    }
  }

  return {
    outcome: 'verified',
    patch: {
      delivery_otp_verified_at:  now,
      delivery_otp_attempts:     Number(order.delivery_otp_attempts || 0),
      delivery_otp_locked_until: null,
      // The ciphertext is dropped the instant the code has served its
      // purpose — a delivered order should not carry a recoverable code
      // around in the database forever.
      delivery_otp_secret:       null,
      updated_at:                now,
    },
  }
}

module.exports = {
  OTP_DIGITS,
  OTP_EXPIRY_MINUTES,
  MAX_ATTEMPTS,
  LOCK_MINUTES,
  RESEND_COOLDOWN_SECONDS,
  generateCode,
  buildIssuePatch,
  evaluateVerification,
  publicOtpState,
  revealCodeForCustomer,
  secondsUntilResendAllowed,
  isExpired,
  isLocked,
}
