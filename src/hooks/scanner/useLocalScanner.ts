/**
 * useLocalScanner.ts
 *
 * Local (same-device) scanner engine — the default entry point used by
 * ScanButton on the Sales/Purchase pages.
 *
 * All camera/zoom/flash/camera-switch/barcode-decode concerns now come
 * from the shared useBarcodeEngine hook (see useBarcodeEngine.ts) — the
 * exact same engine the Product Add scanner (useProductCapture.ts) uses —
 * so both scanners are guaranteed identical camera behavior and
 * performance. This file only adds what's specific to billing lookups:
 *
 *   - OCR reads a configurable, centered "scan box" (see ocrImage.ts) —
 *     not the full camera frame — cropped exactly to what the dimmed
 *     overlay shows on screen, at one of four selectable aspect ratios
 *     (2:1 / 3:2 / 4:3 / 16:9, default 3:2). The box size is recomputed
 *     from the live container size on every ratio change AND on resize/
 *     orientation change, so the overlay and the actual crop can never
 *     drift apart.
 *   - A single Tesseract worker is created once per session and reused,
 *     instead of a brand new worker per tick. Its page-segmentation mode
 *     is only reconfigured when the selected ratio actually changes.
 *   - The OCR loop is self-scheduling (next tick is only scheduled once
 *     the previous recognize() call has fully resolved), so overlapping/
 *     duplicate OCR requests are structurally impossible, and never runs
 *     more than one preprocessing variant's worth of work per tick unless
 *     the first attempt came back empty.
 *   - Several recent frames' OCR text are combined (see combineOcrSamples
 *     in ocrMatch.ts) into a consensus reading before it's scored against
 *     candidates — a single frame is never trusted alone.
 *   - OCR text is normalized and scored against candidates with a fuzzy,
 *     OCR-confusion-aware similarity — see ocrMatch.ts. >=95% similarity
 *     auto-selects the product immediately (same as a barcode hit);
 *     85-94% surfaces a "possible match" the user must tap to confirm;
 *     70-84% keeps scanning while showing lightweight suggestions; below
 *     70% is treated as "no match" and scanning continues automatically.
 *   - Scanning stops the instant a confident (auto or possible) match is
 *     found, and only resumes when the user taps "Scan Again" (rescan())
 *     or dismisses the possible-match sheet.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { scannerAPI } from '@/services/api'
import type { ScanResult, ScannedProduct } from '@/types/scanner'
import useBarcodeEngine from './useBarcodeEngine'
import {
  preprocessForOcr, captureScanBoxFrame, generateOcrVariants, computeScanBoxSize,
  OCR_RATIO_PRESETS, DEFAULT_OCR_RATIO_ID, type OcrVariant,
} from '@/utils/ocrImage'
import {
  normalizeOcrText, matchProduct, combineOcrSamples, tierForScore,
  MATCH_SUGGEST_LIMIT,
  type MatchTier,
} from '@/utils/ocrMatch'

export { OCR_RATIO_PRESETS, DEFAULT_OCR_RATIO_ID } // re-exported for the ratio selector UI

// Minimum gap between the END of one OCR recognize() call and the START
// of the next. Deliberately short — the scan box is compact, so each
// recognize() call is fast, and the self-scheduling loop already prevents
// overlap regardless of how long a given call takes.
const OCR_TICK_GAP_MS = 250

// Page-segmentation mode per scan ratio. A narrow 2:1 box is a
// barcode-style single line (PSM 7); the default 3:2 "product name" box
// is treated as a small text block (PSM 6); the taller 4:3 label box and
// the widest 16:9 full-package box both tend to contain several
// disconnected blocks of text, so sparse-text modes (11 / 12, the latter
// also attempting orientation detection) suit them better.
const RATIO_PSM: Record<string, string> = {
  '2:1':  '7',
  '3:2':  '6',
  '4:3':  '11',
  '16:9': '12',
}

// Order preprocessing variants are escalated through when the current
// attempt keeps coming back empty/unreadable — starting from the
// cheapest, most broadly reliable one (Otsu) rather than always paying
// for every variant on every tick (see ocrImage.ts's generateOcrVariants).
const VARIANT_ESCALATION: OcrVariant['id'][] = ['otsu', 'adaptive', 'contrast', 'sharpened', 'original', 'inverted']

// How many recent frames' OCR text are combined into a consensus reading
// before scoring against candidates.
const CONSENSUS_BUFFER_SIZE = 5

// Rotating on-device feedback messages shown after several consecutive
// ticks fail to read anything usable — never a raw Tesseract error.
const QUALITY_HINTS = ['Hold steady', 'Move closer', 'Improve lighting', 'Place product text inside the box']
const QUALITY_HINT_STRIKES = 4 // consecutive empty ticks before the first hint appears

// Exact copy of the message the backend returns for QR_ACCOUNT_MISMATCH
// (see erp-unified-backend/src/scanner/scannerRoutes.js) — a structured
// QR payload whose accountId doesn't match the account the user is
// currently logged into. Kept as a literal here (rather than trusting
// whatever string the server sends) so the UI copy stays consistent even
// if a future response is malformed; the `code` field is still what
// actually drives the branch below.
const QR_ACCOUNT_MISMATCH_MSG = 'This QR Code belongs to another account and cannot be used in the current account.'

export type LocalScanMode   = 'barcode' | 'ocr' | 'idle'
export type LocalScanStatus =
  | 'requesting-permission'
  | 'denied'
  | 'scanning'
  | 'matches'
  | 'submitting'
  | 'done'
  | 'error'

// Same shape as useMobileScanner's MobileProduct — intermediate list item
// before a match is hydrated into a full ScannedProduct on selection.
export interface LocalProduct {
  id:             string
  item_code:      string
  name:           string
  generic_name?:  string
  company_name?:  string
  unit:           string
  sales_rate:     number
  purchase_rate:  number
  current_stock?: number
}

export interface LocalScannerState {
  status:      LocalScanStatus
  mode:        LocalScanMode
  matches:     LocalProduct[]
  matchTier:   MatchTier              // which confidence tier `matches` came from ('auto'/'possible')
  suggestions: LocalProduct[]         // 70-84% band — shown inline, doesn't stop scanning
  error:       string | null
  notice:      string | null // transient "no match yet" feedback — scanning keeps going
  qualityHint: string | null // "Move closer" etc. after repeated unreadable frames
  flashOn:     boolean
  flashSupported: boolean
  facingMode:  'environment' | 'user'
  ocrProgress: number
  ocrRatio:    string        // selected OCR_RATIO_PRESETS id, e.g. '3:2'
  boxWidth:    number        // current on-screen scan-box size (CSS px) — overlay + crop share this
  boxHeight:   number
  lastBarcode: string | null
  lastOcrText: string | null
  lastResult:  ScanResult | null
  // Digital zoom — see useBarcodeEngine.ts for why it's CSS scale + a
  // matching canvas crop rather than MediaTrackConstraints.zoom.
  // zoomSupported is always true (digital zoom works on every device);
  // kept as a field so LocalScannerView doesn't need an unrelated
  // prop-shape change.
  zoomSupported: boolean
  zoomMin:       number
  zoomMax:       number
  zoomStep:      number
  zoom:          number
}

interface Options {
  context:  'sales' | 'purchase'
  onResult: (result: ScanResult) => void
  active:   boolean   // whether the scanner view is currently open
}

const INITIAL_STATE: LocalScannerState = {
  status: 'requesting-permission', mode: 'idle', matches: [], matchTier: 'none', suggestions: [],
  error: null, notice: null, qualityHint: null, flashOn: false, flashSupported: false, facingMode: 'environment',
  ocrProgress: 0, ocrRatio: DEFAULT_OCR_RATIO_ID, boxWidth: 240, boxHeight: 160,
  lastBarcode: null, lastOcrText: null, lastResult: null,
  zoomSupported: true, zoomMin: 1, zoomMax: 3, zoomStep: 0.1, zoom: 1,
}

export default function useLocalScanner({ onResult, active }: Options) {
  const [state, setState] = useState<LocalScannerState>(INITIAL_STATE)

  const engine = useBarcodeEngine()
  const { videoRef, containerRef } = engine

  const mountedRef       = useRef(true)
  const manualModeRef    = useRef<LocalScanMode | null>(null)   // set by user's Barcode/OCR toggle
  const ocrTimer         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ocrWorkerRef     = useRef<any>(null)    // persistent Tesseract worker for this session
  const ocrWorkerPromise = useRef<Promise<any> | null>(null) // avoids creating two workers if init overlaps
  const ocrLoopActiveRef = useRef(false)        // whether the self-scheduling OCR loop should keep going
  const ocrBusyRef       = useRef(false)        // true for the duration of one recognize() call
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ratio/box-size bookkeeping. ocrRatioRef mirrors state.ocrRatio for the
  // synchronous tick loop; lastAppliedPsmRef avoids reconfiguring the
  // (reused) Tesseract worker on every tick — only when the ratio (and so
  // the desired PSM) actually changed since the last recognize() call.
  const ocrRatioRef    = useRef<string>(DEFAULT_OCR_RATIO_ID)
  const lastAppliedPsmRef = useRef<string | null>(null)
  // Mirrors state.boxWidth/boxHeight and engine.state.zoom into refs for
  // ocrTick's self-recursive loop to read synchronously. ocrTick is a
  // stable (rarely-recreated) closure that re-schedules itself via
  // `setTimeout(ocrTick, ...)` — if it captured these values directly
  // from `state`/`engine.state` in its dependency array, a resize/ratio/
  // zoom change mid-loop would keep recursing on the STALE closure
  // (the one already running) rather than picking up the new numbers
  // until the loop was manually restarted. Reading through refs instead
  // means every tick — including ones already in flight — always sees
  // the current box size and zoom.
  const boxSizeRef = useRef({ width: INITIAL_STATE.boxWidth, height: INITIAL_STATE.boxHeight })
  const zoomLevelRef = useRef(1)

  // Rolling buffer of this session's last few normalized OCR readings,
  // for multi-frame consensus (see combineOcrSamples in ocrMatch.ts).
  const sampleBufferRef   = useRef<string[]>([])
  const lastQueriedTextRef = useRef<string>('')
  // Consecutive ticks that produced no usable text — drives which
  // preprocessing variant is tried next and the on-screen quality hint.
  const failStreakRef = useRef(0)

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // ── Mirror the shared engine's camera state into this hook's state so
  //    LocalScannerView keeps reading a single, familiar `state` shape ──────
  useEffect(() => {
    setState(s => ({
      ...s,
      flashOn:        engine.state.flashOn,
      flashSupported: engine.state.flashSupported,
      facingMode:     engine.state.facingMode,
      zoomSupported:  true,
      zoomMin:        engine.state.zoomMin,
      zoomMax:        engine.state.zoomMax,
      zoomStep:       engine.state.zoomStep,
      zoom:           engine.state.zoom,
    }))
  }, [engine.state.flashOn, engine.state.flashSupported, engine.state.facingMode, engine.state.zoomMin, engine.state.zoomMax, engine.state.zoomStep, engine.state.zoom])

  useEffect(() => { zoomLevelRef.current = engine.state.zoom }, [engine.state.zoom])
  useEffect(() => { boxSizeRef.current = { width: state.boxWidth, height: state.boxHeight } }, [state.boxWidth, state.boxHeight])

  // ── Scan-box sizing: single source of truth shared with the overlay ──────
  // Recomputed whenever the container resizes (including orientation
  // changes) or the ratio changes, via computeScanBoxSize() — the exact
  // same function captureScanBoxFrame's caller (ocrTick, below) uses, so
  // the visible box and the actual OCR crop never disagree.
  const recomputeBoxSize = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const { width, height } = computeScanBoxSize(rect.width, rect.height, ocrRatioRef.current)
    setState(s => (s.boxWidth === width && s.boxHeight === height ? s : { ...s, boxWidth: width, boxHeight: height }))
  }, [containerRef])

  useEffect(() => {
    if (!active) return
    recomputeBoxSize()
    const el = containerRef.current
    let ro: ResizeObserver | null = null
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => recomputeBoxSize())
      ro.observe(el)
    }
    const onOrientation = () => recomputeBoxSize()
    window.addEventListener('resize', onOrientation)
    window.addEventListener('orientationchange', onOrientation)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onOrientation)
      window.removeEventListener('orientationchange', onOrientation)
    }
  }, [active, containerRef, recomputeBoxSize])

  // ── OCR worker lifecycle ─────────────────────────────────────────────────
  const terminateOcrWorker = useCallback(() => {
    const worker = ocrWorkerRef.current
    ocrWorkerRef.current = null
    ocrWorkerPromise.current = null
    lastAppliedPsmRef.current = null
    if (worker) worker.terminate().catch(() => {})
  }, [])

  const stopOcrLoop = useCallback(() => {
    ocrLoopActiveRef.current = false
    if (ocrTimer.current) { clearTimeout(ocrTimer.current); ocrTimer.current = null }
  }, [])

  const stopCamera = useCallback(() => {
    engine.closeCamera()
    if (ocrTimer.current)         { clearTimeout(ocrTimer.current);      ocrTimer.current = null }
    if (noticeTimeoutRef.current) { clearTimeout(noticeTimeoutRef.current); noticeTimeoutRef.current = null }
    ocrLoopActiveRef.current = false
    terminateOcrWorker()
  }, [engine, terminateOcrWorker])

  // ── Product search (same backend endpoints as before) ──────────────────────
  // Return type grows a third case: the backend can now reject a scan
  // outright (403 QR_ACCOUNT_MISMATCH) when the decoded QR is a structured
  // payload printed under a *different* account than the one currently
  // logged in. That's a deliberate, permanent "no" — falling back to OCR
  // or fuzzy search on the raw JSON text would be meaningless anyway, so
  // handleBarcodeDetected surfaces it immediately instead of continuing.
  //
  // Every lookup is scoped to the products belonging to the current
  // account (scannerAPI carries the logged-in account's auth context),
  // so OCR/barcode matching can never surface — let alone select — a
  // product belonging to a different company/account.
  const searchBarcode = useCallback(async (code: string): Promise<LocalProduct[] | 'ACCOUNT_MISMATCH'> => {
    try {
      const res = await scannerAPI.lookupBarcode(code)
      const json: any = res.data
      return json.success && json.data ? [json.data] : []
    } catch (err: any) {
      if (err?.response?.status === 403 && err?.response?.data?.code === 'QR_ACCOUNT_MISMATCH') {
        return 'ACCOUNT_MISMATCH'
      }
      return []
    }
  }, [])

  // Casts a slightly wider net than before (20 vs. 10) since ranking/
  // filtering now happens on the client against the normalized text —
  // more candidates to score against means a better chance the right one
  // is in the set at all.
  const searchFuzzy = useCallback(async (normalizedText: string): Promise<LocalProduct[]> => {
    try {
      if (normalizedText.length < 2) return []
      const res  = await scannerAPI.fuzzySearch(normalizedText.slice(0, 60), 20)
      const json: any = res.data
      return json.success ? (json.data || []) : []
    } catch { return [] }
  }, [])

  const flashNotice = useCallback((message: string) => {
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current)
    setState(s => ({ ...s, notice: message }))
    noticeTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setState(s => ({ ...s, notice: null }))
    }, 1400)
  }, [])

  // ── Select a match → hydrate to full ScannedProduct → resolve locally ─────
  //
  // Continuous multi-scan: this only PAUSES the decode loops (barcode RAF
  // loop + OCR tick loop) — it deliberately does NOT call stopCamera(), so
  // the live video stream and (if warmed up) the Tesseract OCR worker both
  // stay alive across items. LocalScannerView resumes scanning (rescan())
  // a short beat after each successful add, and since the camera never
  // actually closed, that resume is instant — no re-request of getUserMedia
  // between medicines. The camera only fully closes when the user taps ✕
  // or the scanner view itself unmounts.
  const selectProduct = useCallback(async (product: LocalProduct) => {
    if (!mountedRef.current) return
    setState(s => ({ ...s, status: 'submitting', suggestions: [] }))
    engine.stopScanning()
    stopOcrLoop()
    if (noticeTimeoutRef.current) { clearTimeout(noticeTimeoutRef.current); noticeTimeoutRef.current = null }
    try {
      let full: ScannedProduct | null = null
      if (typeof (product as any).current_stock === 'number' && (product as any).batches) {
        full = product as unknown as ScannedProduct
      } else {
        const res = await scannerAPI.lookupBarcode(product.item_code)
        const json: any = res.data
        full = json.success ? json.data : null
      }
      if (!mountedRef.current) return
      if (!full) {
        setState(s => ({ ...s, status: 'error', error: 'Could not load full product details. Please try again.' }))
        return
      }

      const result: ScanResult = {
        product:    full,
        scanMethod: state.lastBarcode ? 'barcode' : state.lastOcrText ? 'ocr' : 'manual',
        barcode:    state.lastBarcode,
        ocrText:    state.lastOcrText,
        scannedAt:  Date.now(),
      }

      setState(s => ({ ...s, status: 'done', lastResult: result }))
      onResult(result)
    } catch {
      if (mountedRef.current) setState(s => ({ ...s, status: 'error', error: 'Something went wrong. Please try again.' }))
    }
  }, [onResult, engine, stopOcrLoop, state.lastBarcode, state.lastOcrText])

  // ── OCR: scan-box-cropped, persistent-worker, self-scheduling loop ────────
  const getOcrWorker = useCallback(async () => {
    if (ocrWorkerRef.current) return ocrWorkerRef.current
    if (!ocrWorkerPromise.current) {
      ocrWorkerPromise.current = (async () => {
        const { createWorker } = await import('tesseract.js')
        const worker = await createWorker('eng', 1, {
          logger: (m: any) => {
            if (m.status === 'recognizing text' && mountedRef.current) {
              setState(s => ({ ...s, ocrProgress: Math.round(m.progress * 100) }))
            }
          },
        })
        const psm = RATIO_PSM[ocrRatioRef.current] || '6'
        await worker.setParameters({ tessedit_pageseg_mode: psm as any })
        lastAppliedPsmRef.current = psm
        ocrWorkerRef.current = worker
        return worker
      })()
    }
    return ocrWorkerPromise.current
  }, [])

  // Reconfigures the existing worker's PSM only if the ratio (and so the
  // desired mode) changed since the last call — never spins up a new
  // worker just to change this.
  const ensurePsmForRatio = useCallback(async (worker: any) => {
    const psm = RATIO_PSM[ocrRatioRef.current] || '6'
    if (lastAppliedPsmRef.current === psm) return
    await worker.setParameters({ tessedit_pageseg_mode: psm as any })
    lastAppliedPsmRef.current = psm
  }, [])

  // Applies the same normalize -> fuzzy-search -> score -> threshold pipeline
  // used by the live loop, but as a single call — shared by both the live
  // scan-box tick and the gallery-image path below. `strong` gates
  // whether a 'suggested' (70-84%) hit is allowed to populate the
  // blocking matches sheet (the gallery/manual path) or should only ever
  // populate the non-blocking `suggestions` list (the live tick loop,
  // which keeps scanning at that tier).
  const matchNormalizedText = useCallback(async (normalized: string, opts: { liveMode: boolean } = { liveMode: false }): Promise<MatchTier> => {
    if (normalized.length < 3) {
      if (!opts.liveMode) flashNotice('Could not read any text — try again')
      return 'none'
    }
    setState(s => ({ ...s, lastOcrText: normalized }))

    if (lastQueriedTextRef.current === normalized && opts.liveMode) return 'none' // avoid redundant identical queries
    lastQueriedTextRef.current = normalized

    const candidates = await searchFuzzy(normalized)
    if (!mountedRef.current) return 'none'
    if (candidates.length === 0) {
      if (!opts.liveMode) flashNotice('No matching product found')
      return 'none'
    }

    const ranked = matchProduct(normalized, candidates)
    const best = ranked[0]
    if (!best) { if (!opts.liveMode) flashNotice('No matching product found'); return 'none' }
    const tier = tierForScore(best.score)

    if (tier === 'auto') {
      await selectProduct(best.product as unknown as LocalProduct)
      return 'auto'
    }
    if (tier === 'possible') {
      const top = ranked.slice(0, MATCH_SUGGEST_LIMIT).map(r => r.product) as unknown as LocalProduct[]
      setState(s => ({ ...s, status: 'matches', matchTier: 'possible', matches: top, suggestions: [] }))
      return 'possible'
    }
    if (tier === 'suggested') {
      const top = ranked.slice(0, MATCH_SUGGEST_LIMIT).map(r => r.product) as unknown as LocalProduct[]
      if (opts.liveMode) {
        // Non-blocking — keeps scanning, just surfaces candidates the
        // user can tap without waiting for a stronger read.
        setState(s => ({ ...s, suggestions: top }))
      } else {
        setState(s => ({ ...s, status: 'matches', matchTier: 'suggested', matches: top }))
      }
      return 'suggested'
    }
    if (!opts.liveMode) flashNotice('No matching product found')
    return 'none'
  }, [searchFuzzy, selectProduct, flashNotice])

  const ocrTick = useCallback(async () => {
    if (!ocrLoopActiveRef.current || !mountedRef.current) return
    if (!videoRef.current || videoRef.current.readyState < 2 || !containerRef.current) {
      ocrTimer.current = setTimeout(ocrTick, OCR_TICK_GAP_MS)
      return
    }

    ocrBusyRef.current = true
    try {
      const rect = containerRef.current.getBoundingClientRect()
      const { width: boxW, height: boxH } = boxSizeRef.current
      const rawCanvas = captureScanBoxFrame(
        videoRef.current, rect.width, rect.height, boxW, boxH, zoomLevelRef.current,
      )
      if (!rawCanvas) return

      // Escalate through preprocessing variants as consecutive attempts
      // keep failing — cheapest/most-reliable (Otsu) first, never every
      // variant on every tick (see VARIANT_ESCALATION above).
      const variants = generateOcrVariants(rawCanvas, rawCanvas.width, rawCanvas.height)
      const variantId = VARIANT_ESCALATION[Math.min(failStreakRef.current, VARIANT_ESCALATION.length - 1)]
      const chosen = variants.find(v => v.id === variantId) || variants.find(v => v.id === 'otsu') || variants[0]

      const worker = await getOcrWorker()
      if (!mountedRef.current || !ocrLoopActiveRef.current) return
      await ensurePsmForRatio(worker)
      const { data: { text } } = await worker.recognize(chosen.canvas)
      if (!mountedRef.current || !ocrLoopActiveRef.current) return

      const normalized = normalizeOcrText(text)
      if (normalized.length < 3) {
        failStreakRef.current += 1
        const hint = failStreakRef.current >= QUALITY_HINT_STRIKES
          ? QUALITY_HINTS[Math.floor((failStreakRef.current - QUALITY_HINT_STRIKES) / 3) % QUALITY_HINTS.length]
          : null
        if (mountedRef.current) setState(s => (s.qualityHint === hint ? s : { ...s, qualityHint: hint }))
        return // nothing readable this tick — keep scanning
      }

      failStreakRef.current = 0
      if (mountedRef.current) setState(s => (s.qualityHint ? { ...s, qualityHint: null } : s))

      // Multi-frame consensus: fold this reading into the rolling buffer
      // and match against the most-repeated recent reading rather than
      // this single frame alone.
      const buf = sampleBufferRef.current
      buf.push(normalized)
      if (buf.length > CONSENSUS_BUFFER_SIZE) buf.shift()
      const consensus = combineOcrSamples(buf)
      const textToMatch = consensus?.text || normalized

      const outcome = await matchNormalizedText(textToMatch, { liveMode: true })
      if (outcome === 'auto' || outcome === 'possible') {
        ocrLoopActiveRef.current = false // stop the instant a strong match is found
        sampleBufferRef.current = []
      }
    } catch {
      // OCR failed this tick — just try again next tick, don't surface a
      // technical error to the user.
      failStreakRef.current += 1
    } finally {
      ocrBusyRef.current = false
      if (ocrLoopActiveRef.current && mountedRef.current) {
        ocrTimer.current = setTimeout(ocrTick, OCR_TICK_GAP_MS)
      }
    }
  }, [getOcrWorker, ensurePsmForRatio, matchNormalizedText, videoRef, containerRef])

  const startOcrLoop = useCallback(() => {
    if (ocrLoopActiveRef.current) return // already running — never start a second overlapping loop
    ocrLoopActiveRef.current = true
    sampleBufferRef.current = []
    failStreakRef.current = 0
    lastQueriedTextRef.current = ''
    ocrTick()
  }, [ocrTick])

  // ── Ratio selector (OCR mode only) ──────────────────────────────────────
  // Changing ratio never touches the barcode engine/loop — OCR and
  // barcode scan-region configuration are fully independent. Recomputes
  // the box size immediately (so the overlay updates without waiting for
  // a resize) and clears in-flight consensus samples, since they were
  // captured at the old box shape.
  const setOcrRatio = useCallback((ratioId: string) => {
    if (ocrRatioRef.current === ratioId) return
    ocrRatioRef.current = ratioId
    sampleBufferRef.current = []
    failStreakRef.current = 0
    lastQueriedTextRef.current = ''
    setState(s => ({ ...s, ocrRatio: ratioId, qualityHint: null }))
    recomputeBoxSize()
  }, [recomputeBoxSize])

  // ── Barcode scanning — delegates the actual decode loop to the shared
  //    engine; this is purely "what to do with a decoded code" ───────────────
  const handleBarcodeDetected = useCallback(async (code: string) => {
    if (!mountedRef.current) return
    setState(s => ({ ...s, lastBarcode: code }))

    const products = await searchBarcode(code)
    if (!mountedRef.current) return
    if (products === 'ACCOUNT_MISMATCH') {
      setState(s => ({ ...s, status: 'error', error: QR_ACCOUNT_MISMATCH_MSG }))
      return
    }
    if (products.length > 0) {
      setState(s => ({ ...s, status: 'matches', matchTier: 'auto', mode: 'barcode', matches: products }))
      return
    }

    const normalizedCode = normalizeOcrText(code)
    const fuzzy = await searchFuzzy(normalizedCode)
    if (!mountedRef.current) return
    if (fuzzy.length > 0) {
      setState(s => ({ ...s, status: 'matches', matchTier: 'suggested', mode: 'barcode', matches: fuzzy }))
    } else if (manualModeRef.current !== 'barcode') {
      setState(s => ({ ...s, mode: 'ocr' }))
      startOcrLoop()
    }
  }, [searchBarcode, searchFuzzy, startOcrLoop])

  const startBarcodeLoop = useCallback(() => {
    engine.startScanning(handleBarcodeDetected)
  }, [engine, handleBarcodeDetected])

  // ── Manual mode override (Barcode / OCR bottom-bar buttons) ────────────────
  const setMode = useCallback((mode: 'barcode' | 'ocr') => {
    manualModeRef.current = mode
    engine.stopScanning()
    stopOcrLoop()
    setState(s => ({ ...s, mode, status: 'scanning', ocrProgress: 0, notice: null, suggestions: [], qualityHint: null }))
    if (mode === 'barcode') startBarcodeLoop()
    else startOcrLoop()
  }, [engine, startBarcodeLoop, startOcrLoop, stopOcrLoop])

  // ── Flash / camera switch — thin passthroughs to the shared engine ────────
  const toggleFlash = useCallback(() => engine.toggleFlash(), [engine])

  const switchCamera = useCallback(async () => {
    const wasOcr = state.mode === 'ocr'
    ocrLoopActiveRef.current = false
    if (ocrTimer.current) { clearTimeout(ocrTimer.current); ocrTimer.current = null }
    setState(s => ({ ...s, mode: 'idle' }))
    const ok = await engine.switchCamera()
    if (ok && mountedRef.current) {
      const nextMode = manualModeRef.current || (wasOcr ? 'ocr' : 'barcode')
      setState(s => ({ ...s, status: 'scanning', mode: nextMode }))
      if (nextMode === 'ocr') startOcrLoop()
      // engine.switchCamera() already restarts the barcode decode loop
      // itself if it was active before the switch.
    }
  }, [engine, state.mode, startOcrLoop])

  const setZoom = useCallback((value: number) => engine.setZoom(value), [engine])

  // ── Rescan / retry ──────────────────────────────────────────────────────────
  const rescan = useCallback(async () => {
    engine.stopScanning()
    stopOcrLoop()
    manualModeRef.current = null
    sampleBufferRef.current = []
    failStreakRef.current = 0
    lastQueriedTextRef.current = ''
    setState(s => ({
      ...s, status: 'scanning', mode: 'barcode', matches: [], matchTier: 'none', suggestions: [],
      error: null, notice: null, qualityHint: null, lastBarcode: null, lastOcrText: null, ocrProgress: 0,
    }))
    const ok = engine.state.cameraStatus === 'ready' ? true : await engine.openCamera(engine.state.facingMode)
    if (ok) startBarcodeLoop()
  }, [engine, startBarcodeLoop, stopOcrLoop])

  const retryPermission = useCallback(async () => {
    const ok = await engine.retryPermission()
    if (ok && mountedRef.current) {
      setState(s => ({ ...s, status: 'scanning', mode: 'barcode' }))
      startBarcodeLoop()
    }
  }, [engine, startBarcodeLoop])

  // ── OCR on a gallery-picked image (same recognizer, static image input) ────
  const scanImageFile = useCallback(async (file: File) => {
    if (!mountedRef.current) return
    stopCamera()
    setState(s => ({ ...s, mode: 'ocr', ocrProgress: 0 }))
    try {
      const bitmap = await createImageBitmap(file)
      const rawCanvas = document.createElement('canvas')
      rawCanvas.width  = bitmap.width
      rawCanvas.height = bitmap.height
      rawCanvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      const canvas = preprocessForOcr(rawCanvas, rawCanvas.width, rawCanvas.height)

      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker('eng', 1, {
        logger: (m: any) => {
          if (m.status === 'recognizing text' && mountedRef.current) {
            setState(s => ({ ...s, ocrProgress: Math.round(m.progress * 100) }))
          }
        },
      })
      // A gallery photo is a full label shot, not a single aligned line —
      // sparse-text layout detection suits it better than single-line mode.
      await worker.setParameters({ tessedit_pageseg_mode: '11' as any })
      const { data: { text } } = await worker.recognize(canvas)
      await worker.terminate()
      if (!mountedRef.current) return

      const normalized = normalizeOcrText(text)
      if (normalized.length < 3) {
        setState(s => ({ ...s, status: 'error', error: 'Could not read any text from that image.' }))
        return
      }
      setState(s => ({ ...s, lastOcrText: normalized }))
      const candidates = await searchFuzzy(normalized)
      if (!mountedRef.current) return
      if (candidates.length === 0) {
        setState(s => ({ ...s, status: 'error', error: 'No matching product found for that image.' }))
        return
      }
      const ranked = matchProduct(normalized, candidates)
      const best = ranked[0]
      const tier = best ? tierForScore(best.score) : 'none'
      if (tier === 'none' || !best) {
        setState(s => ({ ...s, status: 'error', error: 'No matching product found for that image.' }))
        return
      }
      if (tier === 'auto') {
        await selectProduct(best.product as unknown as LocalProduct)
      } else {
        const top = ranked.slice(0, MATCH_SUGGEST_LIMIT).map(r => r.product) as unknown as LocalProduct[]
        setState(s => ({ ...s, status: 'matches', matchTier: tier, matches: top }))
      }
    } catch {
      if (mountedRef.current) setState(s => ({ ...s, status: 'error', error: 'Could not process that image.' }))
    }
  }, [searchFuzzy, selectProduct, stopCamera])

  // ── Lifecycle: request permission + start camera as soon as the scanner
  //    view opens; tear everything down when it closes ──────────────────────
  useEffect(() => {
    if (!active) {
      stopCamera()
      ocrRatioRef.current = DEFAULT_OCR_RATIO_ID
      setState(INITIAL_STATE)
      return
    }

    let cancelled = false
    setState(() => ({ ...INITIAL_STATE, ocrRatio: ocrRatioRef.current, status: 'requesting-permission' }))

    async function init() {
      const ok = await engine.openCamera('environment')
      if (cancelled || !mountedRef.current || !ok) return
      setState(s => ({ ...s, status: 'scanning', mode: 'barcode' }))
      startBarcodeLoop()
    }
    init()

    return () => { cancelled = true; stopCamera() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // ── Map the engine's camera status onto this hook's status while the
  //    camera itself hasn't finished opening yet (denied/error) ──────────────
  useEffect(() => {
    if (!active) return
    if (engine.state.cameraStatus === 'denied') {
      setState(s => (s.status === 'denied' ? s : { ...s, status: 'denied', error: engine.state.error }))
    } else if (engine.state.cameraStatus === 'error') {
      setState(s => (s.status === 'error' ? s : { ...s, status: 'error', error: engine.state.error }))
    }
  }, [active, engine.state.cameraStatus, engine.state.error])

  // ── Defensive re-attach ──────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    engine.attachStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state.status])

  return {
    state, videoRef, containerRef,
    toggleFlash, switchCamera, setMode, setZoom, setOcrRatio,
    selectProduct, rescan, retryPermission, scanImageFile,
  }
}
