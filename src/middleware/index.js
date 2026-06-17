/**
 * Unified middleware — combines pharma ERP auth + accounting engine auth
 */
const jwt = require('jsonwebtoken')
const db  = require('../db/knex')

/* ── JWT Authentication ─────────────────────────────────────────────────── */
async function authenticate(req, res, next) {
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' })
    }
    const token   = auth.slice(7)
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user      = { id: payload.userId, email: payload.email, role: payload.role }
    req.companyId = payload.companyId
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired' })
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ success: false, message: 'Invalid token' })
    next(err)
  }
}

/* ── Role Guard ─────────────────────────────────────────────────────────── */
function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role
    // owner and admin always pass — they have full access to everything
    if (userRole === 'owner' || userRole === 'admin') return next()
    if (!roles.includes(userRole)) {
      return res.status(403).json({ success: false, message: `Access denied. Required: ${roles.join(' or ')}` })
    }
    next()
  }
}

/* ── Accounting permission guard ────────────────────────────────────────── */
function requirePermission(permission) {
  const permMap = {
    post_vouchers:    u => u.can_post_vouchers,
    approve_vouchers: u => u.can_approve_vouchers,
    lock_periods:     u => u.can_lock_periods,
    reverse_entries:  u => u.can_reverse_entries,
  }
  return async (req, res, next) => {
    try {
      const user    = await db('users').where({ id: req.user.id }).first()
      const checker = permMap[permission]
      if (checker && !checker(user)) {
        return res.status(403).json({ success: false, message: `Permission denied: ${permission}` })
      }
      next()
    } catch (err) { next(err) }
  }
}

/* ── Standard response helpers ──────────────────────────────────────────── */
function ok(res, data, message = 'Success', status = 200) {
  return res.status(status).json({ success: true, message, data })
}
function paginated(res, { data, total, page, limit }) {
  return res.json({ success: true, data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } })
}

/* ── Global error handler ───────────────────────────────────────────────── */
function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.message, err.status || 500)
  if (err.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate value: ' + (err.detail || '') })
  if (err.code === '23514') return res.status(400).json({ success: false, message: 'Constraint violated: ' + (err.constraint || err.detail || '') })
  if (err.code === '23503') return res.status(400).json({ success: false, message: 'Referenced record does not exist' })
  if (err.code === '23502') return res.status(400).json({ success: false, message: 'Required field missing' })
  if (err.code === 'P0001') return res.status(400).json({ success: false, message: err.message })
  const status  = err.status || err.statusCode || 500
  const message = err.message || 'Internal server error'
  res.status(status).json({ success: false, message })
}

module.exports = { authenticate, requireRole, requirePermission, errorHandler, ok, paginated }
