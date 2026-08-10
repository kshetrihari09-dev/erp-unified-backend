/**
 * ScannerUI.tsx
 *
 * Shared, presentation-only scanner UI pieces — extracted verbatim from
 * MobileScannerPage.tsx so both the existing cross-device mobile page and
 * the new local (same-device) scanner render identical overlays/cards
 * instead of duplicating JSX. No scanning/business logic lives here.
 */
import { motion } from 'framer-motion'
import { BARCODE_SCAN_WIDTH, BARCODE_SCAN_HEIGHT } from '@/utils/barcodeFrame'
import { OCR_RATIO_PRESETS } from '@/utils/ocrImage'

// ── Barcode scan overlay (rectangular) ───────────────────────────────────────
// The single, shared visual guide for barcode mode on BOTH scanners — the
// exact rectangle size here is BARCODE_SCAN_WIDTH/HEIGHT, the same
// constants useBarcodeEngine's decode loop crops from the video (via
// captureBarcodeFrame in barcodeFrame.ts), so what's lit up on screen is
// always exactly the region actually being decoded.
export function BarcodeRectOverlay({ found = false }: { found?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div
        className="relative rounded-2xl"
        style={{
          width: BARCODE_SCAN_WIDTH,
          height: BARCODE_SCAN_HEIGHT,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
        }}
      >
        <div
          className={`absolute inset-0 rounded-2xl border-2 transition-colors duration-200 ${
            found ? 'border-green-400/90' : 'border-white/40'
          }`}
        />
        {/* Corner marks — classic barcode-scanner viewfinder styling */}
        {!found && [
          'top-0 left-0 border-t-2 border-l-2 rounded-tl-2xl',
          'top-0 right-0 border-t-2 border-r-2 rounded-tr-2xl',
          'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-2xl',
          'bottom-0 right-0 border-b-2 border-r-2 rounded-br-2xl',
        ].map((cls, i) => (
          <div key={i} className={`absolute w-7 h-7 border-white/90 ${cls}`} />
        ))}
        {!found && (
          <motion.div
            className="absolute left-3 right-3 h-0.5 rounded-full bg-blue-400/80 shadow-lg shadow-blue-400/50"
            animate={{ top: ['12%', '86%', '12%'] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>
    </div>
  )
}

// ── Scan frame overlay ────────────────────────────────────────────────────────
// The box below is drawn at exactly `width` x `height` — CSS pixels
// computed by computeScanBoxSize() in ocrImage.ts from the live camera
// container size and the currently-selected ratio. useLocalScanner passes
// the SAME numbers to captureScanBoxFrame() for the actual OCR crop, so
// what's dimmed vs. lit here must always match what gets processed, at
// every ratio and across resize/orientation changes.
export function ScanFrame({ mode, width = 240, height = 130 }: { mode: string; width?: number; height?: number }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      {/* Dims everything outside the box via a huge box-shadow spread —
          the box itself stays fully lit. */}
      <div
        className="relative rounded-xl transition-all duration-200"
        style={{
          width,
          height,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
        }}
      >
        {/* Corner marks */}
        {[
          'top-0 left-0 border-t-2 border-l-2 rounded-tl-xl',
          'top-0 right-0 border-t-2 border-r-2 rounded-tr-xl',
          'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-xl',
          'bottom-0 right-0 border-b-2 border-r-2 rounded-br-xl',
        ].map((cls, i) => (
          <div key={i} className={`absolute w-6 h-6 border-white/90 ${cls}`} />
        ))}
        {/* Animated scan line */}
        <motion.div
          className={`absolute left-1 right-1 h-0.5 rounded-full shadow-lg ${
            mode === 'ocr' ? 'bg-purple-400/80 shadow-purple-400/50' : 'bg-blue-400/80 shadow-blue-400/50'
          }`}
          animate={{ top: ['10%', '86%', '10%'] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
    </div>
  )
}

// ── Mode badge ────────────────────────────────────────────────────────────────
export function ModeBadge({ mode, ocrProgress }: { mode: string; ocrProgress: number }) {
  if (mode === 'barcode') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/80 backdrop-blur-sm rounded-full text-white text-xs font-semibold">
        <span>📷</span> Scanning barcode…
      </div>
    )
  }
  if (mode === 'ocr') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/80 backdrop-blur-sm rounded-full text-white text-xs font-semibold">
          <span>🔤</span> Reading text{ocrProgress > 0 ? ` ${ocrProgress}%` : '…'}
        </div>
        {ocrProgress > 0 && (
          <div className="w-28 h-1 bg-white/20 rounded-full overflow-hidden">
            <div className="h-full bg-purple-400 rounded-full transition-all duration-200" style={{ width: `${ocrProgress}%` }} />
          </div>
        )}
      </div>
    )
  }
  return null
}

// ── OCR scan-ratio selector ───────────────────────────────────────────────────
// Small, mobile-friendly pill row — 2:1 | 3:2 | 4:3 | 16:9. Deliberately
// compact (single row, short labels) so it never covers the camera
// preview or the scan box itself; callers position it above/below those.
// Selecting a ratio immediately updates the visible OCR box (and the
// underlying crop) via useLocalScanner's setOcrRatio.
export function RatioSelector({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center gap-1 px-1.5 py-1.5 bg-black/45 backdrop-blur-md rounded-full pointer-events-auto">
      {OCR_RATIO_PRESETS.map(preset => (
        <button
          key={preset.id}
          onClick={() => onChange(preset.id)}
          aria-label={`OCR ratio ${preset.id} — ${preset.label}`}
          className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
            value === preset.id ? 'bg-purple-600 text-white' : 'text-white/70 active:bg-white/10'
          }`}
        >
          {preset.id}
        </button>
      ))}
    </div>
  )
}

// ── Quality feedback pill ─────────────────────────────────────────────────────
// Simple, non-technical feedback ("Move closer", "Improve lighting"...) —
// never a raw Tesseract error — shown after several consecutive frames
// fail to read anything usable.
export function QualityHint({ hint }: { hint: string }) {
  return (
    <div className="px-3 py-1.5 rounded-full bg-amber-500/85 backdrop-blur-sm text-white text-xs font-semibold shadow-lg">
      {hint}
    </div>
  )
}

// ── Inline suggestion chips (70–84% confidence band) ─────────────────────────
// Non-blocking — scanning keeps going while these are visible. Tapping a
// chip selects that product immediately, same as the full matches sheet.
export function SuggestionChips({ products, onSelect }: {
  products: ProductCardProduct[]
  onSelect: (p: any) => void
}) {
  if (products.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-1 pointer-events-auto max-w-full">
      {products.slice(0, 3).map(p => (
        <button
          key={p.id}
          onClick={() => onSelect(p)}
          className="flex-shrink-0 px-3 py-1.5 rounded-full bg-white/90 backdrop-blur-sm text-slate-800 text-[11px] font-semibold shadow active:scale-95 transition-transform truncate max-w-[140px]"
        >
          {p.name}
        </button>
      ))}
    </div>
  )
}

// ── Product match card ────────────────────────────────────────────────────────
export interface ProductCardProduct {
  id:             string
  name:           string
  generic_name?:  string
  item_code?:     string
  unit?:          string
  current_stock?: number
}

export function ProductCard({ product, index, onSelect }: {
  product:  ProductCardProduct
  index:    number
  onSelect: (p: any) => void
}) {
  return (
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      onClick={() => onSelect(product)}
      className="w-full flex items-center gap-3 p-3 bg-white rounded-xl border border-slate-200 active:scale-[.98] active:bg-blue-50 transition-all text-left shadow-sm"
    >
      <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
        {product.name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-slate-900 text-sm truncate leading-tight">{product.name}</p>
        {product.generic_name && (
          <p className="text-xs text-slate-400 truncate">{product.generic_name}</p>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          {product.item_code && (
            <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{product.item_code}</span>
          )}
          {product.unit && <span className="text-[10px] text-slate-400">{product.unit}</span>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <span className="text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">Select</span>
        {typeof product.current_stock === 'number' && (
          <span className={`text-[10px] font-semibold ${product.current_stock > 0 ? 'text-green-600' : 'text-red-500'}`}>
            Stock: {product.current_stock}
          </span>
        )}
      </div>
    </motion.button>
  )
}
