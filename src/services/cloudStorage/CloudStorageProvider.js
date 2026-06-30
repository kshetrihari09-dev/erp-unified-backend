/**
 * src/services/cloudStorage/CloudStorageProvider.js
 *
 * Abstract base class / interface that every cloud storage provider
 * (Google Drive, OneDrive, Dropbox, ...) must implement.
 *
 * This is the single seam the rest of the application talks to —
 * routes and (later) the document-upload pipeline depend only on this
 * shape, never on a specific provider's SDK or REST quirks. Adding a
 * new provider means writing one new subclass and registering it in
 * CloudStorageRegistry; nothing else in the app needs to change.
 *
 * Subclasses must implement every method marked "must override".
 * Methods left at their default here throw, so a half-implemented
 * provider fails loudly during development rather than silently
 * misbehaving in production.
 */
'use strict'

class CloudStorageProvider {
  /**
   * @param {object} opts
   * @param {string} opts.id           Stable machine id, e.g. 'google_drive'
   * @param {string} opts.label        Human label, e.g. 'Google Drive'
   * @param {string} opts.logoKey      Key the frontend maps to a logo asset
   */
  constructor({ id, label, logoKey }) {
    if (new.target === CloudStorageProvider) {
      throw new Error('CloudStorageProvider is abstract and cannot be instantiated directly')
    }
    this.id = id
    this.label = label
    this.logoKey = logoKey
  }

  /**
   * Build the URL the user's browser is redirected to in order to start
   * the OAuth 2.0 consent flow.
   * @param {{ state: string, codeVerifier?: string }} params
   * @returns {string} authorization URL
   * Must override.
   */
  getAuthUrl(/* params */) {
    throw new Error(`${this.id}: getAuthUrl() not implemented`)
  }

  /**
   * Exchange an authorization code for tokens.
   * @param {{ code: string, codeVerifier?: string }} params
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresInSeconds: number }>}
   * Must override.
   */
  async exchangeCodeForTokens(/* params */) {
    throw new Error(`${this.id}: exchangeCodeForTokens() not implemented`)
  }

  /**
   * Use a refresh token to obtain a new access token.
   * @param {{ refreshToken: string }} params
   * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresInSeconds: number }>}
   * Must override.
   */
  async refreshAccessToken(/* params */) {
    throw new Error(`${this.id}: refreshAccessToken() not implemented`)
  }

  /**
   * Fetch basic profile info (email, display name, provider account id)
   * for the connected account, used for display in Settings.
   * @param {{ accessToken: string }} params
   * Must override.
   */
  async getAccountInfo(/* params */) {
    throw new Error(`${this.id}: getAccountInfo() not implemented`)
  }

  /**
   * Lightweight call used by the "Test connection" button — should be
   * cheap (e.g. fetch account info / quota) and must not mutate state.
   * Default implementation reuses getAccountInfo(); providers can
   * override with something cheaper if needed.
   * @param {{ accessToken: string }} params
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async testConnection(params) {
    await this.getAccountInfo(params)
    return { ok: true }
  }

  /**
   * Resolve (and create if necessary) the destination folder used for
   * document backups. Not used for uploads yet (uploads are a future
   * feature) but providers should implement it now so folder selection
   * in Settings can validate the chosen name/path.
   * @param {{ accessToken: string, folderName: string }} params
   * @returns {Promise<{ folderId: string }>}
   * Must override.
   */
  async resolveFolder(/* params */) {
    throw new Error(`${this.id}: resolveFolder() not implemented`)
  }

  /**
   * Upload a file's contents into the resolved backup folder.
   * @param {{ accessToken: string, folderId: string, fileName: string, mimeType: string, buffer: Buffer }} params
   * @returns {Promise<{ fileId: string, webUrl?: string }>}
   * Must override.
   */
  async uploadFile(/* params */) {
    throw new Error(`${this.id}: uploadFile() not implemented`)
  }

  /**
   * Revoke the token with the provider, if the provider's API supports
   * remote revocation. Best-effort — disconnect should succeed locally
   * even if this throws (caller catches and logs).
   * @param {{ accessToken: string, refreshToken: string }} params
   */
  async revokeToken(/* params */) {
    // Optional override — not all providers require/allow this.
  }
}

module.exports = CloudStorageProvider
