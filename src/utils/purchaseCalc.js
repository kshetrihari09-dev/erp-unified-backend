/**
 * utils/purchaseCalc.js — server-side purchase line/total calculation.
 *
 * This is a deliberate PORT of erp-enterprise-full/src/utils/index.ts's
 * `calcRowAmount` / `calcInvoiceTotals` — not a reimplementation from the
 * spec. The two apps are separate Node/TS projects with no shared
 * package, so "reuse the existing calculation" has to mean "the same
 * formula, typed out twice and kept in sync," not a literal import.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * Before this fix, the backend's inline calculation in routes/purchases.js
 * used a DIFFERENT formula than the one the Purchase screen shows the user
 * live: `cc_amount = qty × rate × cc_pct/100` (CC on the purchased qty),
 * versus the frontend's `cc_amount = bonus × rate × cc_pct/100` (CC on the
 * free/bonus qty). Worse, the manual-entry save payload never even sent
 * `cc_pct` to the backend, so a CC% typed into the Purchase screen was
 * silently discarded on save — the backend always computed cc_amount = 0.
 *
 * Fixed here to match the frontend's bonus-qty formula (confirmed
 * decision), and PurchasePage.tsx's submit payload now sends cc_pct so it
 * actually persists. See CHANGES.md for the full writeup.
 *
 * IF utils/index.ts::calcRowAmount ever changes, this file must change
 * with it — there is no automated check for that today (see the note in
 * CHANGES.md about a possible future shared-formula test).
 */
'use strict'

/**
 * One purchase line.
 *
 * @param {{ qty: number, rate: number, bonus?: number, cc_pct?: number }} row
 * @returns {{ amount: number, cc_amount: number }}
 */
function calcRowAmount(row) {
  const qty    = Number(row.qty    || 0)
  const rate   = Number(row.rate   || 0)
  const bonus  = Number(row.bonus  || 0)  // bonus qty drives cc_amount
  const cc_pct = Number(row.cc_pct || 0)  // whole number, e.g. 10 = 10%

  // purchase_items has no discount_pct column — purchase entry has never
  // supported a per-line discount (see the existing F7 shortcut message
  // in PurchasePage.tsx: "Purchase invoices don't have a discount %").
  // So base is qty × rate, with no discount term — matching what
  // calcRowAmount on the frontend also reduces to whenever
  // discount_pct is 0, which is every purchase line today.
  const base = qty * rate

  // cc_amount = bonus_qty × rate × (cc_pct / 100) — CC on the BONUS
  // (free) quantity, not the purchased quantity. This is the frontend's
  // formula; it is now also the backend's.
  const cc_amt = bonus > 0 && cc_pct > 0
    ? +(bonus * rate * (cc_pct / 100)).toFixed(4)
    : 0

  const amount = +(base + cc_amt).toFixed(2)
  return { amount, cc_amount: +cc_amt.toFixed(2) }
}

/**
 * Sum of calcRowAmount(...).amount across every line — the purchase's
 * pre-round-off subtotal. routes/purchases.js applies round-off on top
 * of this, unchanged from before this fix.
 */
function calcPurchaseSubtotal(rows) {
  return rows.reduce((sum, r) => sum + calcRowAmount(r).amount, 0)
}

module.exports = { calcRowAmount, calcPurchaseSubtotal }
