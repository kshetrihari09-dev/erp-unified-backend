/**
 * src/utils/otpCrypto.js
 *
 * AES-256-GCM for the one thing in the delivery-OTP feature that has to
 * be readable again: the copy of the code the CUSTOMER sees on their own
 * order-tracking page.
 *
 * Deliberately NOT used for verification. Verification compares against
 * customer_orders.delivery_otp_hash (bcrypt) and never decrypts anything
 * — see services/deliveryOtpService.js. So this module is never on the
 * path that decides whether a delivery is genuine; it only decides what
 * the order's own customer is shown.
 *
 * Same wire format as utils/tokenCrypto.js (`iv:authTag:ciphertext`, all
 * base64) rather than a second convention. It is a separate module, not
 * a reuse of tokenCrypto, for one reason: tokenCrypto hard-throws when
 * CLOUD_STORAGE_ENCRYPTION_KEY is unset, which is correct for cloud
 * storage (a feature you opt into) but would mean an unconfigured
 * install cannot mark an order out for delivery at all. Key resolution
 * below degrades instead of failing.
 *
 * Key resolution, in order:
 *   1. DELIVERY_OTP_ENCRYPTION_KEY   — set this in production.
 *   2. CLOUD_STORAGE_ENCRYPTION_KEY  — already present on installs that
 *                                      configured cloud storage.
 *   3. scrypt(JWT_SECRET, 'delivery-otp-v1')  — derived, never the raw
 *      JWT secret itself, so the two are not interchangeable if either
 *      leaks. This keeps a fresh install working out of the box.
 *
 * Generate a dedicated key with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
'use strict'

const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // recommended for GCM

let cachedKey = null

function parseKeyMaterial(raw) {
  const key = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64')
  return key.length === 32 ? key : null
}

function loadKey() {
  if (cachedKey) return cachedKey

  for (const envName of ['DELIVERY_OTP_ENCRYPTION_KEY', 'CLOUD_STORAGE_ENCRYPTION_KEY']) {
    const raw = process.env[envName]
    if (!raw) continue
    let key = null
    try { key = parseKeyMaterial(raw) } catch { key = null }
    if (key) { cachedKey = key; return cachedKey }
    console.warn(`[DeliveryOTP] ${envName} is set but does not decode to 32 bytes — ignoring it.`)
  }

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    throw new Error(
      'No key available for delivery OTP encryption. Set DELIVERY_OTP_ENCRYPTION_KEY ' +
      '(32 bytes, base64 or hex) — or JWT_SECRET, from which a key can be derived.'
    )
  }

  // Fixed, purpose-scoped salt: the point is domain separation from the
  // JWT signing key, not password stretching against an offline attacker
  // who already has the database.
  cachedKey = crypto.scryptSync(jwtSecret, 'delivery-otp-v1', 32)
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[DeliveryOTP] Deriving the OTP encryption key from JWT_SECRET. Set a dedicated ' +
      'DELIVERY_OTP_ENCRYPTION_KEY in production so rotating one secret does not ' +
      'invalidate the other.'
    )
  }
  return cachedKey
}

/** Encrypt a plaintext string → `iv:authTag:ciphertext` (all base64). */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null
  const key = loadKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

/**
 * Decrypt a value produced by encrypt().
 *
 * Returns null rather than throwing on anything malformed, tampered
 * with, or encrypted under a different key. Callers are all
 * "show the customer their code" paths, and the right behaviour there is
 * to fall back to "request a new code" rather than 500 the tracking page.
 */
function decrypt(stored) {
  if (!stored) return null
  try {
    const [ivB64, tagB64, dataB64] = String(stored).split(':')
    if (!ivB64 || !tagB64 || !dataB64) return null
    const key = loadKey()
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

module.exports = { encrypt, decrypt }
