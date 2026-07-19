require('dotenv').config()
const knex = require('knex')
const config = require('../../knexfile')

const env = process.env.NODE_ENV || 'development'
const db = knex(config[env])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Set the PostgreSQL session variable for Row Level Security.
 * Call this at the start of every request.
 *
 * `companyId` always originates from a server-signed JWT (see
 * middleware/index.js), so this is normally guaranteed to already be a
 * valid UUID — Postgres' SET LOCAL doesn't support bound query parameters,
 * so the value has to be interpolated into the SQL text either way. This
 * check is a defense-in-depth guard, not a behavior change: it rejects
 * malformed input before it ever reaches raw SQL, and never fires for any
 * legitimate request.
 * @param {import('knex').Knex.Transaction|import('knex').Knex} trxOrDb
 * @param {string} companyId
 */
async function setRLSContext(trxOrDb, companyId) {
  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    throw new Error('setRLSContext: companyId must be a valid UUID')
  }
  await trxOrDb.raw(`SET LOCAL app.current_company_id = '${companyId}'`)
}

/**
 * Run a function inside a transaction with RLS context set.
 * @param {string} companyId
 * @param {function(import('knex').Knex.Transaction): Promise<any>} fn
 */
async function withRLS(companyId, fn) {
  return db.transaction(async trx => {
    await setRLSContext(trx, companyId)
    return fn(trx)
  })
}

module.exports = db
module.exports.setRLSContext = setRLSContext
module.exports.withRLS = withRLS
