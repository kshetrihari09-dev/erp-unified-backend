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

/* ── Nepali BS date conversion ──────────────────────────────────────────── */
const BS_YEAR_START_AD = {
  2078: '2021-04-14', 2079: '2022-04-14', 2080: '2023-04-14',
  2081: '2024-07-16', 2082: '2025-04-14', 2083: '2026-04-14',
  2084: '2027-04-14', 2085: '2028-04-13',
}
const BS_DAYS = {
  2078: [31,31,32,32,31,30,30,29,30,30,29,31],
  2079: [31,31,32,31,31,30,30,30,30,29,30,31],
  2080: [31,32,31,32,31,30,30,30,29,30,29,31],
  2081: [31,31,32,32,31,30,30,30,29,29,30,31],
  2082: [31,31,32,31,31,30,30,30,29,30,29,31],
  2083: [31,32,31,31,32,30,30,30,29,29,30,31],
}

function adToBS(dateStr) {
  try {
    const ad = new Date(dateStr)
    let bsYear = 2081
    for (const [y, startStr] of Object.entries(BS_YEAR_START_AD).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      if (ad >= new Date(startStr)) { bsYear = Number(y); break }
    }
    const yearStart = new Date(BS_YEAR_START_AD[bsYear] || '2024-07-16')
    let daysDiff = Math.floor((ad - yearStart) / 86400000)
    const days = BS_DAYS[bsYear] || [31,31,32,32,31,30,30,30,29,29,30,31]
    let bsMonth = 1
    for (const d of days) {
      if (daysDiff < d) break
      daysDiff -= d; bsMonth++
    }
    return `${bsYear}-${String(bsMonth).padStart(2,'0')}-${String(daysDiff + 1).padStart(2,'0')}`
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

module.exports = { adToBS, todayBS, nextInvoiceNo, nextBillNo, nextPartyCode, nextItemCode, auditLog, clampExpiry }
