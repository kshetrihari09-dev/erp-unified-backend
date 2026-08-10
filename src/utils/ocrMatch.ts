/**
 * ocrMatch.ts
 *
 * Turns raw, noisy OCR text into normalized text, then scores it against
 * a list of candidate products using a dependency-free fuzzy similarity
 * (normalized Levenshtein distance + word-set overlap + substring
 * containment + OCR-confusion-aware comparison). No external fuzzy-
 * matching library was added — whole-string/token similarity over a
 * short OCR line handles this well without a heavier search index.
 *
 * Also owns multi-frame consensus (combineOcrSamples): the live scanner
 * is camera-based, so a single frame's text is never trusted alone —
 * several recent frames' normalized text is grouped and the most
 * frequently-repeated reading is treated as higher-confidence.
 */

export interface MatchCandidate {
  id:            string
  name:          string
  generic_name?: string
  company_name?: string
  item_code?:    string
  [key: string]: any
}

export interface ScoredMatch<T extends MatchCandidate = MatchCandidate> {
  product:      T
  score:        number // 0..1
  matchedField: string
}

// Confidence tiers — see useLocalScanner.ts for how these gate
// auto-select vs. "possible match" vs. "keep scanning + suggest" vs. "no
// match":
//   >=0.95            → auto-select
//   0.85–0.94         → "Possible match" (needs a tap to confirm)
//   0.70–0.84         → keep scanning, show suggestions
//   <0.70             → not shown, don't auto-select
export const MATCH_AUTO_THRESHOLD    = 0.95
export const MATCH_POSSIBLE_THRESHOLD = 0.85
export const MATCH_SUGGEST_THRESHOLD = 0.70
export const MATCH_SUGGEST_LIMIT     = 5

export type MatchTier = 'auto' | 'possible' | 'suggested' | 'none'

export function tierForScore(score: number): MatchTier {
  if (score >= MATCH_AUTO_THRESHOLD) return 'auto'
  if (score >= MATCH_POSSIBLE_THRESHOLD) return 'possible'
  if (score >= MATCH_SUGGEST_THRESHOLD) return 'suggested'
  return 'none'
}

// ── Common pharmaceutical words, ignored when scoring name similarity ────
// (strength/dosage tokens are deliberately NOT in this list — they're
// still used as supporting evidence, just scored separately below).
const PHARMA_STOP_WORDS = new Set([
  'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps',
  'syrup', 'suspension', 'injection', 'inj', 'drops', 'drop', 'ointment',
  'cream', 'gel', 'lotion', 'solution', 'sol', 'oral',
  'mg', 'mcg', 'ml', 'gm', 'g', 'iu',
  'usp', 'ip', 'bp', 'bpc', 'ph', 'eur',
  'strip', 'strips', 'bottle', 'pack', 'box', 'vial',
])

function stripStopWords(normText: string): string {
  const kept = normText.split(' ').filter(w => w && !PHARMA_STOP_WORDS.has(w))
  return kept.join(' ')
}

// ── Field-context-aware OCR mistake correction ─────────────────────────────
// Common OCR misreads on product packaging, each direction gated by
// context rather than applied blindly everywhere:
//   O↔0  I↔1  l↔1  S↔5  B↔8  Z↔2  G↔6   (letter/digit confusions)
//   rn↔m  cl↔d                          (multi-letter shape confusions)
export type OcrFieldType = 'name' | 'strength' | 'mrp' | 'batch' | 'expiry' | 'auto'

const DIGIT_TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' }
const LETTER_TO_DIGIT: Record<string, string> = { O: '0', o: '0', I: '1', l: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' }

function digitsToLetters(token: string): string {
  return token.replace(/[0125689]/g, ch => DIGIT_TO_LETTER[ch] ?? ch)
}

function lettersToDigits(token: string): string {
  return token.replace(/[OoIlSsBZzG]/g, ch => LETTER_TO_DIGIT[ch] ?? ch)
}

// Multi-letter shape confusions only make sense inside alphabetic (name)
// tokens — "rn" commonly gets misread for "m" and "cl" for "d" in
// condensed label fonts.
function fixShapeConfusions(token: string): string {
  return token.replace(/rn/g, 'm').replace(/cl/g, 'd')
}

// Per-token correction, direction chosen by majority character class
// (existing "auto" behavior) or forced by an explicit field type when the
// caller knows what kind of value this token should be — e.g. a product
// name favors an alphabetic interpretation, a strength/MRP field favors a
// numeric interpretation, a batch number is left mixed alphanumeric, and
// expiry keeps its date-like punctuation. This intentionally does NOT
// blindly replace characters everywhere; a token with no digits and no
// letters at all (pure punctuation) is returned unchanged.
function fixOcrToken(token: string, fieldType: OcrFieldType = 'auto'): string {
  if (fieldType === 'strength' || fieldType === 'mrp') return lettersToDigits(token)
  if (fieldType === 'batch' || fieldType === 'expiry') return token // mixed alphanumeric / date — leave as-is
  if (fieldType === 'name') return fixShapeConfusions(digitsToLetters(token))

  const letters = (token.match(/[A-Za-z]/g) || []).length
  const digits  = (token.match(/[0-9]/g) || []).length
  if (letters === 0 || digits === 0) return token
  if (digits > letters) return lettersToDigits(token)
  if (letters > digits) return digitsToLetters(token)
  return token
}

// Lowercase, trim, collapse whitespace, strip punctuation, and apply the
// per-token OCR correction above. Idempotent — safe to call on both the
// live OCR text and each candidate's own fields before comparing them.
export function normalizeOcrText(raw: string, fieldType: OcrFieldType = 'auto'): string {
  if (!raw) return ''
  const corrected = raw
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => fixOcrToken(tok, fieldType))
    .join(' ')

  return corrected
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// Pull a strength/dosage token ("500mg", "5 ml", "250mcg") out of raw OCR
// text, numeric-corrected — used as supporting evidence alongside the
// name match, not as the primary signal.
export function extractStrength(raw: string): string | null {
  const m = raw.match(/(\d[\dOoIlSsBZzG]*)\s*(mg|mcg|ml|gm?|iu)\b/i)
  if (!m) return null
  return `${lettersToDigits(m[1]).toLowerCase()}${m[2].toLowerCase()}`
}

// ── Similarity scoring ────────────────────────────────────────────────────
function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1])
      prevDiag = temp
    }
  }
  return dp[n]
}

// 1.0 = identical, 0.0 = completely different, scaled by the longer
// string's length so short and long fields are comparable.
function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshteinDistance(a, b) / maxLen
}

// Word-set overlap — catches cases where OCR read the right words in a
// different order or with an extra/missing word, which whole-string
// Levenshtein alone penalizes too harshly.
function tokenJaccard(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean))
  const setB = new Set(b.split(' ').filter(Boolean))
  if (setA.size === 0 || setB.size === 0) return 0
  let intersect = 0
  for (const t of setA) if (setB.has(t)) intersect++
  const union = setA.size + setB.size - intersect
  return union === 0 ? 0 : intersect / union
}

// If the OCR text is a label with extra surrounding text (or vice versa),
// and one string fully contains the other, that's very likely the right
// product even though whole-string Levenshtein would score it poorly due
// to the length difference.
function containmentBoost(a: string, b: string): number {
  if (!a || !b) return 0
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length < 3 || !longer.includes(shorter)) return 0
  return 0.9 + 0.1 * (shorter.length / longer.length)
}

// Re-normalizes both strings with the OCR-confusion map forced toward an
// alphabetic reading (fieldType 'name'), so a candidate name and an OCR
// reading that differ only by a 0/O, 1/I, rn/m, etc. confusion still
// score as a near-exact match instead of being penalized as different
// characters by plain Levenshtein.
function confusionAwareSimilarity(a: string, b: string): number {
  const ca = normalizeOcrText(a, 'name')
  const cb = normalizeOcrText(b, 'name')
  return levenshteinSimilarity(ca, cb)
}

function fieldScore(normField: string, normText: string): number {
  if (!normField || !normText) return 0
  return Math.max(
    levenshteinSimilarity(normField, normText),
    tokenJaccard(normField, normText),
    containmentBoost(normField, normText),
    confusionAwareSimilarity(normField, normText),
  )
}

// Scores `ocrText` against every candidate's name / generic name / brand
// (company) name / item code, taking each candidate's single best-matching
// field, and returns all candidates ranked best-first.
//
// Name/generic-name comparisons also try a stop-word-stripped version of
// both strings (dropping "tablet", "mg", "syrup", etc.) — those words are
// common across many unrelated products and otherwise dilute the
// signal — while item codes are still compared unstripped (a code has no
// pharma words to strip in the first place). Strength (dosage) extracted
// from the OCR text is used as supporting evidence: candidates whose name
// contains the same strength get a small boost, which helps disambiguate
// "Paracetamol 500mg" from "Paracetamol 650mg" when the base-name score
// alone would tie them.
export function matchProduct<T extends MatchCandidate>(ocrText: string, candidates: T[]): ScoredMatch<T>[] {
  const normText = normalizeOcrText(ocrText)
  if (!normText) return []
  const strippedText = stripStopWords(normText)
  const ocrStrength = extractStrength(ocrText)

  const fieldsOf = (c: T): Array<[string, string | undefined, boolean]> => [
    ['name', c.name, true],
    ['generic_name', c.generic_name, true],
    ['company_name', c.company_name, false],
    ['item_code', c.item_code, false],
  ]

  const scored: ScoredMatch<T>[] = candidates.map(c => {
    let best = 0, bestField = 'name'
    for (const [key, value, stoppable] of fieldsOf(c)) {
      if (!value) continue
      const normValue = normalizeOcrText(value)
      let s = fieldScore(normValue, normText)
      if (stoppable) {
        const strippedValue = stripStopWords(normValue)
        s = Math.max(s, fieldScore(strippedValue, strippedText))
      }
      if (s > best) { best = s; bestField = key }
    }

    // Strength as supporting evidence only — nudges the score, never
    // dominates it, and never fires for a candidate that barely matched
    // on name in the first place.
    if (best > 0.4 && ocrStrength) {
      const candidateStrength = extractStrength(c.name || '')
      if (candidateStrength && candidateStrength === ocrStrength) best = Math.min(1, best + 0.05)
    }

    return { product: c, score: best, matchedField: bestField }
  })

  return scored.sort((a, b) => b.score - a.score)
}

// ── Multi-frame consensus ──────────────────────────────────────────────────
// The scanner is live-camera based, so a single frame's OCR text is never
// trusted alone. Given a rolling buffer of recent normalized readings
// (e.g. "paracetamol 500mg", "paracetam0l 500mg", "paracetamol 500 mg"),
// groups near-duplicate readings together (using the same confusion-aware
// + token-overlap similarity as product matching) and returns the most-
// repeated group's representative text plus how many times it recurred —
// repeated agreement across frames is stronger evidence than any single
// frame, however clean that one frame looked.
export interface ConsensusResult {
  text:  string
  count: number
  total: number
}

const CONSENSUS_SIMILARITY = 0.82

export function combineOcrSamples(samples: string[]): ConsensusResult | null {
  const clean = samples.map(s => normalizeOcrText(s)).filter(s => s.length >= 3)
  if (clean.length === 0) return null

  const groups: { rep: string; members: string[] }[] = []
  for (const sample of clean) {
    let placed = false
    for (const group of groups) {
      const sim = Math.max(
        levenshteinSimilarity(sample, group.rep),
        tokenJaccard(sample, group.rep),
        confusionAwareSimilarity(sample, group.rep),
      )
      if (sim >= CONSENSUS_SIMILARITY) {
        group.members.push(sample)
        // Prefer the longest member as the group's representative text —
        // a longer clean read usually carries more usable signal than a
        // truncated one.
        if (sample.length > group.rep.length) group.rep = sample
        placed = true
        break
      }
    }
    if (!placed) groups.push({ rep: sample, members: [sample] })
  }

  groups.sort((a, b) => b.members.length - a.members.length)
  const top = groups[0]
  return { text: top.rep, count: top.members.length, total: clean.length }
}
