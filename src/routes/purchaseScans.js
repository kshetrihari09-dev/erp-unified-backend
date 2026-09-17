/**
 * routes/purchaseScans.js — Scan Purchase Bill / Invoice OCR.
 *
 * This router owns exactly one job: turning an uploaded bill into a
 * reviewable, structured draft. It does NOT create purchases — per the
 * spec's architecture rule, that stays the exclusive job of the existing
 * POST /purchases (routes/purchases.js), which this feature only adds an
 * optional `source_scan_id` to. A `purchase_scans` row that never gets
 * confirmed never touches the `purchases` table at all.
 *
 * Pipeline (spec #12), mapped onto these routes:
 *
 *   Scan Bill         → POST /purchase-scans          (saves pages, status: uploaded)
 *   OCR → Extract      → (background, this file)        (status: processing → extracted|failed)
 *   Match Products      → (background, same pass)
 *   Populate Form       → GET /purchase-scans/:id        (frontend reads extracted_data)
 *   Run Existing Calcs   → services/purchaseScan/reconcile.js (already run before "extracted")
 *   Validate / User Review → frontend, against this data
 *   Confirm Purchase    → POST /purchases  (existing endpoint, source_scan_id set)
 *
 * OCR runs in the background, not inline in the upload request — a
 * multi-page bill can take tens of seconds on CPU-only Tesseract, and
 * this app has no job queue to hand that off to. The upload request
 * returns as soon as pages are saved; the frontend polls GET /:id until
 * status leaves 'processing'.
 */
const router = require('express').Router()
const multer = require('multer')
const path = require('path')
const db = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { auditLog } = require('../utils/helpers')
const { validateUploadedFile } = require('../utils/uploadValidation')
const scanStorage = require('../services/purchaseScan/scanStorage')
const pdfRasterizer = require('../services/purchaseScan/pdfRasterizer')
const ocrEngine = require('../services/purchaseScan/ocrEngine')
const invoiceParser = require('../services/purchaseScan/invoiceParser')
const { matchProduct, matchSupplier } = require('../services/purchaseScan/matcher')
const { reconcileBill } = require('../services/purchaseScan/reconcile')
const sharp = require('sharp')

router.use(authenticate)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 }, // matches cloudStorage.js's cap; up to 20 pages/photos per bill
})

/* ── POST /purchase-scans ─────────────────────────────────────────────────
 * multipart/form-data, field "files" (1+). Each file is a photo/scan of
 * one page, OR a single multipart entry can itself be a multi-page PDF —
 * both are accepted and expanded to one purchase_scan_pages row per page
 * either way, so the rest of the pipeline never needs to know which the
 * user chose (spec #1: camera, image upload, PDF upload, multi-page, all
 * feed the same downstream code).
 */
router.post('/', upload.array('files'), async (req, res, next) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ success: false, message: 'Attach at least one photo or PDF of the bill.' })
    }

    const [scan] = await db('purchase_scans').insert({
      company_id: req.companyId, uploaded_by: req.user.id, status: 'uploaded',
    }).returning('*')

    let pageNo = 1
    const pageRows = []
    for (const file of req.files) {
      const validated = validateUploadedFile(file.buffer, file.originalname)
      if (!validated.ok) {
        // Reject the whole upload rather than silently dropping one bad
        // file — a bill missing a page it should have is worse than a
        // clear error asking the user to re-upload it.
        await db('purchase_scans').where({ id: scan.id }).del()
        return res.status(400).json({ success: false, code: validated.code, message: `"${file.originalname}": ${validated.message}` })
      }

      if (validated.mimeType === 'application/pdf') {
        const pageBuffers = await pdfRasterizer.rasterizePdf(file.buffer).catch((err) => {
          err.httpStatus = err.code === 'PDFTOPPM_NOT_INSTALLED' ? 503 : 400
          throw err
        })
        for (const pageBuf of pageBuffers) {
          const relPath = await scanStorage.savePage(req.companyId, scan.id, pageNo, pageBuf, 'png')
          pageRows.push({ scan_id: scan.id, page_no: pageNo, file_path: relPath, mime_type: 'image/png' })
          pageNo++
        }
      } else {
        const relPath = await scanStorage.savePage(req.companyId, scan.id, pageNo, file.buffer, validated.ext)
        pageRows.push({ scan_id: scan.id, page_no: pageNo, file_path: relPath, mime_type: validated.mimeType })
        pageNo++
      }
    }

    await db('purchase_scan_pages').insert(pageRows)
    await auditLog(req.companyId, req.user.id, 'CREATE', 'purchase_scan', scan.id, { page_count: pageRows.length }, req.ip)

    // Kick off OCR in the background; the response tells the client to
    // start polling rather than waiting on a multi-page OCR pass inline.
    runOcrPipeline(scan.id, req.companyId).catch((err) => {
      console.error(`[purchaseScans] OCR pipeline failed for scan ${scan.id}:`, err)
      db('purchase_scans').where({ id: scan.id })
        .update({ status: 'failed', error_message: err.message?.slice(0, 1000) || 'OCR failed', updated_at: new Date() })
        .catch(() => {})
    })

    await db('purchase_scans').where({ id: scan.id }).update({ status: 'processing', updated_at: new Date() })
    return successResponse(res, { id: scan.id, status: 'processing', page_count: pageRows.length }, 'Scan uploaded — extracting data…', 202)
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ success: false, code: err.code, message: err.message })
    next(err)
  }
})

/**
 * Runs OCR + parsing + matching + reconciliation for every page of a
 * scan, then stores the merged result and flips status to 'extracted'
 * (or 'failed'). Not exported/route-bound — called fire-and-forget from
 * the upload handler above.
 */
async function runOcrPipeline(scanId, companyId) {
  const pages = await db('purchase_scan_pages').where({ scan_id: scanId }).orderBy('page_no')
  if (!pages.length) throw new Error('No pages found for this scan.')

  const pageResults = []
  for (const page of pages) {
    const raw = await scanStorage.readPage(page.file_path)
    // Preprocessing measurably helps Tesseract on phone-camera photos in
    // particular (uneven lighting, slight blur) — grayscale + normalize
    // + sharpen, all cheap relative to OCR itself.
    const preprocessed = await sharp(raw).grayscale().normalize().sharpen().toBuffer()
    const ocr = await ocrEngine.recognizePage(preprocessed)

    await db('purchase_scan_pages').where({ id: page.id }).update({
      ocr_text: ocr.text.slice(0, 20_000), // generous but bounded — this is a debug record, not a document store
      ocr_confidence: ocr.confidence,
      updated_at: new Date(),
    })

    pageResults.push(invoiceParser.parsePage(ocr))
  }

  const merged = invoiceParser.mergePages(pageResults)

  // Match against THIS company's own catalog — never cross-company,
  // matching auth's normal company-scoping everywhere else in this app.
  const [products, suppliers] = await Promise.all([
    db('products').where({ company_id: companyId, is_active: true }),
    db('parties').where({ company_id: companyId, type: 'supplier', is_active: true }),
  ])

  const itemsWithMatches = merged.items.map(item => ({ ...item, match: matchProduct(item, products) }))
  const supplierMatch = matchSupplier(merged.header.supplier_name, suppliers)

  const reconciled = reconcileBill(merged.header, itemsWithMatches)

  // Duplicate-invoice check (spec #10) runs here too, not only at
  // confirm-time, so the review screen can show the warning immediately
  // rather than the user discovering it only after filling everything in.
  const duplicate = await findDuplicatePurchase(companyId, supplierMatch.party_id, merged.header.invoice_no?.value)

  const extracted_data = {
    header: merged.header,
    supplier_match: supplierMatch,
    items: reconciled.items,
    calculated: reconciled.calculated,
    flags: reconciled.flags,
    needs_review: reconciled.needs_review,
    duplicate_warning: duplicate,
    table_found: merged.any_table_found,
  }

  await db('purchase_scans').where({ id: scanId }).update({
    status: 'extracted', extracted_data: JSON.stringify(extracted_data), updated_at: new Date(),
  })
}

async function findDuplicatePurchase(companyId, partyId, supplierBillNo) {
  if (!partyId || !supplierBillNo) return null
  const existing = await db('purchases')
    .where({ company_id: companyId, party_id: partyId })
    .whereRaw('lower(trim(supplier_bill_no)) = lower(trim(?))', [supplierBillNo])
    .andWhere('status', '!=', 'cancelled')
    .select('id', 'bill_no', 'supplier_bill_no', 'date_ad', 'net_total')
    .first()
  return existing || null
}

/* ── GET /purchase-scans/:id ───────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const scan = await db('purchase_scans').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' })
    const pages = await db('purchase_scan_pages').where({ scan_id: scan.id }).orderBy('page_no')
      .select('id', 'page_no', 'mime_type', 'ocr_confidence')
    res.json({ success: true, data: { ...scan, pages } })
  } catch (err) { next(err) }
})

/* ── GET /purchase-scans/:id/pages/:pageNo/file ────────────────────────────
 * Authenticated, company-scoped file serving — deliberately NOT a static
 * mount (see scanStorage.js). Doubles as "View Original" from Purchase
 * History once a scan is linked to a purchase (spec #11): the frontend
 * calls this same route via the purchase's source_scan_id.
 */
router.get('/:id/pages/:pageNo/file', async (req, res, next) => {
  try {
    const scan = await db('purchase_scans').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' })
    const page = await db('purchase_scan_pages')
      .where({ scan_id: scan.id, page_no: Number(req.params.pageNo) }).first()
    if (!page) return res.status(404).json({ success: false, message: 'Page not found.' })

    const buf = await scanStorage.readPage(page.file_path).catch(() => null)
    if (!buf) return res.status(404).json({ success: false, message: 'The original file is no longer available.' })

    res.setHeader('Content-Type', page.mime_type)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(buf)
  } catch (err) { next(err) }
})

/* ── DELETE /purchase-scans/:id ─────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  try {
    const scan = await db('purchase_scans').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' })
    if (scan.status === 'confirmed') {
      return res.status(400).json({ success: false, message: 'This scan is already linked to a purchase and cannot be discarded.' })
    }

    await db('purchase_scans').where({ id: scan.id }).update({ status: 'discarded', updated_at: new Date() })
    await scanStorage.deleteScanFiles(req.companyId, scan.id)
    await auditLog(req.companyId, req.user.id, 'DELETE', 'purchase_scan', scan.id, {}, req.ip)
    res.json({ success: true, message: 'Scan discarded.' })
  } catch (err) { next(err) }
})

/* ── GET /purchase-scans/check-duplicate ──────────────────────────────────
 * Shared with manual entry too, not just the scan flow (spec #10 doesn't
 * say "only for scans") — PurchasePage.tsx can call this as the supplier
 * bill number field is typed, same as the review screen does after OCR.
 */
router.get('/check-duplicate', async (req, res, next) => {
  try {
    const { party_id, supplier_bill_no } = req.query
    if (!party_id || !supplier_bill_no) return res.json({ success: true, data: null })
    const dup = await findDuplicatePurchase(req.companyId, party_id, supplier_bill_no)
    res.json({ success: true, data: dup })
  } catch (err) { next(err) }
})

module.exports = router
