/**
 * lanDiscovery.js — lets a client on the same LAN find this server without
 * knowing its IP in advance, per the "Automatic LAN discovery" requirement.
 *
 * ── Two complementary mechanisms ─────────────────────────────────────────
 * 1. UDP broadcast responder (this file): listens on a fixed UDP port for
 *    a small "who's out there" packet and replies with this server's
 *    connection info. This is the real, zero-config discovery mechanism —
 *    but a plain web browser tab / Capacitor webview CANNOT send raw UDP
 *    (browsers don't expose that API), so it's only reachable by a native
 *    client (a future Capacitor UDP plugin, a desktop Electron shell,
 *    another Node process, etc.). It's included because it's genuinely
 *    correct, free (Node's `dgram` is a core module — no new dependency),
 *    and is what "the server advertises its presence on the LAN" literally
 *    means. It never blocks server startup or crashes the app if the OS/
 *    sandbox refuses broadcast — worst case it silently does nothing.
 * 2. HTTP probe endpoint (GET /api/v1/discovery/info, see server.js) — the
 *    mechanism the actual web/Capacitor frontend uses today: it sweeps
 *    candidate LAN IPs (see erp-enterprise-full/src/services/discovery.ts)
 *    and asks each one, over plain HTTP with a short timeout, "are you a
 *    Byapar server?". Both mechanisms return the exact same shape and
 *    both are deliberately non-sensitive — no company name, no secrets,
 *    nothing that identifies WHO the server belongs to, only that it is
 *    one and how to reach it (see requirement #9: "LAN discovery only
 *    identifies the server").
 */
const dgram = require('dgram')

const DISCOVERY_PORT = Number(process.env.LAN_DISCOVERY_PORT) || 41235
const REQUEST_MAGIC   = 'BYAPAR_DISCOVER_V1'
const RESPONSE_MAGIC  = 'BYAPAR_SERVER_V1'

function startLanDiscoveryResponder({ getInfo }) {
  let socket
  try {
    socket = dgram.createSocket('udp4')
  } catch (err) {
    console.warn('[LAN Discovery] Could not create UDP socket — automatic discovery disabled:', err.message)
    return null
  }

  socket.on('error', (err) => {
    // Never let a discovery-socket problem take down the actual API server.
    console.warn('[LAN Discovery] UDP socket error (non-fatal):', err.message)
  })

  socket.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== REQUEST_MAGIC) return // ignore anything that isn't our own probe
    try {
      const payload = Buffer.from(JSON.stringify({ magic: RESPONSE_MAGIC, ...getInfo() }))
      socket.send(payload, rinfo.port, rinfo.address)
    } catch (err) {
      console.warn('[LAN Discovery] Failed to reply to discovery probe:', err.message)
    }
  })

  socket.on('listening', () => {
    socket.setBroadcast(true)
    console.log(`   Discovery: UDP ${DISCOVERY_PORT} (LAN broadcast responder)`)
  })

  try {
    socket.bind(DISCOVERY_PORT, '0.0.0.0')
  } catch (err) {
    console.warn('[LAN Discovery] Could not bind UDP port — automatic discovery disabled:', err.message)
    return null
  }

  return socket
}

module.exports = { startLanDiscoveryResponder, DISCOVERY_PORT, REQUEST_MAGIC, RESPONSE_MAGIC }
