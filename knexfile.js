require('dotenv').config()

module.exports = {
  development: {
    client: 'pg',
    connection: {
      host:             process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT)   || 5432,
      database:         process.env.DB_NAME     || 'erp_unified',
      user:             process.env.DB_USER     || 'postgres',
      password:         process.env.DB_PASSWORD || 'password',
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
    connection: process.env.DATABASE_URL || {
      host:     process.env.DB_HOST,
      port:     process.env.DB_PORT,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl:      { rejectUnauthorized: false },
    },
    migrations: { directory: './migrations', tableName: 'knex_migrations' },
    seeds:      { directory: './seeds' },
    pool:       { min: 2, max: 20 },
  },
}
