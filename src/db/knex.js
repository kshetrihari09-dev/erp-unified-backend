require('dotenv').config()

// node-postgres, by default, parses PostgreSQL DATE columns (OID 1082) into
// JavaScript Date objects. A Date object always carries an implicit
// timezone: it gets constructed from the row's Y/M/D using the server
// process's local time, but anything that later serializes it back out
// (e.g. Express's res.json(), which calls .toISOString()) reads it back in
// UTC. Whenever the server's local timezone is ahead of UTC, that round
// trip silently rolls the calendar day back by one — which is exactly what
// was making voucher_date / entry_date appear one day earlier than the
// date the user selected, everywhere the value was returned by the API
// (voucher list, voucher detail, ledger, reports, posting history).
//
// DATE columns represent a calendar date, not an instant, so they should
// never be converted through a timezone-aware Date object at all. Telling
// pg to hand back the raw 'YYYY-MM-DD' string it already parsed from
// Postgres (instead of building a Date from it) removes that conversion
// entirely — the value that goes in is the exact value that comes out.
const { types: pgTypes } = require('pg')
pgTypes.setTypeParser(1082, val => val) // 1082 = PostgreSQL's DATE type OID

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
