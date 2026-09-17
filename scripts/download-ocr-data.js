#!/usr/bin/env node
/**
 * scripts/download-ocr-data.js — fetches Tesseract's English trained-data
 * file once, into data/tessdata/, so OCR never needs network access at
 * request time (see services/purchaseScan/ocrEngine.js for why).
 *
 * Run manually: `npm run setup:ocr` (from erp-unified-backend).
 * Idempotent — re-running with the file already present is a no-op.
 *
 * Source: the same mirror (naptha/tessdata on GitHub Pages, via
 * raw.githubusercontent.com) that tesseract.js's own default CDN
 * fallback ultimately points at — this is not a different, unvetted
 * data file, just fetched from a host reachable at setup time instead of
 * request time.
 */
'use strict'

const https = require('https')
const fs = require('fs')
const path = require('path')

const URL = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/eng.traineddata.gz'
const DEST_DIR = path.join(__dirname, '..', 'data', 'tessdata')
const DEST_FILE = path.join(DEST_DIR, 'eng.traineddata.gz')

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume()
        return resolve(download(res.headers.location, destPath, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`))
      }
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', reject)
    }).on('error', reject)
  })
}

async function main() {
  if (fs.existsSync(DEST_FILE) && fs.statSync(DEST_FILE).size > 0) {
    console.log(`[setup:ocr] Already present at ${DEST_FILE} — nothing to do.`)
    return
  }

  await fs.promises.mkdir(DEST_DIR, { recursive: true })
  console.log(`[setup:ocr] Downloading English OCR data to ${DEST_FILE} ...`)

  const tmpFile = DEST_FILE + '.download'
  try {
    await download(URL, tmpFile)
    const size = fs.statSync(tmpFile).size
    if (size < 1_000_000) { // the real file is ~10MB; anything tiny means we got an error page
      throw new Error(`Downloaded file is suspiciously small (${size} bytes) — likely not the real trained-data file.`)
    }
    await fs.promises.rename(tmpFile, DEST_FILE)
    console.log(`[setup:ocr] Done (${(size / 1_000_000).toFixed(1)} MB).`)
  } catch (err) {
    await fs.promises.unlink(tmpFile).catch(() => {})
    console.error(`[setup:ocr] Failed: ${err.message}`)
    console.error('[setup:ocr] Scan Purchase Bill will not work until this succeeds. You can also')
    console.error(`[setup:ocr] place a valid eng.traineddata.gz at ${DEST_FILE} manually.`)
    process.exitCode = 1
  }
}

main()
