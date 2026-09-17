/**
 * services/purchaseScan/similarity.js — bounded local string similarity.
 *
 * A small hand-rolled Dice's-coefficient (bigram overlap) scorer, not an
 * npm dependency. The matching this feature needs — "is this OCR'd
 * product name close to this catalog name" — is a well-bounded, purely
 * local computation with no reason to pull in a package for it (and no
 * such package was already a dependency of either app).
 *
 * Dice's coefficient over character bigrams was chosen over Levenshtein
 * distance because OCR errors on invoices are dominated by whole-word
 * substitutions and reordering (misread words, extra "MFG:" prefixes,
 * abbreviation differences) rather than single-character typos —
 * bigram overlap tolerates word-order differences and partial strings
 * far better than an edit-distance metric would.
 */
'use strict'

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function bigrams(s) {
  const clean = s.replace(/\s+/g, ' ')
  const grams = new Map()
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2)
    grams.set(g, (grams.get(g) || 0) + 1)
  }
  return grams
}

/** Dice's coefficient: 2 × |shared bigrams| / (|bigrams(a)| + |bigrams(b)|).
 *  Returns 0–1. Identical strings → 1. No overlap, or either string
 *  under 2 characters → 0 (too short for bigrams to mean anything). */
function diceCoefficient(a, b) {
  const na = normalize(a), nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0

  const ga = bigrams(na), gb = bigrams(nb)
  let shared = 0
  for (const [g, count] of ga) {
    if (gb.has(g)) shared += Math.min(count, gb.get(g))
  }
  const total = [...ga.values()].reduce((s, c) => s + c, 0) + [...gb.values()].reduce((s, c) => s + c, 0)
  return total === 0 ? 0 : (2 * shared) / total
}

/** Token-set overlap as a secondary signal — catches "Paracetamol 500mg
 *  Cipla" vs "Cipla Paracetamol Tab 500" (same tokens, different order
 *  and some extra words) better than pure bigram overlap alone. */
function tokenOverlap(a, b) {
  const ta = new Set(normalize(a).split(' ').filter(Boolean))
  const tb = new Set(normalize(b).split(' ').filter(Boolean))
  if (!ta.size || !tb.size) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / Math.max(ta.size, tb.size)
}

/** Blended 0–1 similarity score used throughout productMatcher.js /
 *  supplierMatcher.js. Weighted toward bigrams (handles OCR character
 *  noise) with token overlap as a smaller correction for word reordering. */
function similarity(a, b) {
  return 0.7 * diceCoefficient(a, b) + 0.3 * tokenOverlap(a, b)
}

module.exports = { similarity, diceCoefficient, tokenOverlap, normalize }
