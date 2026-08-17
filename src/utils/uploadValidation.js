/**
 * uploadValidation.js — shared validation for any endpoint that accepts an
 * uploaded file buffer (currently: POST /cloud-storage/upload).
 *
 * The client-supplied `mimetype` (just the multipart part's Content-Type
 * header) and `originalname` are NEVER trusted on their own — both are
 * fully attacker-controlled and easy to spoof (renaming a script to
 * "invoice.pdf" is trivial). This module instead:
 *   - sniffs the real file type from its magic bytes / signature
 *   - only allows a small explicit allow-list of document types this app
 *     actually needs (accounting/invoice attachments)
 *   - derives a safe, server-generated object name from the DETECTED
 *     type, never the client's filename/extension
 */
const crypto = require('crypto')

const MAX_BYTES = 20 * 1024 * 1024 // matches the existing multer limit

// Signature → { mimeType, ext }. Extend deliberately, not by trusting the client.
const SIGNATURES = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mimeType: 'application/pdf', ext: 'pdf' }, // %PDF-
  { bytes: [0xff, 0xd8, 0xff],             mimeType: 'image/jpeg',      ext: 'jpg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mimeType: 'image/png', ext: 'png' },
]

function detectType(buffer) {
  for (const sig of SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
      return sig
    }
  }
  return null
}

/**
 * Validates an uploaded file buffer. Returns { ok: true, mimeType, ext,
 * safeFileName } on success, or { ok: false, code, message } on failure.
 * Never throws.
 */
function validateUploadedFile(buffer, originalName) {
  if (!buffer || !buffer.length) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Uploaded file is empty.' }
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'File exceeds the maximum allowed size (20MB).' }
  }
  const detected = detectType(buffer)
  if (!detected) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Unsupported or invalid file type. Only PDF, JPG, and PNG are accepted.' }
  }

  // Server-generated object name — never the client's filename/extension.
  // We keep a short, sanitized fragment of the original basename purely for
  // human readability (e.g. in the provider's folder listing), stripped of
  // path separators, control characters, and anything but a conservative
  // safe character set, and capped in length.
  const rawBase = (originalName || 'document').split(/[\\/]/).pop() // strip any path component
    .replace(/\.[^.]*$/, '') // drop client-supplied extension entirely
  const safeBase = rawBase.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60) || 'document'
  const safeFileName = `${safeBase}-${crypto.randomBytes(6).toString('hex')}.${detected.ext}`

  return { ok: true, mimeType: detected.mimeType, ext: detected.ext, safeFileName }
}

module.exports = { validateUploadedFile, MAX_BYTES }
