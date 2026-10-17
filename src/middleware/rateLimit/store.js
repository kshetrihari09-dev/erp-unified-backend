/**
 * middleware/rateLimit/store.js
 *
 * Counter storage for express-rate-limit.
 *
 *   memory (default)  - per-process counters. Correct for ONE backend instance.
 *                       With N instances each keeps its own counter, so the
 *                       effective limit becomes N x the configured one.
 *   redis             - shared counters (RATE_LIMIT_STORE=redis + REDIS_URL) so
 *                       every instance enforces one consistent budget.
 *
 * The Redis store is a small purpose-built implementation of express-rate-limit's
 * Store interface on top of `ioredis` instead of a third-party adapter, because
 * adapters that load their Lua script at construction time stay broken after a
 * boot-time Redis hiccup. Here the script is registered with ioredis'
 * defineCommand (EVALSHA with automatic EVAL fallback on NOSCRIPT), so there is
 * no boot-time promise that can poison the store.
 *
 * Increment is atomic (single Lua call): INCR, and PEXPIRE only when the key has
 * no TTL yet, so a window is fixed from its first hit and can never be extended
 * by later traffic.
 *
 * Failure behaviour: ioredis is configured to fail FAST (commandTimeout, bounded
 * retries). A failing store throws from increment(); each limiter decides via
 * `passOnStoreError` whether that means fail-open (business traffic) or
 * fail-closed (credential endpoints). See index.js.
 */
'use strict'

const INCR_LUA = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { c, ttl }
`

class RedisRateLimitStore {
  /**
   * @param {object} opts
   * @param {import('ioredis').Redis} opts.client  ioredis client with `rlIncr` defined
   * @param {string} opts.prefix                    key prefix (unique per limiter)
   */
  constructor({ client, prefix }) {
    this.client = client
    this.prefix = prefix
    this.localKeys = false          // tells express-rate-limit the counters are shared
    this.windowMs = 60_000
  }

  init(options) { this.windowMs = options.windowMs }

  _k(key) { return `${this.prefix}${key}` }

  async increment(key) {
    const [hits, ttl] = await this.client.rlIncr(this._k(key), this.windowMs)
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(0, Number(ttl))) }
  }

  async decrement(key) {
    await this.client.decr(this._k(key))
  }

  async resetKey(key) {
    await this.client.del(this._k(key))
  }

  async get(key) {
    const [hits, ttl] = await Promise.all([this.client.get(this._k(key)), this.client.pttl(this._k(key))])
    if (hits === null) return undefined
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(0, Number(ttl))) }
  }
}

/**
 * @returns {{kind:'memory'|'redis', forLimiter:(name:string)=>object|undefined,
 *            close:()=>Promise<void>, status:()=>object, client:object|null}}
 */
function createStoreProvider(cfg, { logger = console, RedisCtor } = {}) {
  if (cfg.store !== 'redis') {
    return {
      kind: 'memory',
      forLimiter: () => undefined,                       // each limiter gets its own MemoryStore
      close: async () => {},
      status: () => ({ kind: 'memory', shared: false }),
      client: null,
    }
  }

  const Redis = RedisCtor || require('ioredis')
  const client = new Redis(cfg.redisUrl, {
    maxRetriesPerRequest: 1,
    commandTimeout: 1_000,
    connectTimeout: 3_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    enableReadyCheck: true,
  })
  client.defineCommand('rlIncr', { numberOfKeys: 1, lua: INCR_LUA })

  let lastError = null
  client.on('error', (err) => {                           // without a listener ioredis would throw
    lastError = { at: new Date().toISOString(), message: err && err.message }
    logger.error(JSON.stringify({ ts: lastError.at, level: 'error', event: 'rate_limit_store_error', store: 'redis', message: lastError.message }))
  })
  client.on('ready', () => {
    logger.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'rate_limit_store_ready', store: 'redis' }))
  })

  return {
    kind: 'redis',
    client,
    forLimiter: (name) => new RedisRateLimitStore({ client, prefix: `${cfg.redisPrefix}${name}:` }),
    close: async () => { try { await client.quit() } catch { client.disconnect() } },
    status: () => ({ kind: 'redis', shared: true, connection: client.status, lastError }),
  }
}

module.exports = { createStoreProvider, RedisRateLimitStore, INCR_LUA }
