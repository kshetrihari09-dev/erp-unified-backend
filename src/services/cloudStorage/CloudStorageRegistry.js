/**
 * src/services/cloudStorage/CloudStorageRegistry.js
 *
 * Central registry of available cloud storage providers. This is the
 * ONLY place that needs to change when adding a new provider — create
 * a new class implementing CloudStorageProvider, instantiate it here,
 * and it automatically becomes available in the API and Settings UI.
 */
'use strict'

const GoogleDriveProvider = require('./providers/googleDriveProvider')
const OneDriveProvider = require('./providers/oneDriveProvider')
const DropboxProvider = require('./providers/dropboxProvider')

const providers = [
  new GoogleDriveProvider(),
  new OneDriveProvider(),
  new DropboxProvider(),
]

const byId = new Map(providers.map((p) => [p.id, p]))

function listProviders() {
  return providers
}

function getProvider(id) {
  const provider = byId.get(id)
  if (!provider) {
    const err = new Error(`Unknown cloud storage provider: "${id}"`)
    err.status = 400
    throw err
  }
  return provider
}

function isValidProviderId(id) {
  return byId.has(id)
}

module.exports = { listProviders, getProvider, isValidProviderId }
