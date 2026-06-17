const crypto = require('crypto')

/**
 * Compute SHA-256 of a journal entry for hash chaining.
 * The hash includes all fields that define the entry's content.
 */
function hashJournalEntry({ company_id, voucher_id, event_type, entry_date, total_debit, total_credit, narration, prev_hash }) {
  const content = JSON.stringify({
    company_id, voucher_id, event_type, entry_date,
    total_debit: Number(total_debit).toFixed(2),
    total_credit: Number(total_credit).toFixed(2),
    narration: narration || '',
    prev_hash: prev_hash || 'GENESIS',
  })
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Compute SHA-256 of an audit log entry.
 */
function hashAuditEntry({ company_id, user_id, action, entity_type, entity_id, payload_after, prev_hash }) {
  const content = JSON.stringify({
    company_id, user_id, action,
    entity_type: entity_type || '',
    entity_id:   entity_id   || '',
    payload_after: payload_after || null,
    prev_hash: prev_hash || 'GENESIS',
  })
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Get the most recent hash for a company's journal chain.
 * Returns 'GENESIS' if no entries exist yet.
 */
async function getLastJournalHash(db, companyId) {
  const row = await db('journal_entries')
    .where({ company_id: companyId })
    .orderBy('created_at', 'desc')
    .select('entry_hash')
    .first()
  return row?.entry_hash || 'GENESIS'
}

/**
 * Get the most recent hash for a company's audit chain.
 */
async function getLastAuditHash(db, companyId) {
  const row = await db('audit_log')
    .where({ company_id: companyId })
    .orderBy('created_at', 'desc')
    .select('entry_hash')
    .first()
  return row?.entry_hash || 'GENESIS'
}

/**
 * Verify the hash chain integrity for a company's journal.
 * Returns { valid: true } or { valid: false, brokenAt: entryId }
 */
async function verifyJournalChain(db, companyId) {
  const entries = await db('journal_entries')
    .where({ company_id: companyId })
    .orderBy('created_at', 'asc')
    .select('id', 'entry_hash', 'prev_hash', 'voucher_id', 'event_type', 'entry_date', 'total_debit', 'total_credit', 'narration')

  let prevHash = 'GENESIS'
  for (const entry of entries) {
    if (entry.prev_hash !== prevHash) {
      return { valid: false, brokenAt: entry.id, expected_prev: prevHash, actual_prev: entry.prev_hash }
    }
    const expectedHash = hashJournalEntry({ ...entry, prev_hash: prevHash })
    if (entry.entry_hash !== expectedHash) {
      return { valid: false, brokenAt: entry.id, reason: 'hash_mismatch' }
    }
    prevHash = entry.entry_hash
  }
  return { valid: true, entries_verified: entries.length }
}

module.exports = { hashJournalEntry, hashAuditEntry, getLastJournalHash, getLastAuditHash, verifyJournalChain }
