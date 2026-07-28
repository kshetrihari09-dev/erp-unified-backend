/**
 * backupService.js
 *
 * Real (not decorative) local backup for the Settings → Backup & Cloud
 * panel. A backup is a gzip-compressed JSON snapshot of every row scoped
 * to a company across the tables listed in BACKUP_TABLES, written to disk
 * under BACKUP_DIR and tracked in the `backups` table (migration 018).
 *
 *  - Manual backup:   POST /settings/backup/run  → runBackup(companyId, 'manual', userId)
 *  - Auto backup:     checkAndRunDueBackups(), called on an interval from
 *                      server.js, honors companies.settings.backup
 *                      {autoEnabled, frequency}.
 *  - Download:        streams the gzip file straight back (settings.js).
 *  - Verification:    verifyBackup() recomputes the sha256 of the file
 *                      currently on disk and compares it to the checksum
 *                      recorded at creation time — a real integrity check,
 *                      not a fake "verified" badge.
 *
 * This is scoped to a single company's data (not a full pg_dump of the
 * whole database), which keeps it safe to run from a regular API route
 * without special DB-admin privileges or extra OS-level dependencies.
 */
const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const db = require('../db/knex')

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups')

// Tables that make up a company's working data set. Order matters for a
// hypothetical restore (parents before children) even though restore is
// out of scope here — kept in dependency order for future-proofing.
const BACKUP_TABLES = [
  'companies', 'users', 'accounts', 'parties', 'accounting_periods',
  'fiscal_years', 'invoice_templates', 'voucher_sequences',
  'vouchers', 'voucher_lines', 'journal_entries', 'journal_lines',
  'products', 'manufacturers', 'inventory_batches',
  'sales', 'sale_items', 'purchases', 'purchase_items',
  'receives', 'receive_items',
]

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

async function dumpCompanyData(companyId) {
  const snapshot = { companyId, createdAt: new Date().toISOString(), tables: {} }
  for (const table of BACKUP_TABLES) {
    const hasTable = await db.schema.hasTable(table)
    if (!hasTable) continue
    const hasCompanyCol = table === 'companies'
      ? false
      : await db.schema.hasColumn(table, 'company_id')
    const query = table === 'companies'
      ? db(table).where({ id: companyId })
      : hasCompanyCol
        ? db(table).where({ company_id: companyId })
        : null
    if (!query) continue
    snapshot.tables[table] = await query
  }
  return snapshot
}

async function runBackup(companyId, type = 'manual', userId = null) {
  ensureDir()
  const [row] = await db('backups').insert({
    company_id: companyId, type, status: 'pending', created_by: userId,
  }).returning('*')

  try {
    const snapshot = await dumpCompanyData(companyId)
    const json = JSON.stringify(snapshot)
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'))
    const checksum = crypto.createHash('sha256').update(gz).digest('hex')
    const fileName = `backup-${companyId}-${Date.now()}.json.gz`
    const filePath = path.join(BACKUP_DIR, fileName)
    fs.writeFileSync(filePath, gz)

    const [updated] = await db('backups').where({ id: row.id }).update({
      status: 'success', file_name: fileName, file_path: filePath,
      size_bytes: gz.length, checksum, updated_at: new Date(),
    }).returning('*')
    return updated
  } catch (err) {
    const [failed] = await db('backups').where({ id: row.id }).update({
      status: 'failed', error_message: err.message, updated_at: new Date(),
    }).returning('*')
    return failed
  }
}

async function verifyBackup(companyId, backupId) {
  const backup = await db('backups').where({ id: backupId, company_id: companyId }).first()
  if (!backup) throw Object.assign(new Error('Backup not found'), { status: 404 })
  if (backup.status !== 'success' || !backup.file_path || !fs.existsSync(backup.file_path)) {
    return db('backups').where({ id: backupId }).update({
      verified: false, error_message: 'Backup file missing on disk', updated_at: new Date(),
    }).returning('*').then(([r]) => r)
  }
  const data = fs.readFileSync(backup.file_path)
  const checksum = crypto.createHash('sha256').update(data).digest('hex')
  const verified = checksum === backup.checksum
  const [updated] = await db('backups').where({ id: backupId }).update({
    verified, verified_at: new Date(), updated_at: new Date(),
    error_message: verified ? null : 'Checksum mismatch — file may be corrupted',
  }).returning('*')
  return updated
}

const FREQUENCY_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, monthly: 30 * 24 * 60 * 60 * 1000 }

/** Called periodically (see server.js). Looks at every company's
 *  settings.backup.{autoEnabled,frequency} and runs a backup if the last
 *  one (of any type) is older than the configured frequency. Failures for
 *  one company never block others. */
async function checkAndRunDueBackups() {
  const { withDefaults } = require('../utils/settingsDefaults')
  const companies = await db('companies').select('id', 'settings')
  for (const company of companies) {
    try {
      const settings = withDefaults(company.settings || {})
      if (!settings.backup?.autoEnabled) continue
      const intervalMs = FREQUENCY_MS[settings.backup.frequency] || FREQUENCY_MS.daily
      const last = await db('backups').where({ company_id: company.id, status: 'success' }).orderBy('created_at', 'desc').first()
      const dueSince = last ? new Date(last.created_at).getTime() + intervalMs : 0
      if (Date.now() >= dueSince) {
        await runBackup(company.id, 'auto', null)
      }
    } catch (err) {
      console.error(`[backupService] auto-backup check failed for company ${company.id}:`, err.message)
    }
  }
}

module.exports = { runBackup, verifyBackup, checkAndRunDueBackups, BACKUP_DIR }
