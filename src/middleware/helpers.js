/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err)

  // Knex / PostgreSQL constraint violations
  if (err.code === '23505') {
    const detail = err.detail || ''
    const field  = detail.match(/\((.+?)\)/)?.[1] || 'field'
    return res.status(409).json({ success: false, message: `Duplicate value: ${field} already exists` })
  }
  if (err.code === '23503') {
    return res.status(400).json({ success: false, message: 'Referenced record does not exist' })
  }
  if (err.code === '23502') {
    return res.status(400).json({ success: false, message: 'Required field is missing' })
  }

  const status  = err.status || err.statusCode || 500
  const message = err.message || 'Internal server error'
  res.status(status).json({ success: false, message })
}

/**
 * parsePagination — extract page/limit from query, return offset
 */
function parsePagination(query, defaultLimit = 20) {
  const page  = Math.max(1, parseInt(query.page)  || 1)
  const limit = Math.min(200, parseInt(query.limit) || defaultLimit)
  const offset = (page - 1) * limit
  return { page, limit, offset }
}

/**
 * paginatedResponse — standard paginated JSON shape
 */
function paginatedResponse(res, { data, total, page, limit, summary }) {
  const body = {
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  }
  if (summary !== undefined) body.summary = summary
  return res.json(body)
}

/**
 * successResponse — standard success JSON
 */
function successResponse(res, data, message = 'Success', status = 200) {
  return res.status(status).json({ success: true, message, data })
}

module.exports = { errorHandler, parsePagination, paginatedResponse, successResponse }
