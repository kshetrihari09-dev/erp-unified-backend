/**
 * services/purchaseScan/pdfRasterizer.js — PDF pages → PNG buffers.
 *
 * Shells out to the system `pdftoppm` binary (from poppler-utils).
 *
 * This was NOT the first thing tried. A pure-JS route (`pdfjs-dist` +
 * `@napi-rs/canvas`, no system dependency) was tested first and rejected
 * because it hits a real incompatibility: pdf.js's glyph-path rendering
 * calls a Path2D API that @napi-rs/canvas's implementation doesn't fully
 * support, and it throws on ordinary text-bearing PDFs rather than
 * degrading gracefully. `pdftoppm` was verified end-to-end instead.
 *
 * The tradeoff this creates: `poppler-utils` must be installed on
 * whatever machine runs this backend (`apt-get install poppler-utils` /
 * `brew install poppler`). That's a new deployment prerequisite for this
 * one feature — see CHANGES.md — traded deliberately for something
 * that's actually been confirmed to work over something portable but
 * broken.
 */
'use strict'

const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const RESOLUTION_DPI = 300  // print-quality — meaningfully improves OCR accuracy over the ~150dpi default
const MAX_PAGES = 20        // a runaway/corrupt PDF must not rasterize forever

let checkedAvailable = null

/** Confirms `pdftoppm` is on PATH. Cached after the first check —
 *  this doesn't change while the process is running. */
function isAvailable() {
  if (checkedAvailable !== null) return checkedAvailable
  try {
    require('child_process').execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' })
    checkedAvailable = true
  } catch {
    checkedAvailable = false
  }
  return checkedAvailable
}

/**
 * Rasterize every page of a PDF buffer to an array of PNG buffers, in
 * page order.
 *
 * Throws a clear, actionable error (rather than a raw ENOENT) when
 * `pdftoppm` isn't installed, since that's the single most likely
 * deployment gap for this feature.
 */
async function rasterizePdf(pdfBuffer) {
  if (!isAvailable()) {
    const err = new Error(
      'PDF scanning requires the "pdftoppm" command (part of poppler-utils), which is not ' +
      'installed on this server. Install it with `apt-get install poppler-utils` (Debian/Ubuntu) ' +
      'or `brew install poppler` (macOS), then try again. Image (JPG/PNG) uploads do not need this.'
    )
    err.code = 'PDFTOPPM_NOT_INSTALLED'
    throw err
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pur-scan-'))
  const pdfPath = path.join(workDir, 'input.pdf')
  const outPrefix = path.join(workDir, 'page')

  try {
    await fs.promises.writeFile(pdfPath, pdfBuffer)

    await new Promise((resolve, reject) => {
      execFile(
        'pdftoppm',
        ['-png', '-r', String(RESOLUTION_DPI), '-l', String(MAX_PAGES), pdfPath, outPrefix],
        { timeout: 60_000 },
        (err) => (err ? reject(err) : resolve()),
      )
    })

    const files = (await fs.promises.readdir(workDir))
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort() // pdftoppm zero-pads page numbers, so lexical sort is page order

    if (!files.length) {
      const err = new Error('Could not read any pages from this PDF. It may be corrupt, password-protected, or empty.')
      err.code = 'PDF_UNREADABLE'
      throw err
    }

    const buffers = await Promise.all(files.map(f => fs.promises.readFile(path.join(workDir, f))))
    return buffers
  } finally {
    // Always clean up the temp dir, success or failure — these are
    // financial documents sitting unencrypted in /tmp otherwise.
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { rasterizePdf, isAvailable }
