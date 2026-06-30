/**
 * src/services/cloudStorage/providers/dropboxProvider.js
 *
 * Dropbox implementation of CloudStorageProvider.
 * Uses Dropbox's OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Required env vars:
 *   DROPBOX_CLIENT_ID
 *   DROPBOX_CLIENT_SECRET
 *   DROPBOX_REDIRECT_URI
 */
'use strict'

const CloudStorageProvider = require('../CloudStorageProvider')

const AUTH_BASE = 'https://www.dropbox.com/oauth2/authorize'
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const API_BASE = 'https://api.dropboxapi.com/2'

class DropboxProvider extends CloudStorageProvider {
  constructor() {
    super({ id: 'dropbox', label: 'Dropbox', logoKey: 'dropbox' })
    this.clientId = process.env.DROPBOX_CLIENT_ID
    this.clientSecret = process.env.DROPBOX_CLIENT_SECRET
    this.redirectUri = process.env.DROPBOX_REDIRECT_URI
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri)
  }

  getAuthUrl({ state, codeChallenge }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      token_access_type: 'offline',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    return `${AUTH_BASE}?${params.toString()}`
  }

  async exchangeCodeForTokens({ code, codeVerifier }) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
    })
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_description || data.error || 'Dropbox token exchange failed')
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSeconds: data.expires_in }
  }

  async refreshAccessToken({ refreshToken }) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_description || data.error || 'Dropbox token refresh failed')
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in }
  }

  async getAccountInfo({ accessToken }) {
    const res = await fetch(`${API_BASE}/users/get_current_account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_summary || 'Failed to fetch Dropbox account info')
    return { email: data.email, displayName: data.name?.display_name, providerAccountId: data.account_id }
  }

  async resolveFolder({ accessToken, folderName }) {
    const path = `/${folderName}`.replace(/\/+/g, '/')
    const res = await fetch(`${API_BASE}/files/create_folder_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, autorename: false }),
    })
    if (res.ok) {
      const data = await res.json()
      return { folderId: data.metadata.path_lower }
    }
    const errData = await res.json().catch(() => ({}))
    // Dropbox returns a conflict error if the folder already exists — that's fine.
    if (errData.error?.['.tag'] === 'path' && errData.error.path?.['.tag'] === 'conflict') {
      return { folderId: path.toLowerCase() }
    }
    throw new Error(errData.error_summary || 'Failed to create Dropbox folder')
  }

  async revokeToken({ accessToken }) {
    await fetch(`${API_BASE}/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } })
  }
}

module.exports = DropboxProvider
