const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env'
require('dotenv').config({ path: envFile, override: true })
/**
 * Parse a Postgres connection string into an explicit config object.
 *
 * Why: passing the raw connection string straight to `pg` can, in some
 * pg/Node/OS combinations, fail SASL/SCRAM auth against providers like
 * Neon with "client password must be a string" — even though the string
 * is valid. Extracting each field ourselves and passing a plain object
 * sidesteps that parsing path entirely.
 */
function parseConnectionString(url) {
   if (!url || !url.startsWith('postgres')) {
    throw new Error(`Invalid DATABASE_URL: "${url}" — check your .env file`)
  }
  const parsed = new URL(url)
  return {
    host:     parsed.hostname,
    port:     parsed.port ? parseInt(parsed.port, 10) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user:     decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl:      { rejectUnauthorized: false },
    ...pgConnectionTimeouts,
  }
}

// Applied to every connection (dev + prod) at the `pg` client level —
// distinct from knex's own `acquireConnectionTimeout` below, which only
// bounds how long a request waits for a connection to become free.
// These bound how long an already-acquired connection is allowed to sit
// on a single query/transaction before Postgres itself kills it, so one
// slow/runaway report or a stuck transaction can't hold a pool slot
// (and, transitively, everyone waiting behind it) indefinitely. Override
// per-environment via env vars if a specific report genuinely needs
// longer than the default.
const pgConnectionTimeouts = {
  statement_timeout:                  parseInt(process.env.DB_STATEMENT_TIMEOUT_MS,   10) || 30000,
  query_timeout:                      parseInt(process.env.DB_QUERY_TIMEOUT_MS,        10) || 30000,
  idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TXN_TIMEOUT_MS,    10) || 30000,
}

module.exports = {
  development: {
    client: 'pg',
    connection: {
      host:             process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT)   || 5432,
      database:         process.env.DB_NAME     || 'erp_unified',
      user:             process.env.DB_USER     || 'postgres',
      password:         process.env.DB_PASSWORD || 'password',
      ...pgConnectionTimeouts,
    },
    // Ensure all queries run in the public schema — prevents
    // "relation does not exist" when search_path is misconfigured
    searchPath:  ['public'],
    migrations:  { directory: './migrations', tableName: 'knex_migrations' },
    seeds:       { directory: './seeds' },
    pool: {
      min: 2, max: 10,
      // Set search_path on every new connection
      afterCreate: (conn, done) => {
        conn.query('SET search_path TO public', (err) => done(err, conn))
      },
    },
    acquireConnectionTimeout: 10000,
    asyncStackTraces: true,
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL
      ? parseConnectionString(process.env.DATABASE_URL)
      : {
          host:     process.env.DB_HOST,
          port:     process.env.DB_PORT,
          database: process.env.DB_NAME,
          user:     process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl:      { rejectUnauthorized: false },
          ...pgConnectionTimeouts,
        },
    migrations: { directory: './migrations', tableName: 'knex_migrations' },
    seeds:      { directory: './seeds' },
    pool: {
      // Pool size intentionally left unchanged — a bigger pool doesn't
      // fix an overload problem, it just moves it to Postgres' own
      // max_connections. What was actually missing here (vs. the
      // `development` block above, which already had these) is bounding
      // how long a request waits for a connection and how long an idle
      // one is kept open — without them this fell back to knex/pg's own
      // defaults (60s+ acquisition wait), which under real load makes
      // pool exhaustion look like the app hanging instead of failing
      // fast with a clear error.
      min: 2, max: 20,
      idleTimeoutMillis: 30000,
      afterCreate: (conn, done) => {
        conn.query('SET search_path TO public', (err) => done(err, conn))
      },
    },
    acquireConnectionTimeout: 10000,
  },
}
