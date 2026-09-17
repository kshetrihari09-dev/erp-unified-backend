/**
 * services/purchaseScan/ocrEngine.js — OCR, word-box output.
 *
 * Wraps tesseract.js, pinned to a LOCALLY BUNDLED trained-data file
 * rather than tesseract.js's default behaviour of fetching one from a
 * CDN (jsdelivr) on first use. Two reasons, not one:
 *
 *   1. A production backend making a surprise outbound fetch to a third-
 *      party CDN the first time someone scans an invoice is a bad
 *      failure mode — it works in dev, then 403s/times out behind a
 *      restrictive egress policy in prod, on whatever request happens to
 *      be first. This was not hypothetical: it happened immediately when
 *      building this feature, in a sandboxed environment whose network
 *      policy didn't allow jsdelivr.
 *   2. Once the data is local, OCR has no per-request network dependency
 *      at all — scanning a bill works the same offline as online.
 *
 * `npm run setup:ocr` (scripts/download-ocr-data.js) fetches the trained
 * data once, from a GitHub-hosted mirror, into data/tessdata/. This
 * module simply fails clearly if that hasn't been run yet, rather than
 * silently falling back to a network fetch.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { createWorker } = require('tesseract.js')

const LANG = 'eng'
const TESSDATA_DIR = path.join(__dirname, '..', '..', '..', 'data', 'tessdata')

let workerPromise = null

function tessdataReady() {
  return fs.existsSync(path.join(TESSDATA_DIR, `${LANG}.traineddata.gz`))
}

/** One shared worker for the process's lifetime — spinning up a fresh
 *  tesseract.js worker (it loads a wasm binary + the trained-data file)
 *  per request would make every scan noticeably slower for no benefit,
 *  since recognize() is already safe to call repeatedly on one worker. */
function getWorker() {
  if (!workerPromise) {
    if (!tessdataReady()) {
      const err = new Error(
        `OCR language data not found at ${TESSDATA_DIR}. Run \`npm run setup:ocr\` once ` +
        `(from erp-unified-backend) to download it, then restart the server.`
      )
      err.code = 'OCR_DATA_MISSING'
      return Promise.reject(err)
    }
    // gzip: true — the setup script stores the trained-data file exactly
    // as downloaded (.traineddata.gz); tesseract.js decompresses it
    // in-process. This is the exact shape verified working end-to-end
    // while building this feature — don't "simplify" this away without
    // re-testing, tesseract.js is picky about this option matching the
    // file it finds.
    workerPromise = createWorker(LANG, 1, {
      langPath: TESSDATA_DIR,
      cachePath: TESSDATA_DIR,
      gzip: true,
    })
  }
  return workerPromise
}

/**
 * OCR one page image (PNG/JPEG buffer). Returns:
 *   { text, confidence, words: [{ text, confidence, bbox:{x0,y0,x1,y1} }] }
 *
 * `words` is what invoiceParser.js actually reasons over — bounding
 * boxes are what make column-based table parsing possible at all; the
 * flat `text` is kept only as a fallback / for the raw-OCR debug record
 * stored on purchase_scan_pages.ocr_text.
 */
async function recognizePage(imageBuffer) {
  const worker = await getWorker()
  const { data } = await worker.recognize(imageBuffer)
  return {
    text: data.text || '',
    confidence: data.confidence ?? 0,
    words: (data.words || []).map(w => ({
      text: w.text,
      confidence: w.confidence,
      bbox: w.bbox,
    })),
  }
}

async function shutdown() {
  if (workerPromise) {
    const worker = await workerPromise.catch(() => null)
    if (worker) await worker.terminate().catch(() => {})
    workerPromise = null
  }
}

module.exports = { recognizePage, tessdataReady, shutdown, TESSDATA_DIR }
