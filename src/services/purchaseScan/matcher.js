/**
 * services/purchaseScan/matcher.js — match extracted lines/supplier
 * against the company's existing catalog. Never creates anything: spec
 * #6 is explicit that duplicate products must not be auto-created, so
 * every result here is a suggestion for the review screen to accept,
 * swap, or leave for manual product search.
 *
 * Match status, in order of how it's decided:
 *   matched        — an exact barcode or item_code hit. Ambiguity-free,
 *                     since those are unique per company (products
 *                     table's unique constraints).
 *   possible_match  — no exact code hit; best name/manufacturer
 *                     similarity clears a "plausible, but confirm it"
 *                     threshold. Comes with up to 3 ranked candidates.
 *   not_found       — nothing cleared even the possible-match threshold.
 */
'use strict'

const { similarity } = require('./similarity')

const POSSIBLE_MATCH_THRESHOLD = 0.45  // below this, don't even suggest — noise, not a lead
const CONFIDENT_MATCH_THRESHOLD = 0.82 // a name/manufacturer match this close is auto-selected,
                                        // same confidence tier as a code hit, but still shown as
                                        // "possible" (not "matched") because no exact identifier
                                        // was involved — the reviewer sees why either way.

/**
 * @param {object} item - one parsed line item (see invoiceParser.js output shape)
 * @param {object[]} products - the company's product list, as returned by
 *   productsAPI.list() on the frontend / GET /products on the backend:
 *   { id, item_code, barcode, name, generic_name, company_name, unit, ... }
 */
function matchProduct(item, products) {
  const codeCandidates = [item.code].filter(Boolean).map(c => String(c).trim().toLowerCase())

  if (codeCandidates.length) {
    const exact = products.find(p =>
      (p.barcode && codeCandidates.includes(String(p.barcode).trim().toLowerCase())) ||
      (p.item_code && codeCandidates.includes(String(p.item_code).trim().toLowerCase()))
    )
    if (exact) {
      return { status: 'matched', product_id: exact.id, matched_via: 'code', candidates: [] }
    }
  }

  // Name (+ manufacturer as a secondary signal) similarity against every
  // active product. O(items × products) — fine at the sizes this
  // actually runs at (a bill has a few dozen lines at most, a company's
  // catalog is at most a few thousand products; this is a few hundred
  // thousand bigram comparisons, each sub-millisecond).
  const scored = products
    .filter(p => p.is_active !== false)
    .map(p => {
      const nameScore = similarity(item.product_name || '', p.name || '')
      const genericScore = similarity(item.product_name || '', p.generic_name || '')
      const mfgScore = item.manufacturer ? similarity(item.manufacturer, p.company_name || '') : 0
      // Manufacturer is corroborating evidence, not a primary signal —
      // weighted low so a strong name match isn't dragged down by a
      // manufacturer field the OCR missed or misread.
      const score = Math.max(nameScore, genericScore) * 0.85 + mfgScore * 0.15
      return { product: p, score }
    })
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best || best.score < POSSIBLE_MATCH_THRESHOLD) {
    return { status: 'not_found', product_id: null, matched_via: null, candidates: [] }
  }

  const candidates = scored.slice(0, 3).map(s => ({
    product_id: s.product.id,
    name: s.product.name,
    company_name: s.product.company_name || null,
    score: +s.score.toFixed(2),
  }))

  return {
    status: 'possible_match',
    // Pre-select the top candidate only when it's confidently ahead —
    // otherwise leave product_id null so the review screen makes the
    // user actually choose, rather than defaulting to a guess.
    product_id: best.score >= CONFIDENT_MATCH_THRESHOLD ? best.product.id : null,
    matched_via: 'name',
    candidates,
  }
}

/**
 * @param {{value:string}|null} supplierField - header.supplier_name from invoiceParser.js
 * @param {object[]} suppliers - parties of type 'supplier' for this company
 */
function matchSupplier(supplierField, suppliers) {
  const name = supplierField?.value
  if (!name) return { status: 'not_found', party_id: null, candidates: [] }

  const scored = suppliers
    .filter(s => s.is_active !== false)
    .map(s => ({ supplier: s, score: similarity(name, s.name || '') }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best || best.score < POSSIBLE_MATCH_THRESHOLD) {
    return { status: 'not_found', party_id: null, candidates: [] }
  }

  const candidates = scored.slice(0, 3).map(s => ({
    party_id: s.supplier.id, name: s.supplier.name, score: +s.score.toFixed(2),
  }))

  return {
    status: best.score >= CONFIDENT_MATCH_THRESHOLD ? 'matched' : 'possible_match',
    party_id: best.score >= CONFIDENT_MATCH_THRESHOLD ? best.supplier.id : null,
    candidates,
  }
}

module.exports = { matchProduct, matchSupplier, POSSIBLE_MATCH_THRESHOLD, CONFIDENT_MATCH_THRESHOLD }
