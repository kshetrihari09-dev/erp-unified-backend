/**
 * rate-limit-retry-after.test.js
 *
 * The frontend can only honour Retry-After on a 429 if (a) the limiter sends it and
 * (b) CORS exposes it to the cross-origin (Vercel → Render) browser. Verifies both.
 */
'use strict'
const fs   = require('fs')
const path = require('path')
const http = require('http')
const express = require('express')

jest.mock('../src/config', () => ({
  env: 'test',
  security: {
    rateLimitWindowMs: 60_000, rateLimitMax: 2, authRateLimitMax: 2, scannerRateLimitMax: 2,
    reportsRateLimitMax: 2, ocrRateLimitMax: 2,
  },
  server: {}, cors: { origins: [] }, logging: {},
}))

const { generalLimiter } = require('../src/middleware/security')

function listen(app) {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
}

describe('general limiter 429 response', () => {
  it('sends a numeric Retry-After (seconds, <= window) and the existing JSON body', async () => {
    const app = express()
    app.set('trust proxy', 1)
    app.use('/api/v1', generalLimiter)
    app.get('/api/v1/notifications', (_req, res) => res.json({ success: true }))
    const server = await listen(app)
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/v1/notifications?category=reminder`
      expect((await fetch(url)).status).toBe(200)
      expect((await fetch(url)).status).toBe(200)
      const limited = await fetch(url)
      expect(limited.status).toBe(429)
      const retryAfter = Number(limited.headers.get('retry-after'))
      expect(Number.isInteger(retryAfter)).toBe(true)
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(60)
      expect(await limited.json()).toEqual({ success: false, message: 'Too many requests. Please wait and try again.' })
    } finally { server.close() }
  })
})

describe('CORS exposes the back-off headers to browsers', () => {
  it('server.js exposedHeaders includes Retry-After and RateLimit-Reset', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8')
    const m = src.match(/exposedHeaders:\s*\[([^\]]*)\]/)
    expect(m).not.toBeNull()
    expect(m[1]).toMatch(/'Retry-After'/)
    expect(m[1]).toMatch(/'RateLimit-Reset'/)
  })
})
