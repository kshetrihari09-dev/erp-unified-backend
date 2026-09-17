/**
 * services/purchaseScan/scanStorage.js — where scanned pages live on disk.
 *
 * Same convention as routes/products.js's product-image storage
 * (`/uploads/{feature}/{companyId}/{safeFileName}`), with one deliberate
 * difference: product images are served by an `express.static` mount and
 * are effectively public-by-URL; a purchase invoice is a financial
 * document that can carry supplier pricing and account details, so pages
 * saved here are served only through the authenticated, company-scoped
 * route in routes/purchases.js (GET .../scan/:scanId/pages/:pageNo) —
 * there is no static mount for `uploads/purchase-scans`.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const UPLOAD_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'purchase-scans')

function scanDir(companyId, scanId) {
  return path.join(UPLOAD_ROOT, companyId, scanId)
}

/** Save one page's image buffer to disk. Returns the path to store on
 *  the purchase_scan_pages row — relative to UPLOAD_ROOT, not absolute,
 *  so the storage root can move without invalidating every DB row. */
async function savePage(companyId, scanId, pageNo, buffer, ext) {
  const dir = scanDir(companyId, scanId)
  await fs.promises.mkdir(dir, { recursive: true })
  const fileName = `page-${String(pageNo).padStart(3, '0')}.${ext}`
  await fs.promises.writeFile(path.join(dir, fileName), buffer)
  return path.join(companyId, scanId, fileName)
}

/** Read a previously-saved page back into memory, for OCR or for
 *  streaming to the review screen / Purchase History's "View Original". */
async function readPage(relativePath) {
  return fs.promises.readFile(path.join(UPLOAD_ROOT, relativePath))
}

/** Best-effort delete of every page belonging to a scan — used when a
 *  scan is explicitly discarded. Never throws: a cleanup failure must
 *  not block the user from discarding a scan in the UI. */
async function deleteScanFiles(companyId, scanId) {
  await fs.promises.rm(scanDir(companyId, scanId), { recursive: true, force: true }).catch(() => {})
}

module.exports = { savePage, readPage, deleteScanFiles, UPLOAD_ROOT }
