/**
 * src/services/cloudStorage/providers/googleDriveProvider.js
 *
 * Google Drive implementation of CloudStorageProvider.
 * Uses standard OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Required env vars:
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   GOOGLE_DRIVE_REDIRECT_URI
 */
'use strict'

const CloudStorageProvider = require('../CloudStorageProvider')

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email', 'profile']

class GoogleDriveProvider extends CloudStorageProvider {
  constructor() {
    super({ id: 'google_drive', label: 'Google Drive', logoKey: 'google_drive' })
    this.clientId = process.env.GOOGLE_DRIVE_CLIENT_ID
    this.clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET
    this.redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri)
  }

  getAuthUrl({ state, codeChallenge }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
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
    if (!res.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed')
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // only present on first consent
      expiresInSeconds: data.expires_in,
    }
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
    if (!res.ok) throw new Error(data.error_description || data.error || 'Google token refresh failed')
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in }
  }

  async getAccountInfo({ accessToken }) {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch Google account info')
    return { email: data.email, displayName: data.name, providerAccountId: data.id }
  }

  async resolveFolder({ accessToken, folderName }) {
    const q = encodeURIComponent(`name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)
    const searchRes = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${accessToken}` } })
    const searchData = await searchRes.json()
    if (!searchRes.ok) throw new Error(searchData.error?.message || 'Failed to search Drive folders')
    if (searchData.files?.length) return { folderId: searchData.files[0].id }

    const createRes = await fetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
    })
    const createData = await createRes.json()
    if (!createRes.ok) throw new Error(createData.error?.message || 'Failed to create Drive folder')
    return { folderId: createData.id }
  }

<<<<<<< HEAD
  async uploadFile({ accessToken, folderId, fileName, mimeType, buffer }) {
    const metadata = { name: fileName, parents: folderId ? [folderId] : undefined }
    const boundary = `erp_boundary_${Date.now()}`
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || 'Failed to upload file to Google Drive')
    return { fileId: data.id, webUrl: data.webViewLink }
  }

=======
>>>>>>> 8de82f8d6c2378109c87e7d4561ba9192b09e763
  async revokeToken({ accessToken }) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, { method: 'POST' })
  }
}

module.exports = GoogleDriveProvider
