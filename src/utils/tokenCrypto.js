/**
 * src/utils/tokenCrypto.js
 *
 * Symmetric encryption helper used to store OAuth access/refresh tokens
 * at rest. Uses AES-256-GCM (authenticated encryption) so tampering with
 * a stored value is detectable on decrypt.
 *
 * Key material comes from process.env.CLOUD_STORAGE_ENCRYPTION_KEY, which
 * must be a 32-byte value provided as a base64 or hex string. This is
 * intentionally separate from JWT_SECRET — secrets for different purposes
 * should never be reused.
 *
 * This module is self-contained and does not touch any existing
 * accounting/auth code paths.
 */
'use strict'

const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // recommended for GCM

let cachedKey = null

function loadKey() {
  if (cachedKey) return cachedKey

  const raw = process.env.CLOUD_STORAGE_ENCRYPTION_KEY
  if (!raw) {
    // Fail loudly only when the feature is actually used, not at server
    // boot — keeps this module from breaking environments that haven't
    // configured cloud storage yet.
    throw new Error(
      'CLOUD_STORAGE_ENCRYPTION_KEY is not set. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    )
  }

  let key
  try {
    key = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64')
  } catch {
    throw new Error('CLOUD_STORAGE_ENCRYPTION_KEY is not valid base64/hex')
  }

  if (key.length !== 32) {
    throw new Error('CLOUD_STORAGE_ENCRYPTION_KEY must decode to exactly 32 bytes')
  }

  cachedKey = key
  return cachedKey
}

/**
 * Encrypt a plaintext string. Returns a single string safe for storing
 * in a text column: `iv:authTag:ciphertext`, all base64.
 */
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
 * Decrypt a string produced by encrypt(). Returns null on null/empty input.
 * Throws if the value has been tampered with or the key is wrong.
 */
function decrypt(payload) {
  if (!payload) return null
  const key = loadKey()
  const [ivB64, tagB64, dataB64] = payload.split(':')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload')
  }
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(dataB64, 'base64')

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

module.exports = { encrypt, decrypt }
