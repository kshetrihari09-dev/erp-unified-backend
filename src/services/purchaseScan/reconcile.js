/**
 * services/purchaseScan/reconcile.js — never trust the scanned numbers.
 *
 * This is the file spec section 4 is actually about: "recalculate
 * cc_amount using the application's existing calculation logic... do not
 * simply trust the OCR-extracted CC amount if it conflicts... display
 * both values... if they differ, show a mismatch warning."
 *
 * The rule this file enforces: `calcRowAmount` (utils/purchaseCalc.js —
 * the one true, fixed formula, same one routes/purchases.js uses to
 * actually save a purchase) computes every "calculated" figure here. A
 * scanned figure is compared against it, never substituted for it. This
 * is what makes the scanner "only an input method" in practice, not just
 * in the architecture diagram: nothing coming out of OCR ever becomes
 * the number that gets saved without going through this same formula
 * first.
 */
'use strict'

const { calcRowAmount } = require('../../utils/purchaseCalc')

// A discrepancy under this is treated as OCR/rounding noise, not a real
// mismatch — printed bills routinely round to whole rupees, and a
// scanned total 0.5 off from a computed one is not worth a warning.
const AMOUNT_TOLERANCE = 1.0

function mismatch(scanned, calculated, tolerance = AMOUNT_TOLERANCE) {
  if (scanned === null || scanned === undefined) return false
  return Math.abs(Number(scanned) - Number(calculated)) > tolerance
}

/**
 * Reconciles one line item: recomputes amount/cc_amount from
 * qty/rate/free_qty/cc_pct via the real formula, and flags it against
 * whatever the OCR also read off the CC Amount / Total columns (if any).
 *
 * Returns the item with two extra blocks:
 *   calculated: { amount, cc_amount }        — the source of truth
 *   flags: { cc_amount_mismatch, line_total_mismatch, low_confidence, missing_required }
 */
function reconcileLineItem(item) {
  const calculated = calcRowAmount({
    qty: item.qty, rate: item.rate, bonus: item.free_qty, cc_pct: item.cc_pct,
  })

  const flags = {
    cc_amount_mismatch: item.cc_pct > 0 && mismatch(item.cc_amount_scanned, calculated.cc_amount),
    line_total_mismatch: mismatch(item.line_total_scanned, calculated.amount),
    low_confidence: (item.ocr_confidence ?? 1) < 0.55,
    missing_required: !item.product_name || item.qty === null || item.rate === null,
  }

  return { ...item, calculated, flags }
}

/**
 * Reconciles the whole bill: every line via reconcileLineItem, plus the
 * header's scanned subtotal/CC/grand-total against the sum of the
 * (now-correct) line amounts.
 */
function reconcileBill(header, items) {
  const reconciledItems = items.map(reconcileLineItem)

  const calculatedSubtotal = +reconciledItems.reduce((s, it) => s + it.calculated.amount, 0).toFixed(2)
  const calculatedCcTotal  = +reconciledItems.reduce((s, it) => s + it.calculated.cc_amount, 0).toFixed(2)
  // Same rounding rule routes/purchases.js applies at save time (round
  // to nearest whole number) — shown here so the review screen's
  // "calculated grand total" is the actual number that will be saved,
  // not an unrounded preview that then surprises the user after confirm.
  const calculatedGrandTotal = Math.round(calculatedSubtotal)

  const scannedSubtotal   = header.subtotal?.value ?? null
  const scannedCcAmount   = header.cc_amount_header?.value ?? null
  const scannedGrandTotal = header.grand_total?.value ?? null

  const billFlags = {
    subtotal_mismatch:    mismatch(scannedSubtotal, calculatedSubtotal),
    cc_amount_mismatch:   mismatch(scannedCcAmount, calculatedCcTotal),
    grand_total_mismatch: mismatch(scannedGrandTotal, calculatedGrandTotal, 1.0),
    any_line_needs_review: reconciledItems.some(it =>
      it.flags.cc_amount_mismatch || it.flags.line_total_mismatch ||
      it.flags.low_confidence || it.flags.missing_required
    ),
  }

  return {
    items: reconciledItems,
    calculated: {
      subtotal: calculatedSubtotal,
      cc_amount_total: calculatedCcTotal,
      grand_total: calculatedGrandTotal,
    },
    flags: billFlags,
    // true when ANYTHING here needs a human's eyes before this can be
    // saved as-is — the review screen uses this single boolean to decide
    // whether to show the "⚠️ review required" banner at all.
    needs_review: billFlags.subtotal_mismatch || billFlags.cc_amount_mismatch ||
      billFlags.grand_total_mismatch || billFlags.any_line_needs_review,
  }
}

module.exports = { reconcileLineItem, reconcileBill, mismatch, AMOUNT_TOLERANCE }
