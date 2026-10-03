# Posted Receipt/Payment edit — full synchronization fix

Root cause: an edit reversed the live entry, posted a correction onto a hidden
`SYS-CORR-*` anchor, then rewrote `voucher_lines`/`vouchers` — as three separate
transactions — while readers either looked at the *original* journal entry
(`VoucherService.get`, voucher-postings, posting-status) or re-derived "current"
figures by patching frozen journal rows. Any failure between steps left the
voucher and ledger disagreeing, and a failed repost bricked the voucher.

* `VoucherEditService.edit()` is now ONE transaction (row-locked voucher):
  reverse live entry + post correction + rewrite lines + update voucher/metadata
  + audit row. Any failure rolls everything back.
* `PostingEngine.reverseForCorrection()` (in-trx) reverses
  `metadata.ledger_correction.active_entry_voucher_id`, dated at the entry it
  cancels (so period reports move with the edit); the visible voucher is never
  flipped to REVERSED. Public `reverse()` now also reverses the LIVE entry.
* `services/currentEntry.js` is the single definition of "current accounting
  entry". `GET /accounting/vouchers/:id` returns it (`journal_entry`,
  `journal_lines`, `accounting.active_entry_voucher_id`).
* `ReportingEngine.ledger()` reads only current journal entries (same basis as
  Trial Balance), attributed to the visible voucher.
* `PUT /accounting/{receipts,payments}/:id/edit` now enforce
  `requireStepUp('voucherEdit')` server-side (previously only the generic
  `/vouchers/:id/edit` did), reject wrong voucher type, and return the standard
  voucher-detail shape.
* Also fixed (pre-existing, found while testing): `trialBalance()` threw
  ReferenceError on every call; reversal journal hash did not match stored
  narration; `verifyJournalChain()` omitted `company_id` so it could never pass;
  receipts/payments list count ignored its own filters.
* Frontend: edit form derives Received Into / Paid From from current lines,
  refreshes balances after save, invalidates react-query caches, ignores stale
  list responses.
* Tests: `test/voucher-edit.integration.test.js` (real Postgres, throwaway DB).

# Changed files only — drop these into your existing project at the same paths

## New files
- `android/app/src/main/java/com/byapar/app/MlKitOcrPlugin.kt`
  Native Capacitor plugin wrapping Google ML Kit Text Recognition v2.
- `src/plugins/MlKitOcr.ts`
  TS bridge to the native plugin above (`registerPlugin`, `isMlKitPlatform()`).
- `src/utils/pharmaOcrParser.ts`
  Classifies ML Kit's structured OCR result into product/generic name,
  strength, dosage form, manufacturer, MRP, batch, expiry.
- `src/components/forms/QtyStepper.tsx`
  −/+ stepper wrapper around the existing QtyGate (Sales page mobile cards).

## Modified files
- `android/app/build.gradle` — added ML Kit dependency + Kotlin plugin.
- `android/build.gradle` — added Kotlin Gradle plugin classpath.
- `android/app/src/main/java/com/byapar/app/MainActivity.java` — registers MlKitOcrPlugin.
- `src/utils/ocrMatch.ts` — added matchPharmaProduct / resolvePharmaTier
  (field-weighted, confidence-weighted matching); existing matchProduct/
  tierForScore untouched and still used by the Tesseract/web path.
- `src/utils/ocrImage.ts` — added assessOcrImageQuality, canvasToBase64Jpeg.
- `src/utils/parseProductOcr.ts` — exported existing regex/helpers (COMPANY_HINTS,
  MRP_LINE, BATCH_LINE, EXPIRY_LINE, AMOUNT, DATE_LIKE, cleanLine, extractAmount)
  so pharmaOcrParser.ts can reuse them instead of duplicating.
- `src/hooks/scanner/useLocalScanner.ts` — ML Kit tick loop wired in as the
  primary Android OCR engine; Tesseract remains the automatic fallback
  (init failure or any runtime error). Barcode scanning path untouched.
  Also added the optional `initialMode` option (defaults to 'barcode',
  preserving prior behavior for existing callers).
- `src/components/scanner/LocalScannerView.tsx` — passes through `initialMode`;
  status-message display wired to ModeBadge.
- `src/components/scanner/ScanButton.tsx` — added optional `initialMode` /
  `label` / `icon` / `className` props (all optional, default = old behavior).
- `src/components/scanner/ScannerUI.tsx` — ModeBadge shows ML Kit's status
  text ("Reading medicine text…", "Matching product…", etc.) when set.
- `src/modules/sales/SalesPage.tsx` —
  - Two mobile-only scan buttons ("Scan Barcode" / "Scan Medicine") added
    alongside the original single desktop button (now `.pos-scan-single-desktop`).
  - Qty field now uses QtyStepper instead of bare QtyGate.
  - Cleaned up a stray duplicated comment fragment left over from an earlier edit.
- `src/styles/globals.css` —
  - Fixed a real bug: `.page-header button { width: 100% }` (written for a
    different page) was clobbering the Products page's compact mobile "+"
    button; scoped with `:not(.prod-new-btn-mobile)`.
  - Changed `.prod-mobile-toolbar` from wrapping flexbox to a fixed 4-col
    grid so Import/Export/Barcode/QR always sit in one row.
  - Added `.pos-scan-row` / `.pos-scan-btn-*` / `.qty-stepper*` rules for
    the Sales page changes above.

## Not verified against a real build
No network access was available to run `npm install` or a Gradle build in
this environment. Everything here was checked by isolated TypeScript
compiles (where node_modules-independent) and manual review, but you
should run `npm install && npx tsc --noEmit` and a Gradle sync before
relying on this in production.
