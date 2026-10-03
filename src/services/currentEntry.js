/**
 * currentEntry.js — resolves a voucher's CURRENT accounting effect.
 *
 * Background
 * ----------
 * `journal_entries` / `journal_lines` are append-only (trigger-enforced) and
 * `journal_entries.voucher_id` is UNIQUE. A POSTED voucher is therefore
 * edited by VoucherEditService with the immutable-ledger pattern:
 *
 *     reverse the live entry  +  post a corrected entry
 *
 * The corrected entry cannot hang off the visible voucher (its slot is
 * taken), so it is posted against a hidden internal "anchor" voucher
 * (`SYS-CORR-*`, metadata.system_correction = true). The visible voucher
 * remembers which anchor is live in
 *
 *     vouchers.metadata.ledger_correction.active_entry_voucher_id
 *
 * Resolution rule (the ONE place it is defined)
 * --------------------------------------------
 *   never edited  → current entry = the voucher's own journal entry
 *   edited        → current entry = journal entry of the active anchor
 *
 * Anything that wants "what is the accounting state of this voucher right
 * now" must go through this module instead of querying
 * `journal_entries WHERE voucher_id = <visible voucher id>` — that row is
 * the ORIGINAL, superseded entry once the voucher has been edited.
 */

function parseMeta(metadata) {
  if (!metadata) return {}
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata) } catch { return {} }
  }
  return metadata
}

/** id of the voucher whose journal entry is the live one for `voucher`. */
function activeEntryVoucherId(voucher) {
  const meta = parseMeta(voucher?.metadata)
  return meta.ledger_correction?.active_entry_voucher_id || voucher.id
}

/** SQL expression (uuid) giving the entry-owner voucher id for visible voucher alias `a`. */
function currentEntryVoucherIdSql(a = 'v') {
  return `COALESCE(NULLIF(${a}.metadata->'ledger_correction'->>'active_entry_voucher_id', '')::uuid, ${a}.id)`
}

/**
 * Resolve the current journal entry (+ lines) for an already-loaded voucher.
 * @param {import('knex').Knex|import('knex').Knex.Transaction} conn
 * @param {object} voucher  a `vouchers` row (needs id + metadata)
 */
async function resolveCurrentEntry(conn, voucher) {
  const anchorVoucherId = activeEntryVoucherId(voucher)
  const entry = await conn('journal_entries').where({ voucher_id: anchorVoucherId }).first()
  const lines = entry
    ? await conn('journal_lines as jl')
        .leftJoin('accounts as a', 'jl.account_id', 'a.id')
        .where('jl.journal_entry_id', entry.id)
        .select('jl.*', 'a.name as account_name', 'a.code as account_code')
        .orderBy('jl.line_no')
    : []
  const corr = parseMeta(voucher.metadata).ledger_correction
  return {
    anchor_voucher_id: anchorVoucherId,
    is_corrected: anchorVoucherId !== voucher.id,
    correction_count: corr?.correction_count || 0,
    entry: entry || null,
    lines,
  }
}

/**
 * Restrict a journal_lines/journal_entries query to CURRENT financial effects
 * only — i.e. exclude every superseded original entry, every superseded
 * anchor and every internal edit-reversal — and expose the *visible* voucher
 * (`ov`) each surviving entry belongs to.
 *
 * Caller must already have `journal_lines as jl` joined to `journal_entries as je`.
 * Adds:   jv = voucher that owns the entry (visible voucher or an anchor)
 *         ov = the visible voucher the entry is attributed to
 */
function scopeToCurrentEntries(q, db) {
  return q
    .join('vouchers as jv', 'jv.id', 'je.voucher_id')
    .joinRaw(`LEFT JOIN vouchers ov ON ov.id = COALESCE(NULLIF(jv.metadata->>'corrects_voucher_id', '')::uuid, jv.id)`)
    .whereRaw(`(
      (
        jv.metadata->>'system_correction' IS DISTINCT FROM 'true'
        AND COALESCE(jv.metadata->'ledger_correction'->>'active_entry_voucher_id', '') = ''
      )
      OR
      (
        jv.metadata->>'system_correction' = 'true'
        AND ov.metadata->'ledger_correction'->>'active_entry_voucher_id' = jv.id::text
      )
    )`)
    // Legacy heuristic kept for pre-anchor data: a reversal voucher whose
    // original is still POSTED is edit plumbing, not a user-visible reversal.
    .andWhere(b => b.whereNull('jv.reversal_of').orWhereNotExists(
      db('vouchers as orig').whereRaw('orig.id = jv.reversal_of').andWhere('orig.status', 'POSTED'),
    ))
}

module.exports = {
  parseMeta,
  activeEntryVoucherId,
  currentEntryVoucherIdSql,
  resolveCurrentEntry,
  scopeToCurrentEntries,
}
