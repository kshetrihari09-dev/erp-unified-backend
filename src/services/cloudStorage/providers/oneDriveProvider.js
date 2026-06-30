/**
 * src/services/cloudStorage/providers/oneDriveProvider.js
 *
 * Microsoft OneDrive implementation of CloudStorageProvider.
 * Uses the Microsoft identity platform (Azure AD v2) OAuth 2.0 flow
 * with PKCE, and the Microsoft Graph API for Drive operations.
 *
 * Required env vars:
 *   ONEDRIVE_CLIENT_ID
 *   ONEDRIVE_CLIENT_SECRET
 *   ONEDRIVE_REDIRECT_URI
 *   ONEDRIVE_TENANT (defaults to 'common' — personal + work/school accounts)
 */
'use strict'

const CloudStorageProvider = require('../CloudStorageProvider')

const SCOPES = ['Files.ReadWrite.AppFolder', 'offline_access', 'User.Read']
const GRAPH_API = 'https://graph.microsoft.com/v1.0'

class OneDriveProvider extends CloudStorageProvider {
  constructor() {
    super({ id: 'onedrive', label: 'Microsoft OneDrive', logoKey: 'onedrive' })
    this.clientId = process.env.ONEDRIVE_CLIENT_ID
    this.clientSecret = process.env.ONEDRIVE_CLIENT_SECRET
    this.redirectUri = process.env.ONEDRIVE_REDIRECT_URI
    this.tenant = process.env.ONEDRIVE_TENANT || 'common'
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri)
  }

  get authBase() {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/authorize`
  }

  get tokenUrl() {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`
  }

  getAuthUrl({ state, codeChallenge }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    return `${this.authBase}?${params.toString()}`
  }

  async exchangeCodeForTokens({ code, codeVerifier }) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      scope: SCOPES.join(' '),
    })
    const res = await fetch(this.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_description || data.error || 'OneDrive token exchange failed')
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSeconds: data.expires_in }
  }

  async refreshAccessToken({ refreshToken }) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES.join(' '),
    })
    const res = await fetch(this.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_description || data.error || 'OneDrive token refresh failed')
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSeconds: data.expires_in }
  }

  async getAccountInfo({ accessToken }) {
    const res = await fetch(`${GRAPH_API}/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch OneDrive account info')
    return { email: data.mail || data.userPrincipalName, displayName: data.displayName, providerAccountId: data.id }
  }

  async resolveFolder({ accessToken, folderName }) {
    // Special "app folder" path keeps the app sandboxed to its own folder
    // under /Apps/<AppName>, but we instead let the user pick a named
    // folder under the drive root, created on demand.
    const lookupRes = await fetch(`${GRAPH_API}/me/drive/root:/${encodeURIComponent(folderName)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (lookupRes.ok) {
      const data = await lookupRes.json()
      return { folderId: data.id }
    }
    if (lookupRes.status !== 404) {
      const err = await lookupRes.json().catch(() => ({}))
      throw new Error(err.error?.message || 'Failed to look up OneDrive folder')
    }

    const createRes = await fetch(`${GRAPH_API}/me/drive/root/children`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
    })
    const createData = await createRes.json()
    if (!createRes.ok) throw new Error(createData.error?.message || 'Failed to create OneDrive folder')
    return { folderId: createData.id }
  }
<<<<<<< HEAD

  async uploadFile({ accessToken, folderId, fileName, mimeType, buffer }) {
    // Simple upload (files up to 4MB, which covers typical invoice/receipt
    // PDFs). Larger files would need the resumable upload session API.
    const path = folderId
      ? `/me/drive/items/${folderId}:/${encodeURIComponent(fileName)}:/content`
      : `/me/drive/root:/${encodeURIComponent(fileName)}:/content`
    const res = await fetch(`${GRAPH_API}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType },
      body: buffer,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || 'Failed to upload file to OneDrive')
    return { fileId: data.id, webUrl: data.webUrl }
  }
=======
>>>>>>> 8de82f8d6c2378109c87e7d4561ba9192b09e763
}

module.exports = OneDriveProvider
