/**
 * Migration 039 — Scan Purchase Bill / Invoice OCR.
 *
 * Purely additive, and deliberately thin. Per the spec's own architecture
 * rule ("the scanner is only an input method... must NOT become a
 * separate purchase system"), a scanned bill does not get its own
 * purchase table, its own item table, or its own totals — it produces
 * exactly the same `purchases` / `purchase_items` rows a manual entry
 * would, through the same existing POST /purchases endpoint. Everything
 * added here exists only to get from "uploaded file" to "a payload for
 * that existing endpoint," plus a durable link back to the source
 * document afterwards.
 *
 * Two new tables:
 *
 *   purchase_scans — one row per scan session. Holds OCR status and the
 *   extracted structured data (header + line items, each carrying a
 *   confidence/match flag) as JSONB. This is scratch space: nothing in
 *   it is trusted as a purchase record. It exists before a purchase does
 *   (upload → OCR → review can all happen before the user commits), and
 *   is linked to the resulting purchase only once one is actually
 *   created — a discarded or abandoned scan never touches `purchases`.
 *
 *   purchase_scan_pages — one row per uploaded page/image (a multi-page
 *   PDF becomes N rows). Stores the file path on local disk, mirroring
 *   the existing product-image storage convention, and the raw OCR text
 *   for that page (useful for support/debugging a bad extraction without
 *   re-running OCR).
 *
 * Two columns added to the existing `purchases` table:
 *
 *   source           — 'manual' (default, unchanged for every existing
 *                       row) or 'scanned'. Lets Purchase History show
 *                       where a bill came from and offer "View Original."
 *   source_scan_id    — FK back to the purchase_scans row, SET NULL on
 *                       delete so removing scan bookkeeping later can
 *                       never cascade into deleting a real purchase.
 */

exports.up = async (knex) => {
  console.log('\n[Migration 039] Scan Purchase Bill / Invoice OCR...')

  await knex.schema.createTable('purchase_scans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE')
    t.uuid('uploaded_by').references('id').inTable('users').onDelete('SET NULL')

    // uploaded      — pages saved, OCR not yet run (or queued)
    // processing    — OCR/parsing in flight
    // extracted     — parsing finished; extracted_data is ready for review
    // failed        — OCR/parsing errored; error_message set
    // confirmed     — the user completed review and a purchase now exists
    //                 (purchase_id set); the scan is now historical
    // discarded     — the user abandoned this scan without creating a purchase
    t.enum('status', ['uploaded', 'processing', 'extracted', 'failed', 'confirmed', 'discarded'])
      .notNullable().defaultTo('uploaded')
    t.text('error_message')

    // The full extraction result: header fields (supplier guess, invoice
    // no, dates, totals) and line items, each item carrying its own
    // product-match status and confidence — never the final say on what
    // gets saved (see services/purchaseScan/reconcile.js), just the
    // review screen's starting point.
    t.jsonb('extracted_data')

    // Set only once the user confirms — see routes/purchases.js, which
    // sets this in the same transaction that creates the purchase.
    t.uuid('purchase_id').references('id').inTable('purchases').onDelete('SET NULL')

    t.timestamps(true, true)
    t.index(['company_id', 'status'])
  })

  await knex.schema.createTable('purchase_scan_pages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('scan_id').notNullable().references('id').inTable('purchase_scans').onDelete('CASCADE')
    t.integer('page_no').notNullable()

    // Local disk path, same convention as /uploads/products/{companyId}/... —
    // see services/purchaseScan/scanStorage.js. Deliberately NOT served by
    // express.static the way product images are: an invoice is a
    // financial document, so it's served only through an authenticated,
    // company-scoped route (routes/purchases.js GET .../scan/pages/:pageNo).
    t.string('file_path', 500).notNullable()
    t.string('mime_type', 100).notNullable()

    t.text('ocr_text')
    t.decimal('ocr_confidence', 5, 2) // 0–100, average word confidence for this page

    t.timestamps(true, true)
    t.unique(['scan_id', 'page_no'])
  })

  const hasSource = await knex.schema.hasColumn('purchases', 'source')
  if (!hasSource) {
    await knex.schema.alterTable('purchases', (t) => {
      t.enum('source', ['manual', 'scanned']).notNullable().defaultTo('manual')
      t.uuid('source_scan_id').references('id').inTable('purchase_scans').onDelete('SET NULL')
    })
  }

  console.log('[Migration 039] done.\n')
}

exports.down = async (knex) => {
  const hasSource = await knex.schema.hasColumn('purchases', 'source')
  if (hasSource) {
    await knex.schema.alterTable('purchases', (t) => {
      t.dropColumn('source')
      t.dropColumn('source_scan_id')
    })
  }
  await knex.schema.dropTableIfExists('purchase_scan_pages')
  await knex.schema.dropTableIfExists('purchase_scans')
}
