/**
 * helpers.js — FIXED
 *
 * ROOT CAUSE OF BUG 1 WAS HERE:
 *   Old auditLog() inserted columns: resource, resource_id, changes
 *   Actual audit_log schema has:     entity_type, entity_id, payload_after
 *   This caused "column does not exist" on every mutating request.
 *
 * FIX: use correct column names matching migration 001.
 */
const db = require('../db/knex')

/* ── Safe expiry text for varchar(20) columns ─────────────────────────────
 * inventory_batches.expiry / purchase_items.expiry / receive_items.expiry /
 * sale_items.expiry are all varchar(20), meant to hold a short display
 * value like "12/2027". If a Date object (or an ISO timestamp string like
 * "2027-12-15T00:00:00.000Z") ever ends up here — e.g. round-tripped from
 * a batch's expiry_date — inserting it raw overflows the column. This
 * takes just the date portion and hard-caps the length as a last resort. */
function clampExpiry(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const str = raw instanceof Date ? raw.toISOString() : String(raw)
  const dateOnly = str.split('T')[0]
  return dateOnly.slice(0, 20)
}

/* ── Nepali BS date conversion ──────────────────────────────────────────
 * Previously a hand-rolled lookup table (BS_YEAR_START_AD / BS_DAYS) that
 * only covered BS years 2078–2085 and had at least one bad entry (2081's
 * year-start was recorded as "2024-07-16" instead of the correct mid-April
 * date, which would silently produce wrong BS dates for that whole year).
 * Replaced with the `nepali-date-converter` library, which also adds a
 * working bsToAD (BS → AD) — the frontend already called
 * GET /date/bs-to-ad expecting this, but no such route existed here.
 *
 * IMPORTANT — off-by-one guard: the library computes the BS/AD boundary
 * from a Date object's exact instant, not just its calendar day. Passing
 * it something with a live time-of-day (e.g. `new Date()`, whose hours/
 * minutes are whatever moment the request came in) can land it on the
 * wrong side of a day boundary. Every AD date is normalized to UTC
 * midnight, built from its Y/M/D components, before it reaches the
 * library — never passed through as-is.
 */
const { default: NepaliDate } = require('nepali-date-converter')

function normalizedUTCDate(dateStr) {
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function adToBS(dateStr) {
  try {
    return new NepaliDate(normalizedUTCDate(dateStr)).format('YYYY-MM-DD')
  } catch {
    return null
  }
}

/** BS → AD. Accepts either (year, month, day) or a single 'YYYY-MM-DD' BS
 *  string. `month` is 1-indexed on this public function (matching the
 *  'YYYY-MM-DD' string form and adToBS's output) even though the library's
 *  own constructor takes a 0-indexed month internally. */
function bsToAD(year, month, day) {
  try {
    if (typeof year === 'string') {
      const [y, m, d] = year.split('-').map(Number)
      ;[year, month, day] = [y, m, d]
    }
    const jsDate = new NepaliDate(Number(year), Number(month) - 1, Number(day)).toJsDate()
    return jsDate.toISOString().split('T')[0]
  } catch {
    return null
  }
}

function todayBS() { return adToBS(new Date().toISOString().split('T')[0]) }

/* ── Invoice / voucher number generators ───────────────────────────────── */
async function nextInvoiceNo(companyId, prefix = 'INV') {
  const bs   = todayBS() || '2081-04-01'
  const year = bs.split('-')[0]
  const like = `${prefix}-${year}-%`
  const row  = await db('sales')
    .where({ company_id: companyId })
    .andWhereLike('invoice_no', like)
    .orderBy('invoice_no', 'desc')
    .first()
  const last = row ? parseInt(row.invoice_no.split('-').pop()) || 0 : 0
  return `${prefix}-${year}-${String(last + 1).padStart(3, '0')}`
}

async function nextBillNo(companyId) {
  const year = (todayBS() || '2081-04-01').split('-')[0]
  const like = `PUR-${year}-%`
  const row  = await db('purchases')
    .where({ company_id: companyId })
    .andWhereLike('bill_no', like)
    .orderBy('bill_no', 'desc')
    .first()
  const last = row ? parseInt(row.bill_no.split('-').pop()) || 0 : 0
  return `PUR-${year}-${String(last + 1).padStart(3, '0')}`
}

async function nextPartyCode(companyId, type) {
  const prefix = type === 'customer' ? 'CUS' : 'SUP'
  const row = await db('parties')
    .where({ company_id: companyId, type })
    .orderBy('code', 'desc')
    .first()
  const last = row?.code ? parseInt(row.code.split('-').pop()) || 0 : 0
  return `${prefix}-${String(last + 1).padStart(3, '0')}`
}

async function nextItemCode(companyId) {
  const row = await db('products').where({ company_id: companyId }).orderBy('item_code', 'desc').first()
  const last = row?.item_code ? parseInt(row.item_code.split('-').pop()) || 0 : 0
  return `MED-${String(last + 1).padStart(3, '0')}`
}

/* ── Audit logger — FIXED column names ──────────────────────────────────
 *
 * BEFORE (BROKEN):
 *   await db('audit_log').insert({
 *     resource, resource_id, changes  ← THESE COLUMNS DO NOT EXIST
 *   })
 *
 * AFTER (FIXED):
 *   Uses the correct column names matching migration 001:
 *   entity_type, entity_id, payload_after
 *
 * This function is intentionally non-blocking — a failure here must
 * NEVER crash the parent request. It wraps in try/catch and logs only.
 * ─────────────────────────────────────────────────────────────────── */
async function auditLog(companyId, userId, action, entityType, entityId, payloadAfter, ipAddress) {
  try {
    // Build entity_id safely — must be UUID or null (not empty string)
    const safeEntityId = entityId && isValidUUID(entityId) ? entityId : null

    await db('audit_log').insert({
      company_id:    companyId   || null,
      user_id:       userId      || null,
      action:        action      || 'UNKNOWN',
      entity_type:   entityType  || null,   // ← FIXED (was: resource)
      entity_id:     safeEntityId,          // ← FIXED (was: resource_id)
      payload_after: payloadAfter           // ← FIXED (was: changes)
        ? JSON.stringify(payloadAfter)
        : null,
      ip_address:    ipAddress   || null,
      is_suspicious: false,
    })
  } catch (err) {
    // NEVER crash the parent request — just log to console
    console.error('[AUDIT] Non-fatal write failure:', err.message, { action, entityType, entityId })
  }
}

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
}

module.exports = { adToBS, bsToAD, todayBS, nextInvoiceNo, nextBillNo, nextPartyCode, nextItemCode, auditLog, clampExpiry }
