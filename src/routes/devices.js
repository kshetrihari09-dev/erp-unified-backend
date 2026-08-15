/**
 * routes/devices.js — Device registration, QR pairing, heartbeat
 *
 * Two routers, same split pattern as routes/cloudStorage.js:
 *   - `router`       : authenticated, mounted at /api/v1/devices
 *   - `publicRouter` : the ONE unauthenticated endpoint, POST /pair/claim,
 *                      mounted separately in server.js — a brand-new
 *                      device has no JWT yet, so it can't call anything
 *                      behind `authenticate`. It authenticates itself
 *                      with the short-lived pairing token instead, which
 *                      is the whole point of the pairing flow.
 *
 * Every other route here goes through the existing `authenticate`
 * middleware exactly like every other tenant-scoped router in this app —
 * no separate auth model is introduced, matching requirement #22.
 */
const router       = require('express').Router()
const publicRouter = require('express').Router()
const crypto        = require('crypto')
const db             = require('../db/knex')
const { authenticate, requireRole } = require('../middleware/index')
const { successResponse, paginatedResponse } = require('../middleware/helpers')
const { withDefaults } = require('../utils/settingsDefaults')
const { isValidUUID, auditLog } = require('../utils/helpers')

const PAIRING_TOKEN_TTL_MS = 10 * 60_000 // 10 minutes — short-lived per requirement #11

router.use(authenticate)

/* ── GET /devices ──────────────────────────────────────────────────────────
 * Settings → Devices & Sync list. Joined with users for a display name and
 * a lightweight pending-conflict count so the UI doesn't need a second
 * round trip per device.
 */
router.get('/', async (req, res, next) => {
  try {
    const devices = await db('devices as d')
      .leftJoin('users as u', 'd.user_id', 'u.id')
      .where('d.company_id', req.companyId)
      .select(
        'd.id', 'd.device_name', 'd.platform', 'd.app_version', 'd.status',
        'd.branch_id', 'd.registered_at', 'd.last_seen_at', 'd.last_synced_at',
        'u.name as user_name',
      )
      .orderBy('d.last_seen_at', 'desc')

    const conflictCounts = await db('sync_conflicts')
      .where({ company_id: req.companyId, status: 'open' })
      .whereNotNull('device_id')
      .groupBy('device_id')
      .select('device_id')
      .count('id as count')
    const conflictsByDevice = Object.fromEntries(conflictCounts.map(c => [c.device_id, Number(c.count)]))

    return successResponse(res, devices.map(d => ({ ...d, pending_conflicts: conflictsByDevice[d.id] || 0 })))
  } catch (err) { next(err) }
})

/* ── POST /devices/register ───────────────────────────────────────────────
 * Direct registration for a device that's already authenticated (i.e. the
 * person is logged in on this browser/app and it just needs to become a
 * "known" device — the common case for the very first device on an
 * account, before any pairing flow exists to bootstrap from).
 *
 * Idempotent by design (requirement #9's spirit applied to device
 * registration): the client's persisted device_id IS the primary key
 * (migration 026), so calling this again with the same id updates the
 * existing row rather than creating a duplicate or erroring.
 */
router.post('/register', async (req, res, next) => {
  try {
    const { device_id, device_name, platform, app_version, branch_id } = req.body
    if (!device_id || !isValidUUID(device_id)) {
      return res.status(400).json({ success: false, message: 'A valid device_id (UUID) is required' })
    }
    if (!device_name) {
      return res.status(400).json({ success: false, message: 'device_name is required' })
    }

    const existing = await db('devices').where({ id: device_id, company_id: req.companyId }).first()

    if (!existing) {
      const company = await db('companies').where({ id: req.companyId }).first('settings')
      const maxDevices = withDefaults(company?.settings).devices.maxDevices
      const [{ count }] = await db('devices').where({ company_id: req.companyId, status: 'active' }).count('id as count')
      if (Number(count) >= maxDevices) {
        return res.status(403).json({
          success: false,
          code: 'DEVICE_LIMIT_REACHED',
          message: 'Maximum registered devices reached.',
          max_devices: maxDevices,
        })
      }
    } else if (existing.status === 'revoked') {
      return res.status(403).json({ success: false, message: 'This device has been revoked. Contact an admin to re-authorize it.', code: 'DEVICE_REVOKED' })
    }

    const [device] = await db('devices')
      .insert({
        id: device_id, company_id: req.companyId, branch_id: branch_id || null,
        user_id: req.user.id, device_name, platform: platform || null, app_version: app_version || null,
        status: 'active', registered_at: existing?.registered_at || new Date(), last_seen_at: new Date(),
      })
      .onConflict('id').merge(['device_name', 'platform', 'app_version', 'user_id', 'last_seen_at', 'branch_id'])
      .returning('*')

    auditLog(req.companyId, req.user.id, existing ? 'UPDATE' : 'CREATE', 'devices', device.id, { device_name }, req.ip)
    return successResponse(res, device, existing ? 'Device updated' : 'Device registered', existing ? 200 : 201)
  } catch (err) { next(err) }
})

/* ── POST /devices/heartbeat ───────────────────────────────────────────────
 * Cheap, frequent ping so "Last Seen" in the devices list is meaningful.
 * Deliberately separate from every other request (rather than updating
 * last_seen_at on every API call) so it stays a single small write the
 * client can call on its own light interval without coupling to billing
 * traffic (requirement #27 — sync must never block normal billing).
 */
router.post('/heartbeat', async (req, res, next) => {
  try {
    const deviceId = req.headers['x-device-id'] || req.body.device_id
    if (!deviceId) return res.status(400).json({ success: false, message: 'device_id is required' })

    const [device] = await db('devices')
      .where({ id: deviceId, company_id: req.companyId })
      .update({ last_seen_at: new Date(), user_id: req.user.id })
      .returning('*')

    if (!device) return res.status(404).json({ success: false, message: 'Device not registered' })
    if (device.status === 'revoked') {
      return res.status(403).json({ success: false, message: 'Device revoked', code: 'DEVICE_REVOKED' })
    }
    return successResponse(res, { status: device.status, last_seen_at: device.last_seen_at })
  } catch (err) { next(err) }
})

/* ── PATCH /devices/:id ────────────────────────────────────────────────────
 * Rename only — every other field is either set at registration or
 * server-controlled (status changes go through /revoke below so they're
 * always audited).
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { device_name } = req.body
    if (!device_name) return res.status(400).json({ success: false, message: 'device_name is required' })

    const [device] = await db('devices')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ device_name, updated_at: new Date() })
      .returning('*')
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' })

    auditLog(req.companyId, req.user.id, 'UPDATE', 'devices', device.id, { device_name }, req.ip)
    return successResponse(res, device, 'Device renamed')
  } catch (err) { next(err) }
})

/* ── POST /devices/:id/revoke ──────────────────────────────────────────────
 * Owner/admin only — a revoked device is immediately rejected by
 * requireActiveDevice on its next sync/pairing call (and by /heartbeat
 * above), matching requirement #22's "device revocation" and TEST 6.
 */
router.post('/:id/revoke', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const [device] = await db('devices')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ status: 'revoked', revoked_by: req.user.id, revoked_at: new Date(), updated_at: new Date() })
      .returning('*')
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' })

    auditLog(req.companyId, req.user.id, 'REVOKE', 'devices', device.id, { device_name: device.device_name }, req.ip)
    return successResponse(res, device, 'Device revoked')
  } catch (err) { next(err) }
})

/* ── GET /devices/conflicts ────────────────────────────────────────────────
 * Feeds Settings → Devices & Sync → "View Conflicts". Open by default;
 * pass ?status=resolved for history.
 */
router.get('/conflicts', async (req, res, next) => {
  try {
    const { page, limit, offset } = require('../middleware/helpers').parsePagination(req.query)
    const status = req.query.status || 'open'
    const q = db('sync_conflicts as c')
      .leftJoin('devices as d', 'c.device_id', 'd.id')
      .where('c.company_id', req.companyId)
      .where('c.status', status)
      .select('c.*', 'd.device_name')
    const [{ count }] = await q.clone().clearSelect().count('c.id as count')
    const data = await q.orderBy('c.created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── POST /devices/conflicts/:id/resolve ──────────────────────────────────
 * Records the manual resolution decision (edit qty / cancel / backorder /
 * pick another batch / authorized override — the actual re-submission of
 * a corrected sale still goes through the normal POST /sales, this only
 * closes out the conflict record with an audit trail per requirement #17).
 */
router.post('/conflicts/:id/resolve', async (req, res, next) => {
  try {
    const { resolution_reason } = req.body
    const [conflict] = await db('sync_conflicts')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ status: 'resolved', resolved_by: req.user.id, resolved_at: new Date(), resolution_reason: resolution_reason || null, updated_at: new Date() })
      .returning('*')
    if (!conflict) return res.status(404).json({ success: false, message: 'Conflict not found' })

    auditLog(req.companyId, req.user.id, 'RESOLVE', 'sync_conflicts', conflict.id, { resolution_reason }, req.ip)
    return successResponse(res, conflict, 'Conflict resolved')
  } catch (err) { next(err) }
})

/* ── POST /devices/pair/start ──────────────────────────────────────────────
 * Generates the short-lived token an already-registered device's QR code
 * encodes (Settings → Devices → Add Device → Show QR). The QR payload
 * itself is assembled on the frontend as { token, apiBaseUrl } — this
 * endpoint only issues the token; it never sees or cares what URL the
 * frontend put next to it.
 */
router.post('/pair/start', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const token = crypto.randomBytes(32).toString('base64url')
    const expires_at = new Date(Date.now() + PAIRING_TOKEN_TTL_MS)

    await db('device_pairing_tokens').insert({
      token, company_id: req.companyId, branch_id: req.body.branch_id || null,
      created_by: req.user.id, expires_at,
    })

    return successResponse(res, { token, expires_at, ttl_seconds: PAIRING_TOKEN_TTL_MS / 1000 }, 'Pairing token created')
  } catch (err) { next(err) }
})

/* ── POST /devices/pair/claim  (PUBLIC — mounted at /devices/pair, see
 * server.js and the publicRouter note above; this route is therefore
 * reachable at POST /api/v1/devices/pair/claim) ────────────────────────
 * The new device scanned the QR, extracted { token }, and now exchanges it
 * for a device registration. This does NOT log the device into a user
 * session — no JWT is issued here, matching "the QR must not contain a
 * permanent JWT". The person still logs in on the new device through the
 * completely normal, existing /auth/login flow; pairing only tells this
 * backend "this device_id is now an authorized device for this company"
 * so that once they do log in, offline billing + sync on it work.
 */
publicRouter.post('/claim', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { token, device_id, device_name, platform, app_version } = req.body
    if (!token)      { await trx.rollback(); return res.status(400).json({ success: false, message: 'token is required' }) }
    if (!device_id || !isValidUUID(device_id)) { await trx.rollback(); return res.status(400).json({ success: false, message: 'A valid device_id (UUID) is required' }) }
    if (!device_name) { await trx.rollback(); return res.status(400).json({ success: false, message: 'device_name is required' }) }

    const pairing = await trx('device_pairing_tokens').where({ token }).first()
    if (!pairing)                     { await trx.rollback(); return res.status(400).json({ success: false, message: 'Invalid pairing code', code: 'PAIRING_INVALID' }) }
    if (pairing.used_at)              { await trx.rollback(); return res.status(400).json({ success: false, message: 'This pairing code has already been used', code: 'PAIRING_USED' }) }
    if (new Date(pairing.expires_at) < new Date()) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'This pairing code has expired — generate a new one', code: 'PAIRING_EXPIRED' })
    }

    const company = await trx('companies').where({ id: pairing.company_id }).first('settings')
    const maxDevices = withDefaults(company?.settings).devices.maxDevices
    const [{ count }] = await trx('devices').where({ company_id: pairing.company_id, status: 'active' }).count('id as count')
    if (Number(count) >= maxDevices) {
      await trx.rollback()
      return res.status(403).json({ success: false, code: 'DEVICE_LIMIT_REACHED', message: 'Maximum registered devices reached.', max_devices: maxDevices })
    }

    const [device] = await trx('devices')
      .insert({
        id: device_id, company_id: pairing.company_id, branch_id: pairing.branch_id,
        user_id: pairing.created_by, device_name, platform: platform || null, app_version: app_version || null,
        status: 'active', registered_at: new Date(), last_seen_at: new Date(),
      })
      .onConflict('id').merge(['device_name', 'platform', 'app_version', 'last_seen_at', 'branch_id', 'status'])
      .returning('*')

    await trx('device_pairing_tokens').where({ token }).update({ used_at: new Date(), used_by_device_id: device_id })

    await trx.commit()
    auditLog(pairing.company_id, pairing.created_by, 'CREATE', 'devices', device.id, { device_name, via: 'pairing' }, req.ip)
    return successResponse(res, { device, company_id: pairing.company_id, branch_id: pairing.branch_id }, 'Device paired — sign in on this device to continue', 201)
  } catch (err) { await trx.rollback(); next(err) }
})

module.exports = router
module.exports.publicRouter = publicRouter
