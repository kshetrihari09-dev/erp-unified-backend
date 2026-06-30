/* ═══════════════════════════════════════════════════════════════════════
   cloudStorage.js — Cloud Storage Integration API

   Provides connection management for third-party cloud storage providers
   (Google Drive, OneDrive, Dropbox). This module only manages the
   *connection* (OAuth, account info, folder selection, settings) — actual
   document upload is a future feature and is intentionally not wired up
   here yet.

   All routes are scoped to req.companyId (set by the `authenticate`
   middleware) so one company can never see or affect another company's
   cloud storage connections.
═══════════════════════════════════════════════════════════════════════ */
const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/index')
const { successResponse } = require('../middleware/helpers')
const { auditLog } = require('../utils/helpers')
const cloudStorageService = require('../services/cloudStorage/cloudStorageService')
const { isValidProviderId } = require('../services/cloudStorage/CloudStorageRegistry')

function validateProviderParam(req, res, next) {
  if (!isValidProviderId(req.params.provider)) {
    return res.status(404).json({ success: false, message: `Unknown provider: ${req.params.provider}` })
  }
  next()
}

/* ── GET /:provider/callback ───────────────────────────────────────────────
   PUBLIC route — exported separately as `publicRouter` and mounted in
   server.js WITHOUT the `authenticate` middleware, because the browser
   redirect coming back from Google/Microsoft/Dropbox carries no Bearer
   token. Identity is recovered safely from the signed, single-use `state`
   row created in beginAuthorization — never trusted from the request
   itself. */
const publicRouter = require('express').Router()
publicRouter.get('/:provider/callback', validateProviderParam, async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query
    if (error) {
      return res.redirect(`/settings/cloud-storage?status=error&provider=${req.params.provider}&message=${encodeURIComponent(error_description || error)}`)
    }
    if (!code || !state) {
      return res.status(400).json({ success: false, message: 'Missing code or state in OAuth callback' })
    }
    await cloudStorageService.completeAuthorization({ providerId: req.params.provider, code, state })
    return res.redirect(`/settings/cloud-storage?status=connected&provider=${req.params.provider}`)
  } catch (err) {
    return res.redirect(`/settings/cloud-storage?status=error&provider=${req.params.provider}&message=${encodeURIComponent(err.message)}`)
  }
})

router.use(authenticate)

/* ── GET /cloud-storage/providers ───────────────────────────────────────
   Static catalog of supported providers (id, label, logo, configured?). */
router.get('/providers', (req, res, next) => {
  try {
    return successResponse(res, cloudStorageService.listProviderCatalog())
  } catch (err) { next(err) }
})

/* ── GET /cloud-storage/connections ─────────────────────────────────────
   One row per supported provider, showing connection status, account
   email, last sync time, default flag, folder & auto-upload settings. */
router.get('/connections', async (req, res, next) => {
  try {
    const connections = await cloudStorageService.listConnections({ companyId: req.companyId })
    return successResponse(res, connections)
  } catch (err) { next(err) }
})

/* ── GET /cloud-storage/connections/:provider ───────────────────────────
   Single provider's connection status (used for polling after connect). */
router.get('/connections/:provider', validateProviderParam, async (req, res, next) => {
  try {
    const status = await cloudStorageService.getConnectionStatus({ companyId: req.companyId, providerId: req.params.provider })
    return successResponse(res, status)
  } catch (err) { next(err) }
})

/* ── POST /cloud-storage/connections/:provider/connect ──────────────────
   Starts the OAuth 2.0 flow. Returns the URL the frontend should open
   (a popup or full redirect) — the frontend never talks to the provider
   directly, keeping client secrets server-side only. */
router.post('/connections/:provider/connect', requireRole('admin', 'manager'), validateProviderParam, async (req, res, next) => {
  try {
    const { authUrl } = await cloudStorageService.beginAuthorization({
      companyId: req.companyId,
      userId: req.user.id,
      providerId: req.params.provider,
    })
    return successResponse(res, { authUrl })
  } catch (err) { next(err) }
})

/* ── POST /cloud-storage/connections/:provider/disconnect ──────────────── */
router.post('/connections/:provider/disconnect', requireRole('admin', 'manager'), validateProviderParam, async (req, res, next) => {
  try {
    const result = await cloudStorageService.disconnect({ companyId: req.companyId, providerId: req.params.provider })
    await auditLog(req.companyId, req.user.id, 'DISCONNECT', 'cloud_storage_connection', req.params.provider, {}, req.ip)
    return successResponse(res, result)
  } catch (err) { next(err) }
})

/* ── POST /cloud-storage/connections/:provider/test ──────────────────────
   "Test connection" button — cheap call to verify the token still works. */
router.post('/connections/:provider/test', validateProviderParam, async (req, res, next) => {
  try {
    const result = await cloudStorageService.testConnection({ companyId: req.companyId, providerId: req.params.provider })
    return successResponse(res, result)
  } catch (err) {
    const status = err.status || 502
    return res.status(status).json({ success: false, message: err.message, code: err.code })
  }
})

/* ── PUT /cloud-storage/connections/:provider/settings ───────────────────
   Update folder name and/or auto-upload toggle for a connected provider. */
router.put('/connections/:provider/settings', requireRole('admin', 'manager'), validateProviderParam, async (req, res, next) => {
  try {
    const { folderName, autoUploadEnabled } = req.body
    const result = await cloudStorageService.updateConnectionSettings({
      companyId: req.companyId,
      providerId: req.params.provider,
      folderName,
      autoUploadEnabled,
    })
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'cloud_storage_connection', req.params.provider, { folderName, autoUploadEnabled }, req.ip)
    return successResponse(res, result)
  } catch (err) { next(err) }
})

/* ── POST /cloud-storage/default ─────────────────────────────────────────
   Body: { provider }. Sets the default storage provider for the company. */
router.post('/default', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { provider } = req.body
    if (!isValidProviderId(provider)) {
      return res.status(400).json({ success: false, message: `Unknown provider: ${provider}` })
    }
    const result = await cloudStorageService.setDefaultProvider({ companyId: req.companyId, providerId: provider })
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'cloud_storage_default', provider, { provider }, req.ip)
    return successResponse(res, result)
  } catch (err) { next(err) }
})

module.exports = router
module.exports.publicRouter = publicRouter
