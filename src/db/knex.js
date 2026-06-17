require('dotenv').config()
const knex = require('knex')
const config = require('../../knexfile')

const env = process.env.NODE_ENV || 'development'
const db = knex(config[env])

/**
 * Set the PostgreSQL session variable for Row Level Security.
 * Call this at the start of every request.
 * @param {import('knex').Knex.Transaction|import('knex').Knex} trxOrDb
 * @param {string} companyId
 */
async function setRLSContext(trxOrDb, companyId) {
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
