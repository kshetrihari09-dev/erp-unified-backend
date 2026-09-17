/**
 * services/purchaseScan/invoiceParser.js — OCR word boxes → structured
 * purchase-bill data.
 *
 * This is inherently approximate. Tesseract (the chosen "lower cost,
 * weaker accuracy" engine) gives words and their pixel positions, not an
 * understanding of what an invoice is — there is no layout model here,
 * only heuristics: keyword-anchored regex for header fields, and
 * column-position clustering (driven by the table's own header row) for
 * line items. That is the correct tool for the chosen engine, but it
 * means every extracted value is a starting point for human review, not
 * a conclusion — which is exactly what the spec's review screen,
 * confidence flags, and "never silently accept" reconciliation rules are
 * for. Nothing downstream of this file trusts its output unchecked; see
 * reconcile.js.
 *
 * ── Pipeline ──────────────────────────────────────────────────────────
 *  1. Group words into text lines by y-coordinate (words whose vertical
 *     centers are close together are the same printed line).
 *  2. HEADER: scan lines above the item table for label→value pairs
 *     ("Invoice No: 4821", "CC%: 10", etc.) via keyword regex.
 *  3. TABLE: find the line that looks like a column header (contains
 *     several of Product/Qty/Rate/Batch/...), use ITS words' x-positions
 *     to define column boundaries, then assign every word in every line
 *     below it to a column by x-overlap.
 *  4. Each parsed line item and header field carries a `confidence`
 *     (0-1) derived from the underlying OCR word confidences and how
 *     cleanly it matched its pattern — low confidence is surfaced in the
 *     review UI, not hidden.
 */
'use strict'

// ── Header field patterns ────────────────────────────────────────────────
// Each pattern is tried against the header region's full text (lines
// joined). Numbers are parsed tolerantly: OCR commonly reads "," as "."
// or drops currency symbols, so digits/dots/commas are extracted first
// and normalized before parseFloat.
const HEADER_PATTERNS = {
  invoice_no:    /\b(?:invoice|bill|inv)\s*(?:no|number|#)?\s*[:\-]?\s*([a-z0-9\/\-]{2,20})/i,
  invoice_date:  /\b(?:invoice\s*date|bill\s*date|date)\s*[:\-]?\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{1,4})/i,
  due_date:      /\b(?:due\s*date|payment\s*due)\s*[:\-]?\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{1,4})/i,
  payment_terms: /\b(?:payment\s*terms?|terms)\s*[:\-]?\s*([a-z0-9 ,]{2,40})/i,
  subtotal:      /\b(?:sub\s*-?\s*total)\s*[:\-]?\s*(?:rs\.?|npr)?\s*([0-9,]+\.?[0-9]*)/i,
  discount:      /\bdiscount\s*(?:amount)?\s*[:\-]?\s*(?:rs\.?|npr)?\s*([0-9,]+\.?[0-9]*)/i,
  tax:           /\b(?:tax|vat)\s*(?:amount)?\s*[:\-]?\s*(?:rs\.?|npr)?\s*([0-9,]+\.?[0-9]*)/i,
  cc_pct_header: /\bc\.?c\.?\s*%\s*[:\-]?\s*([0-9]+\.?[0-9]*)/i,
  cc_amount_header: /\bc\.?c\.?\s*amount\s*[:\-]?\s*(?:rs\.?|npr)?\s*([0-9,]+\.?[0-9]*)/i,
  grand_total:   /\b(?:grand\s*total|net\s*total|total\s*amount|bill\s*amount)\s*[:\-]?\s*(?:rs\.?|npr)?\s*([0-9,]+\.?[0-9]*)/i,
}

// Column header keywords -> the field they identify. A table header row
// is recognized by containing several of these; matched words then
// anchor that column's x-range for every line below.
const COLUMN_KEYWORDS = {
  product_name: /^(product|item|description|particular)/i,
  manufacturer: /^(mfg|manufacturer|brand|company)/i,
  code:         /^(code|barcode|hsn)/i,
  pack_size:    /^(pack|size)/i,
  batch_no:     /^(batch|lot)/i,
  expiry:       /^(exp|expiry)/i,
  qty:          /^(qty|quantity)$/i,
  free_qty:     /^(free|bonus|f\.?qty)/i,
  rate:         /^(rate|cost|purch)/i,
  mrp:          /^mrp$/i,
  discount_pct: /^(disc|discount)/i,
  tax_pct:      /^(tax|vat)/i,
  cc_pct:       /^c\.?c\.?%?$/i,
  cc_amount:    /^c\.?c\.?\s*(amt|amount)/i,
  line_total:   /^(total|amount|net)/i,
}

const NUM_RE = /[0-9][0-9,]*\.?[0-9]*/

function parseNum(raw) {
  if (raw === undefined || raw === null) return null
  const m = String(raw).match(NUM_RE)
  if (!m) return null
  const n = parseFloat(m[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Normalizes a loosely-formatted date string ("12/03/2081", "2081-03-12")
 *  to YYYY-MM-DD where the parts are unambiguous; otherwise returns the
 *  raw string for the reviewer to fix by hand rather than guessing and
 *  being silently wrong. Deliberately does not attempt BS/AD conversion
 *  here — DateSystemInput on the frontend already owns that, and
 *  guessing which calendar an OCR'd date is in would be exactly the kind
 *  of silent, unreviewed assumption this feature is built to avoid. */
function normalizeDateLoose(raw) {
  if (!raw) return null
  const m = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/.exec(raw.trim())
  if (!m) return raw.trim()
  const [, a, b, c] = m
  if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`
  if (c.length === 4) return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`
  return raw.trim() // ambiguous 2-digit year on all parts — don't guess
}

// ── Line grouping ─────────────────────────────────────────────────────────

/** Groups OCR words into text lines by vertical position. Words are
 *  sorted top-to-bottom, then left-to-right within a line. `tolerance`
 *  is in pixels at the OCR'd resolution (300dpi per pdfRasterizer.js) —
 *  wide enough to absorb baseline jitter between characters on one
 *  printed line, narrow enough not to merge two real table rows. */
function groupIntoLines(words, tolerance = 12) {
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0)
  const lines = []
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2
    let line = lines.find(l => Math.abs(l.cy - cy) <= tolerance)
    if (!line) {
      line = { cy, words: [] }
      lines.push(line)
    }
    line.words.push(w)
    line.cy = line.words.reduce((s, x) => s + (x.bbox.y0 + x.bbox.y1) / 2, 0) / line.words.length
  }
  for (const l of lines) l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0)
  lines.sort((a, b) => a.cy - b.cy)
  return lines.map(l => ({ ...l, text: l.words.map(w => w.text).join(' ') }))
}

// ── Header extraction ───────────────────────────────────────────────────

function extractHeaderFields(headerLines) {
  const fullText = headerLines.map(l => l.text).join('\n')
  const out = {}

  for (const [field, pattern] of Object.entries(HEADER_PATTERNS)) {
    const m = pattern.exec(fullText)
    if (!m) continue
    const raw = m[1].trim()
    if (field === 'invoice_date' || field === 'due_date') {
      out[field] = { value: normalizeDateLoose(raw), raw, confidence: 0.6 }
    } else if (field === 'invoice_no' || field === 'payment_terms') {
      out[field] = { value: raw, raw, confidence: 0.6 }
    } else {
      out[field] = { value: parseNum(raw), raw, confidence: 0.6 }
    }
  }

  // Supplier name: not label-anchored the way the other fields are — on
  // most bills it's simply the most prominent text in the first few
  // lines, above any "Invoice No" line. Heuristic: the longest line in
  // the first third of the header block that isn't pure digits, since
  // that's almost always the printed letterhead name, not an address or
  // phone line. Lowest-confidence field in the whole extraction on
  // purpose — flagged for the reviewer to confirm or pick from the
  // matched-supplier list instead of trusting blindly.
  const candidateLines = headerLines.slice(0, Math.max(3, Math.ceil(headerLines.length / 3)))
  const supplierLine = candidateLines
    .filter(l => l.text.length >= 4 && !/^\d+$/.test(l.text.replace(/\s/g, '')))
    .sort((a, b) => b.text.length - a.text.length)[0]
  if (supplierLine) {
    out.supplier_name = { value: supplierLine.text.trim(), raw: supplierLine.text, confidence: 0.35 }
  }

  return out
}

// ── Table extraction ────────────────────────────────────────────────────

/** Finds the line most likely to be the item-table's column header:
 *  the line matching the most distinct COLUMN_KEYWORDS patterns. */
function findTableHeaderLine(lines) {
  let best = null, bestScore = 0
  for (const line of lines) {
    const matchedFields = new Set()
    for (const w of line.words) {
      for (const [field, pattern] of Object.entries(COLUMN_KEYWORDS)) {
        if (pattern.test(w.text.replace(/[^a-zA-Z.%]/g, ''))) matchedFields.add(field)
      }
    }
    if (matchedFields.size > bestScore) { bestScore = matchedFields.size; best = { line, matchedFields } }
  }
  // Require at least 3 recognized columns — fewer than that is too weak
  // a signal to be confident this line is really the table header.
  return bestScore >= 3 ? best : null
}

/** Builds column x-ranges from the header line's words: each matched
 *  header word's x-span, widened halfway to its neighbors so a body
 *  word that's roughly under a header cell still falls inside it even
 *  if OCR's per-character spacing isn't pixel-perfect. */
function buildColumns(headerMatch) {
  const { line, matchedFields } = headerMatch
  const cols = []
  for (const w of line.words) {
    for (const [field, pattern] of Object.entries(COLUMN_KEYWORDS)) {
      if (matchedFields.has(field) && pattern.test(w.text.replace(/[^a-zA-Z.%]/g, ''))) {
        cols.push({ field, x0: w.bbox.x0, x1: w.bbox.x1 })
      }
    }
  }
  cols.sort((a, b) => a.x0 - b.x0)
  for (let i = 0; i < cols.length; i++) {
    const prevX1 = i > 0 ? cols[i - 1].x1 : -Infinity
    const nextX0 = i < cols.length - 1 ? cols[i + 1].x0 : Infinity
    cols[i].left  = i === 0 ? -Infinity : (prevX1 + cols[i].x0) / 2
    cols[i].right = i === cols.length - 1 ? Infinity : (cols[i].x1 + nextX0) / 2
  }
  return cols
}

function assignWordToColumn(word, columns) {
  const cx = (word.bbox.x0 + word.bbox.x1) / 2
  return columns.find(c => cx >= c.left && cx < c.right) || null
}

/** Parses the table body (every line below the header line, stopping at
 *  the first line that looks like a totals/footer row) into structured
 *  line items. */
function extractLineItems(lines, headerLineIdx, columns) {
  const items = []
  const FOOTER_RE = /\b(sub\s*-?\s*total|grand\s*total|net\s*total|total\s*amount|discount|tax|vat|c\.?c\.?\s*%|c\.?c\.?\s*amount)\b/i

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (FOOTER_RE.test(line.text) && !/\d/.test(line.text.replace(FOOTER_RE, ''))) break

    const cells = {}
    const cellWordConfidences = []
    for (const w of line.words) {
      const col = assignWordToColumn(w, columns)
      if (!col) continue
      cells[col.field] = cells[col.field] ? `${cells[col.field]} ${w.text}` : w.text
      cellWordConfidences.push(w.confidence)
    }

    if (!Object.keys(cells).length) continue
    if (!cells.product_name || (!cells.qty && !cells.rate)) continue

    const avgConfidence = cellWordConfidences.length
      ? cellWordConfidences.reduce((s, c) => s + c, 0) / cellWordConfidences.length / 100
      : 0.3

    items.push({
      product_name:  cells.product_name?.trim() || null,
      manufacturer:  cells.manufacturer?.trim() || null,
      code:          cells.code?.trim() || null,
      pack_size:     cells.pack_size?.trim() || null,
      batch_no:      cells.batch_no?.trim() || null,
      expiry:        cells.expiry?.trim() || null,
      qty:           parseNum(cells.qty),
      free_qty:      parseNum(cells.free_qty) || 0,
      rate:          parseNum(cells.rate),
      mrp:           parseNum(cells.mrp),
      discount_pct:  parseNum(cells.discount_pct) || 0,
      tax_pct:       parseNum(cells.tax_pct) || 0,
      cc_pct:        parseNum(cells.cc_pct) || 0,
      cc_amount_scanned: parseNum(cells.cc_amount),
      line_total_scanned: parseNum(cells.line_total),
      ocr_confidence: +avgConfidence.toFixed(2),
    })
  }
  return items
}

/**
 * Parses one page's OCR word-box output into { header, items,
 * table_found }. `header` and `items` are partial — every field may be
 * null/missing if this page didn't contain it (e.g. page 2 of a
 * multi-page bill that's all line items, no header).
 */
function parsePage(ocrResult) {
  const words = (ocrResult.words || []).filter(w => w.text && w.text.trim())
  if (!words.length) return { header: {}, items: [], table_found: false }

  const lines = groupIntoLines(words)
  const tableHeader = findTableHeaderLine(lines)

  if (!tableHeader) {
    return { header: extractHeaderFields(lines), items: [], table_found: false }
  }

  const headerLineIdx = lines.indexOf(lines.find(l => l.cy === tableHeader.line.cy))
  const headerLines = lines.slice(0, headerLineIdx)
  const columns = buildColumns(tableHeader)
  const items = extractLineItems(lines, headerLineIdx, columns)

  return { header: extractHeaderFields(headerLines), items, table_found: true }
}

/**
 * Merges per-page parse results for a multi-page bill: header fields
 * from whichever page found them first (usually page 1), line items
 * concatenated across all pages in page order.
 */
function mergePages(pageResults) {
  const header = {}
  const items = []
  for (const p of pageResults) {
    for (const [field, val] of Object.entries(p.header)) {
      if (!header[field]) header[field] = val
    }
    items.push(...p.items)
  }
  return { header, items, any_table_found: pageResults.some(p => p.table_found) }
}

module.exports = { parsePage, mergePages, groupIntoLines, parseNum, normalizeDateLoose }
