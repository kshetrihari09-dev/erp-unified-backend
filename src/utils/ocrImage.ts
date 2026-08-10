/**
 * ocrImage.ts
 *
 * Shared image-processing helpers, used by both scanner hooks
 * (useProductCapture.ts's still-frame + manual-crop flow, and
 * useLocalScanner.ts's continuous scan-box flow):
 *
 *   - OCR_RATIO_PRESETS / computeScanBoxSize: a configurable OCR
 *     scan-region aspect ratio (2:1 / 3:2 / 4:3 / 16:9, default 3:2).
 *     computeScanBoxSize() is the SINGLE place the box's on-screen pixel
 *     size is derived from a container size + ratio — both the overlay
 *     (ScannerUI's ScanFrame) and captureScanBoxFrame() below call it with
 *     the same inputs, so the visible box and the actual OCR crop can
 *     never drift apart, including across orientation/screen-size
 *     changes (the caller just recomputes on resize).
 *   - captureScanBoxFrame: crops exactly that rectangle out of the live
 *     video, accounting for object-fit: cover and digital zoom.
 *   - preprocessForOcr: the original grayscale + Otsu binarization + 2x
 *     upscale helper (kept as-is for useProductCapture.ts's single-shot
 *     flow and as the "otsu" member of generateOcrVariants below).
 *   - generateOcrVariants: produces several preprocessed variants of the
 *     same crop (original, grayscale+contrast, otsu, adaptive threshold,
 *     sharpened grayscale, inverted) so the recognizer isn't dependent on
 *     a single binarization strategy that only suits some lighting/
 *     packaging conditions. The original color canvas is always included
 *     un-destroyed.
 */

// ── Configurable OCR scan-region aspect ratio ──────────────────────────────
export interface OcrRatioPreset {
  id:    '2:1' | '3:2' | '4:3' | '16:9'
  label: string
  ratio: number // width / height
}

export const OCR_RATIO_PRESETS: OcrRatioPreset[] = [
  { id: '2:1',  label: 'Narrow',         ratio: 2 / 1 },
  { id: '3:2',  label: 'Product Name',   ratio: 3 / 2 },
  { id: '4:3',  label: 'Medicine Label', ratio: 4 / 3 },
  { id: '16:9', label: 'Full Package',   ratio: 16 / 9 },
]

export const DEFAULT_OCR_RATIO_ID: OcrRatioPreset['id'] = '3:2'

export function getRatioPreset(id: string): OcrRatioPreset {
  return OCR_RATIO_PRESETS.find(p => p.id === id) ?? OCR_RATIO_PRESETS[1]
}

// How much of the available (margin-inset) container the box's dominant
// side fills. Kept comfortably inside the frame at every ratio/screen
// size rather than a fixed CSS-pixel box — a phone in portrait has very
// different usable space than one in landscape or a tablet.
const BOX_FILL_FRACTION = 0.82
const BOX_MIN_SIDE      = 110
const BOX_MARGIN        = 24

// Single source of truth for the scan box's on-screen (CSS pixel) size,
// given the camera container's current size and the selected ratio.
// Called both by the overlay (what the user sees) and by
// captureScanBoxFrame (what OCR actually reads) with the same
// containerW/containerH/ratioId — so they can never disagree. Callers
// re-invoke this whenever the container resizes (orientation change,
// window resize) to keep the crop correct.
export function computeScanBoxSize(containerW: number, containerH: number, ratioId: string) {
  const preset = getRatioPreset(ratioId)
  const maxW = Math.max(BOX_MIN_SIDE, containerW - BOX_MARGIN * 2)
  const maxH = Math.max(BOX_MIN_SIDE, containerH - BOX_MARGIN * 2)

  let width  = maxW * BOX_FILL_FRACTION
  let height = width / preset.ratio
  if (height > maxH * BOX_FILL_FRACTION) {
    height = maxH * BOX_FILL_FRACTION
    width  = height * preset.ratio
  }
  width  = Math.max(BOX_MIN_SIDE, Math.min(width, maxW))
  height = Math.max(Math.round(BOX_MIN_SIDE / preset.ratio), Math.min(height, maxH))

  return { width: Math.round(width), height: Math.round(height) }
}

export function preprocessForOcr(source: CanvasImageSource, srcWidth: number, srcHeight: number): HTMLCanvasElement {
  const SCALE = 2
  const canvas = document.createElement('canvas')
  canvas.width  = srcWidth  * SCALE
  canvas.height = srcHeight * SCALE
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data       = imageData.data
  const pixelCount = canvas.width * canvas.height

  const gray      = new Uint8ClampedArray(pixelCount)
  const histogram = new Array(256).fill(0)
  for (let i = 0, p = 0; p < pixelCount; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
    gray[p] = g
    histogram[g]++
  }

  const threshold = otsuThreshold(histogram, pixelCount)

  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const v = gray[p] > threshold ? 255 : 0
    data[i] = data[i + 1] = data[i + 2] = v
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

// Crops exactly the on-screen scan box out of a <video> element that's
// rendered with `object-fit: cover` inside a `containerW x containerH`
// box, mapping screen-space (CSS pixel) coordinates to the video's native
// pixel coordinates. `boxWidth`/`boxHeight` should come from
// computeScanBoxSize() with the same container size the overlay used, so
// the crop always matches exactly what's dimmed/undimmed on screen —
// never a different region than what the user is looking at. `zoom`
// mirrors the digital zoom applied to the <video> (see useCameraZoom /
// useBarcodeEngine): at zoom > 1 the same on-screen box corresponds to a
// proportionally smaller, still-centered native region. Returns null if
// the video has no dimensions yet.
export function captureScanBoxFrame(
  video: HTMLVideoElement,
  containerW: number,
  containerH: number,
  boxWidth: number,
  boxHeight: number,
  zoom: number = 1,
): HTMLCanvasElement | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh || !containerW || !containerH) return null

  const scale = Math.max(containerW / vw, containerH / vh)
  const dispW = vw * scale
  const dispH = vh * scale
  const offX  = (containerW - dispW) / 2
  const offY  = (containerH - dispH) / 2

  const boxX = (containerW - boxWidth)  / 2
  const boxY = (containerH - boxHeight) / 2

  let sx = (boxX - offX) / scale
  let sy = (boxY - offY) / scale
  let sw = boxWidth  / scale
  let sh = boxHeight / scale

  if (zoom > 1) {
    const cx = sx + sw / 2
    const cy = sy + sh / 2
    sw /= zoom
    sh /= zoom
    sx = cx - sw / 2
    sy = cy - sh / 2
  }

  // Clamp to the video's actual bounds — the box is a CSS size derived
  // from the container, but an unusual viewport or camera aspect ratio
  // could otherwise push the crop rect outside the source frame.
  const clampedSx = Math.max(0, Math.min(sx, vw - 1))
  const clampedSy = Math.max(0, Math.min(sy, vh - 1))
  const clampedSw = Math.max(1, Math.min(sw, vw - clampedSx))
  const clampedSh = Math.max(1, Math.min(sh, vh - clampedSy))

  const canvas = document.createElement('canvas')
  canvas.width  = Math.round(clampedSw)
  canvas.height = Math.round(clampedSh)
  canvas.getContext('2d')!.drawImage(
    video, clampedSx, clampedSy, clampedSw, clampedSh, 0, 0, canvas.width, canvas.height,
  )
  return canvas
}

// ── Multi-variant preprocessing ────────────────────────────────────────────

function otsuThreshold(histogram: number[], pixelCount: number): number {
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * histogram[t]
  let sumB = 0, wB = 0, varMax = -1, threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += histogram[t]
    if (wB === 0) continue
    const wF = pixelCount - wB
    if (wF === 0) break
    sumB += t * histogram[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const varBetween = wB * wF * (mB - mF) * (mB - mF)
    if (varBetween > varMax) { varMax = varBetween; threshold = t }
  }
  return threshold
}

function toGrayCanvas(source: CanvasImageSource, w: number, h: number, scale: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; gray: Uint8ClampedArray } {
  const canvas = document.createElement('canvas')
  canvas.width  = w * scale
  canvas.height = h * scale
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  const pixelCount = canvas.width * canvas.height
  const gray = new Uint8ClampedArray(pixelCount)
  for (let i = 0, p = 0; p < pixelCount; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
  }
  return { canvas, ctx, gray }
}

function grayToCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, gray: Uint8ClampedArray) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const v = gray[p]
    data[i] = data[i + 1] = data[i + 2] = v
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

// Grayscale with a linear contrast stretch (histogram min/max normalized
// to 0..255) — helps faded or low-contrast packaging without throwing
// away tonal information the way binarization does.
function grayscaleContrast(gray: Uint8ClampedArray): Uint8ClampedArray {
  let min = 255, max = 0
  for (let i = 0; i < gray.length; i++) { if (gray[i] < min) min = gray[i]; if (gray[i] > max) max = gray[i] }
  const range = Math.max(1, max - min)
  const out = new Uint8ClampedArray(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = ((gray[i] - min) * 255) / range
  return out
}

// Local (mean-window) adaptive threshold — unlike Otsu's single global
// cutoff, this re-derives the ink/background split per-region using an
// integral image, so uneven lighting or reflective packaging (bright on
// one side, shadowed on the other) doesn't wash out one half of the crop.
function adaptiveThreshold(gray: Uint8ClampedArray, w: number, h: number, windowFrac = 0.12, c = 6): Uint8ClampedArray {
  const win = Math.max(9, Math.round(Math.min(w, h) * windowFrac)) | 1
  const half = win >> 1
  const integral = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x]
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum
    }
  }
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half)
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
                - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0]
      const mean = sum / area
      out[y * w + x] = gray[y * w + x] > mean - c ? 255 : 0
    }
  }
  return out
}

// Simple unsharp mask (3x3 box blur subtracted from the original,
// amplified) — crisps up slightly soft/blurred camera frames before
// binarization, without a full convolution library.
function sharpenGray(gray: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length)
  const amount = 1.5
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { out[idx] = gray[idx]; continue }
      let sum = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += gray[(y + dy) * w + (x + dx)]
      const blur = sum / 9
      out[idx] = gray[idx] + (gray[idx] - blur) * amount
    }
  }
  return out
}

function invertBinary(bin: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = 255 - bin[i]
  return out
}

// Fraction of black (ink) pixels in a binarized array — used to decide
// whether an inverted variant is worth trying at all (light text on a
// dark background produces a mostly-black binarization, which is the
// signal that an inverted pass would help).
function darkFraction(bin: Uint8ClampedArray): number {
  let dark = 0
  for (let i = 0; i < bin.length; i++) if (bin[i] < 128) dark++
  return dark / bin.length
}

export interface OcrVariant {
  id:     'original' | 'contrast' | 'otsu' | 'adaptive' | 'sharpened' | 'inverted'
  canvas: HTMLCanvasElement
}

// Produces several preprocessed variants of the same source crop. The
// original color canvas is always included un-destroyed (color
// information is never permanently thrown away before preprocessing —
// every other variant is derived from a fresh copy). Callers choose which
// subset to actually run OCR on (see useLocalScanner.ts's variant
// selection) rather than always paying for every variant on every tick.
export function generateOcrVariants(source: CanvasImageSource, srcWidth: number, srcHeight: number, scale = 2): OcrVariant[] {
  const variants: OcrVariant[] = []

  // 1) Original, resized only — keeps color/detail Tesseract can
  //    sometimes read better than any binarized version (e.g. colored
  //    foil packaging with high natural contrast).
  const origCanvas = document.createElement('canvas')
  origCanvas.width  = srcWidth  * scale
  origCanvas.height = srcHeight * scale
  const origCtx = origCanvas.getContext('2d')!
  origCtx.imageSmoothingEnabled = true
  origCtx.imageSmoothingQuality = 'high'
  origCtx.drawImage(source, 0, 0, origCanvas.width, origCanvas.height)
  variants.push({ id: 'original', canvas: origCanvas })

  const { canvas: base, gray } = toGrayCanvas(source, srcWidth, srcHeight, scale)
  const w = base.width, h = base.height

  // 2) Grayscale + contrast enhancement.
  const contrast = grayscaleContrast(gray)
  const contrastCanvas = document.createElement('canvas')
  contrastCanvas.width = w; contrastCanvas.height = h
  variants.push({ id: 'contrast', canvas: grayToCanvas(contrastCanvas, contrastCanvas.getContext('2d')!, contrast) })

  // 3) Otsu global threshold (on the contrast-enhanced gray for a
  //    cleaner histogram split).
  const histogram = new Array(256).fill(0)
  for (let i = 0; i < contrast.length; i++) histogram[contrast[i]]++
  const t = otsuThreshold(histogram, contrast.length)
  const otsuBin = new Uint8ClampedArray(contrast.length)
  for (let i = 0; i < contrast.length; i++) otsuBin[i] = contrast[i] > t ? 255 : 0
  const otsuCanvas = document.createElement('canvas')
  otsuCanvas.width = w; otsuCanvas.height = h
  variants.push({ id: 'otsu', canvas: grayToCanvas(otsuCanvas, otsuCanvas.getContext('2d')!, otsuBin) })

  // 4) Adaptive (local-mean) threshold — handles uneven lighting/glare
  //    that a single global cutoff can't.
  const adaptiveBin = adaptiveThreshold(gray, w, h)
  const adaptiveCanvas = document.createElement('canvas')
  adaptiveCanvas.width = w; adaptiveCanvas.height = h
  variants.push({ id: 'adaptive', canvas: grayToCanvas(adaptiveCanvas, adaptiveCanvas.getContext('2d')!, adaptiveBin) })

  // 5) Sharpened grayscale (not binarized) — for slightly soft/blurred
  //    frames where thresholding would just amplify the blur.
  const sharpened = sharpenGray(gray, w, h)
  const sharpCanvas = document.createElement('canvas')
  sharpCanvas.width = w; sharpCanvas.height = h
  variants.push({ id: 'sharpened', canvas: grayToCanvas(sharpCanvas, sharpCanvas.getContext('2d')!, sharpened) })

  // 6) Inverted threshold — only worth generating when the otsu pass came
  //    out mostly dark (light text on a dark/foil background), otherwise
  //    it's just a wasted OCR pass.
  if (darkFraction(otsuBin) > 0.55) {
    const inverted = invertBinary(otsuBin)
    const invCanvas = document.createElement('canvas')
    invCanvas.width = w; invCanvas.height = h
    variants.push({ id: 'inverted', canvas: grayToCanvas(invCanvas, invCanvas.getContext('2d')!, inverted) })
  }

  return variants
}
