/**
 * debug-env.js — prints exactly what dotenv loaded for DATABASE_URL.
 * Run from inside erp-unified-backend/:
 *   node debug-env.js
 */
require('dotenv').config()

const val = process.env.DATABASE_URL

console.log('--- DATABASE_URL debug ---')
console.log('typeof:', typeof val)
console.log('is undefined:', val === undefined)
console.log('length:', val ? val.length : 'n/a')
console.log('first 15 chars:', val ? JSON.stringify(val.slice(0, 15)) : 'n/a')
console.log('last 15 chars:', val ? JSON.stringify(val.slice(-15)) : 'n/a')
console.log('full value (JSON-quoted to reveal hidden chars):')
console.log(JSON.stringify(val))
