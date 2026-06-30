/**
 * src/services/cloudStorage/cloudStorageService.js
 *
 * Application-level service that sits between the routes and:
 *   - the provider registry (CloudStorageRegistry)
 *   - the database (cloud_storage_connections / cloud_storage_oauth_states)
 *   - the token encryption helper (utils/tokenCrypto)
 *
 * Responsibilities:
 *   - PKCE state generation/validation for the OAuth flow
 *   - persisting & retrieving connections per company/provider
 *   - transparently refreshing expired access tokens before use
 *   - never returning raw tokens to callers outside this module
 *
 * Nothing here touches any existing accounting table or business logic.
 * It only reads/writes the new cloud_storage_* tables created by
 * migration 014.
 */
'use strict'

const crypto = require('crypto')
const { v4: uuid } = require('uuid')
const db = require('../../db/knex')
const tokenCrypto = require('../../utils/tokenCrypto')
const registry = require('./CloudStorageRegistry')

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes to complete the OAuth dance
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000 // refresh if expiring within 2 minutes

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32))
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

/* ── Public: provider catalog (no DB) ──────────────────────────────────── */

function listProviderCatalog() {
  return registry.listProviders().map((p) => ({
    id: p.id,
    label: p.label,
    logoKey: p.logoKey,
    configured: typeof p.isConfigured === 'function' ? p.isConfigured() : true,
  }))
}

/* ── OAuth: start ───────────────────────────────────────────────────────── */

async function beginAuthorization({ companyId, userId, providerId }) {
  const provider = registry.getProvider(providerId)
  if (provider.isConfigured && !provider.isConfigured()) {
    const err = new Error(`${provider.label} is not configured on this server. Contact your administrator.`)
    err.status = 503
    throw err
  }

  const { codeVerifier, codeChallenge } = generatePkcePair()
  const state = base64url(crypto.randomBytes(24))

  await db('cloud_storage_oauth_states').insert({
    id: uuid(),
    state,
    company_id: companyId,
    user_id: userId,
    provider: providerId,
    code_verifier: codeVerifier,
    expires_at: new Date(Date.now() + STATE_TTL_MS),
  })

  const authUrl = provider.getAuthUrl({ state, codeChallenge })
  return { authUrl, state }
}

/* ── OAuth: callback ────────────────────────────────────────────────────── */

async function completeAuthorization({ providerId, code, state }) {
  const provider = registry.getProvider(providerId)

  const stateRow = await db('cloud_storage_oauth_states').where({ state, provider: providerId }).first()
  if (!stateRow) {
    const err = new Error('Invalid or expired authorization state. Please try connecting again.')
    err.status = 400
    throw err
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    await db('cloud_storage_oauth_states').where({ id: stateRow.id }).del()
    const err = new Error('Authorization request expired. Please try connecting again.')
    err.status = 400
    throw err
  }

  const tokens = await provider.exchangeCodeForTokens({ code, codeVerifier: stateRow.code_verifier })
  const accountInfo = await provider.getAccountInfo({ accessToken: tokens.accessToken })

  const expiresAt = tokens.expiresInSeconds
    ? new Date(Date.now() + tokens.expiresInSeconds * 1000)
    : null

  const existing = await db('cloud_storage_connections')
    .where({ company_id: stateRow.company_id, provider: providerId })
    .first()

  const record = {
    company_id: stateRow.company_id,
    provider: providerId,
    access_token_encrypted: tokenCrypto.encrypt(tokens.accessToken),
    // Some providers only return a refresh_token on first consent; keep
    // the existing one if a fresh one wasn't issued this time.
    refresh_token_encrypted: tokens.refreshToken
      ? tokenCrypto.encrypt(tokens.refreshToken)
      : existing?.refresh_token_encrypted || null,
    token_expires_at: expiresAt,
    account_email: accountInfo.email || null,
    account_display_name: accountInfo.displayName || null,
    provider_account_id: accountInfo.providerAccountId || null,
    status: 'connected',
    connected_by: stateRow.user_id,
    connected_at: new Date(),
    last_error_message: null,
    updated_at: new Date(),
  }

  if (existing) {
    await db('cloud_storage_connections').where({ id: existing.id }).update(record)
  } else {
    // First connection for this company becomes the default automatically.
    const anyDefault = await db('cloud_storage_connections').where({ company_id: stateRow.company_id, is_default: true }).first()
    await db('cloud_storage_connections').insert({
      id: uuid(),
      ...record,
      is_default: !anyDefault,
      folder_name: 'Accounting Documents',
      auto_upload_enabled: false,
    })
  }

  await db('cloud_storage_oauth_states').where({ id: stateRow.id }).del()

  return getConnectionStatus({ companyId: stateRow.company_id, providerId })
}

/* ── Status / listing ───────────────────────────────────────────────────── */

function toPublicShape(row, provider) {
  if (!row) {
    return {
      provider: provider.id,
      label: provider.label,
      logoKey: provider.logoKey,
      status: 'disconnected',
      accountEmail: null,
      lastSyncAt: null,
      isDefault: false,
      autoUploadEnabled: false,
      folderName: 'Accounting Documents',
    }
  }
  return {
    provider: provider.id,
    label: provider.label,
    logoKey: provider.logoKey,
    status: row.status,
    accountEmail: row.account_email,
    accountDisplayName: row.account_display_name,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    lastErrorMessage: row.last_error_message,
    isDefault: row.is_default,
    autoUploadEnabled: row.auto_upload_enabled,
    folderName: row.folder_name,
    connectedAt: row.connected_at,
    tokenExpiresAt: row.token_expires_at,
  }
}

async function listConnections({ companyId }) {
  const rows = await db('cloud_storage_connections').where({ company_id: companyId })
  const byProvider = new Map(rows.map((r) => [r.provider, r]))
  return registry.listProviders().map((p) => toPublicShape(byProvider.get(p.id), p))
}

async function getConnectionStatus({ companyId, providerId }) {
  const provider = registry.getProvider(providerId)
  const row = await db('cloud_storage_connections').where({ company_id: companyId, provider: providerId }).first()
  return toPublicShape(row, provider)
}

/* ── Token access with transparent refresh ─────────────────────────────── */

/**
 * Returns a valid (decrypted) access token for a connection, refreshing
 * it first if it's expired or about to expire. Persists the refreshed
 * token back to the DB. Throws if the connection requires re-auth.
 */
async function getValidAccessToken({ companyId, providerId }) {
  const provider = registry.getProvider(providerId)
  const row = await db('cloud_storage_connections').where({ company_id: companyId, provider: providerId }).first()

  if (!row || row.status === 'disconnected' || !row.access_token_encrypted) {
    const err = new Error(`${provider.label} is not connected.`)
    err.status = 400
    err.code = 'NOT_CONNECTED'
    throw err
  }

  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : null
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() < TOKEN_REFRESH_SKEW_MS

  if (!needsRefresh) {
    return tokenCrypto.decrypt(row.access_token_encrypted)
  }

  if (!row.refresh_token_encrypted) {
    await db('cloud_storage_connections').where({ id: row.id }).update({
      status: 'expired',
      last_error_message: 'Access token expired and no refresh token is available. Please reconnect.',
      updated_at: new Date(),
    })
    const err = new Error(`${provider.label} connection has expired. Please reconnect.`)
    err.status = 401
    err.code = 'REAUTH_REQUIRED'
    throw err
  }

  try {
    const refreshToken = tokenCrypto.decrypt(row.refresh_token_encrypted)
    const refreshed = await provider.refreshAccessToken({ refreshToken })
    const newExpiresAt = refreshed.expiresInSeconds ? new Date(Date.now() + refreshed.expiresInSeconds * 1000) : null

    await db('cloud_storage_connections').where({ id: row.id }).update({
      access_token_encrypted: tokenCrypto.encrypt(refreshed.accessToken),
      refresh_token_encrypted: refreshed.refreshToken ? tokenCrypto.encrypt(refreshed.refreshToken) : row.refresh_token_encrypted,
      token_expires_at: newExpiresAt,
      status: 'connected',
      last_error_message: null,
      updated_at: new Date(),
    })

    return refreshed.accessToken
  } catch (err) {
    await db('cloud_storage_connections').where({ id: row.id }).update({
      status: 'expired',
      last_error_message: 'Failed to refresh access token. Please reconnect.',
      updated_at: new Date(),
    })
    const wrapped = new Error(`${provider.label} authorization has expired. Please reconnect.`)
    wrapped.status = 401
    wrapped.code = 'REAUTH_REQUIRED'
    throw wrapped
  }
}

/* ── Disconnect ─────────────────────────────────────────────────────────── */

async function disconnect({ companyId, providerId }) {
  const provider = registry.getProvider(providerId)
  const row = await db('cloud_storage_connections').where({ company_id: companyId, provider: providerId }).first()
  if (!row) return { success: true }

  if (row.access_token_encrypted) {
    try {
      const accessToken = tokenCrypto.decrypt(row.access_token_encrypted)
      const refreshToken = row.refresh_token_encrypted ? tokenCrypto.decrypt(row.refresh_token_encrypted) : null
      await provider.revokeToken({ accessToken, refreshToken })
    } catch {
      // Best-effort remote revocation — local disconnect proceeds regardless.
    }
  }

  const wasDefault = row.is_default

  await db('cloud_storage_connections').where({ id: row.id }).update({
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    token_expires_at: null,
    status: 'disconnected',
    is_default: false,
    last_error_message: null,
    updated_at: new Date(),
  })

  // If this was the default, promote another connected provider if one exists.
  if (wasDefault) {
    const nextDefault = await db('cloud_storage_connections')
      .where({ company_id: companyId, status: 'connected' })
      .first()
    if (nextDefault) {
      await db('cloud_storage_connections').where({ id: nextDefault.id }).update({ is_default: true, updated_at: new Date() })
    }
  }

  return { success: true }
}

/* ── Test connection ────────────────────────────────────────────────────── */

async function testConnection({ companyId, providerId }) {
  const provider = registry.getProvider(providerId)
  const accessToken = await getValidAccessToken({ companyId, providerId })
  try {
    const result = await provider.testConnection({ accessToken })
    await db('cloud_storage_connections')
      .where({ company_id: companyId, provider: providerId })
      .update({ last_sync_status: 'success', last_error_message: null, updated_at: new Date() })
    return result
  } catch (err) {
    await db('cloud_storage_connections')
      .where({ company_id: companyId, provider: providerId })
      .update({ last_sync_status: 'failed', last_error_message: err.message, updated_at: new Date() })
    throw err
  }
}

/* ── Settings: folder, auto-upload, default provider ───────────────────── */

async function updateConnectionSettings({ companyId, providerId, folderName, autoUploadEnabled }) {
  const row = await db('cloud_storage_connections').where({ company_id: companyId, provider: providerId }).first()
  if (!row) {
    const err = new Error('This provider is not connected yet.')
    err.status = 400
    throw err
  }

  const updates = { updated_at: new Date() }
  if (folderName !== undefined) updates.folder_name = String(folderName).trim().slice(0, 255) || 'Accounting Documents'
  if (autoUploadEnabled !== undefined) updates.auto_upload_enabled = Boolean(autoUploadEnabled)

  // Resolving/creating the folder on the provider's side is attempted but
  // not required to succeed for the setting to save — folder resolution
  // truly matters once uploads are implemented in a future update.
  if (folderName !== undefined && row.status === 'connected') {
    try {
      const provider = registry.getProvider(providerId)
      const accessToken = await getValidAccessToken({ companyId, providerId })
      const { folderId } = await provider.resolveFolder({ accessToken, folderName: updates.folder_name })
      updates.folder_id = folderId
    } catch {
      // Non-fatal — the name is still saved; folder will be (re)resolved later.
    }
  }

  await db('cloud_storage_connections').where({ id: row.id }).update(updates)
  return getConnectionStatus({ companyId, providerId })
}

async function setDefaultProvider({ companyId, providerId }) {
  const row = await db('cloud_storage_connections').where({ company_id: companyId, provider: providerId }).first()
  if (!row || row.status !== 'connected') {
    const err = new Error('Connect this provider before setting it as default.')
    err.status = 400
    throw err
  }
  await db.transaction(async (trx) => {
    await trx('cloud_storage_connections').where({ company_id: companyId }).update({ is_default: false })
    await trx('cloud_storage_connections').where({ id: row.id }).update({ is_default: true, updated_at: new Date() })
  })
  return listConnections({ companyId })
}

<<<<<<< HEAD
/* ── Upload (the actual document backup action) ─────────────────────────── */

/**
 * Upload a single document (invoice/bill/receipt/journal entry PDF, etc.)
 * to a company's connected cloud storage provider.
 *
 * @param {object} params
 * @param {string} params.companyId
 * @param {string} [params.providerId]  Defaults to the company's default provider.
 * @param {Buffer} params.buffer        File contents.
 * @param {string} params.fileName      e.g. 'Invoice-INV-2026-0042.pdf'
 * @param {string} [params.mimeType]    Defaults to 'application/pdf'.
 * @returns {Promise<{ provider: string, fileId: string, webUrl?: string }>}
 */
async function uploadDocument({ companyId, providerId, buffer, fileName, mimeType = 'application/pdf' }) {
  let row
  if (providerId) {
    row = await db('cloud_storage_connections').where({ company_id: companyId, provider: providerId }).first()
  } else {
    row = await db('cloud_storage_connections').where({ company_id: companyId, is_default: true, status: 'connected' }).first()
  }

  if (!row || row.status !== 'connected') {
    const err = new Error('No connected cloud storage provider available for upload.')
    err.status = 400
    err.code = 'NOT_CONNECTED'
    throw err
  }

  const resolvedProviderId = row.provider
  const provider = registry.getProvider(resolvedProviderId)

  try {
    const accessToken = await getValidAccessToken({ companyId, providerId: resolvedProviderId })

    let folderId = row.folder_id
    if (!folderId) {
      const resolved = await provider.resolveFolder({ accessToken, folderName: row.folder_name || 'Accounting Documents' })
      folderId = resolved.folderId
      await db('cloud_storage_connections').where({ id: row.id }).update({ folder_id: folderId, updated_at: new Date() })
    }

    const result = await provider.uploadFile({ accessToken, folderId, fileName, mimeType, buffer })

    await db('cloud_storage_connections').where({ id: row.id }).update({
      last_sync_at: new Date(),
      last_sync_status: 'success',
      last_error_message: null,
      updated_at: new Date(),
    })

    return { provider: resolvedProviderId, ...result }
  } catch (err) {
    await db('cloud_storage_connections').where({ id: row.id }).update({
      last_sync_status: 'failed',
      last_error_message: err.message,
      updated_at: new Date(),
    })
    throw err
  }
}

=======
>>>>>>> 8de82f8d6c2378109c87e7d4561ba9192b09e763
module.exports = {
  listProviderCatalog,
  beginAuthorization,
  completeAuthorization,
  listConnections,
  getConnectionStatus,
  getValidAccessToken,
  disconnect,
  testConnection,
  updateConnectionSettings,
  setDefaultProvider,
<<<<<<< HEAD
  uploadDocument,
=======
>>>>>>> 8de82f8d6c2378109c87e7d4561ba9192b09e763
}
