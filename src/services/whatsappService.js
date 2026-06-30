/**
 * whatsappService.js — WhatsApp OTP delivery
 *
 * Supports multiple providers:
 *   - 'twilio'      Twilio WhatsApp Business API
 *   - 'meta'        Meta (Facebook) Cloud API — direct WhatsApp Business
 *   - 'gupshup'     Gupshup (popular in South Asia)
 *   - 'console'     Development: print to terminal (default)
 *
 * .env keys:
 *   WA_PROVIDER=twilio|meta|gupshup|console
 *
 *   # Twilio
 *   TWILIO_ACCOUNT_SID=ACxxx
 *   TWILIO_AUTH_TOKEN=xxx
 *   TWILIO_WA_FROM=whatsapp:+14155238886   (sandbox or approved number)
 *
 *   # Meta Cloud API
 *   META_WA_TOKEN=EAAxxxxxx
 *   META_WA_PHONE_ID=1234567890
 *   META_WA_TEMPLATE_NAME=otp_verification  (pre-approved template name)
 *
 *   # Gupshup
 *   GUPSHUP_API_KEY=xxx
 *   GUPSHUP_APP_NAME=MediERP
 *   GUPSHUP_SRC_NAME=+9779XXXXXXXXX
 *
 * WhatsApp Business API requires approved message templates.
 * For testing/development use 'console' or Twilio sandbox.
 */

const https = require('https')
const http  = require('http')

class WhatsAppService {
  constructor() {
    this.provider = (process.env.WA_PROVIDER || 'console').toLowerCase()
  }

  /**
   * Send OTP via WhatsApp.
   * @param {string} phone  E.164 format (+9779XXXXXXXX)
   * @param {string} otp    6-digit plain code
   * @returns {{ success: boolean, messageId?: string, provider: string, error?: string }}
   */
  async sendOTP(phone, otp) {
    try {
      switch (this.provider) {
        case 'twilio':   return await this._sendTwilio(phone, otp)
        case 'meta':     return await this._sendMeta(phone, otp)
        case 'gupshup':  return await this._sendGupshup(phone, otp)
        case 'console':
        default:         return this._consoleSend(phone, otp)
      }
    } catch (err) {
      console.error('[WhatsApp] Send error:', err.message)
      return { success: false, error: err.message, provider: this.provider }
    }
  }

  /* ── Console (dev) ──────────────────────────────────────────────────────── */
  _consoleSend(phone, otp) {
    console.log('\n' + '═'.repeat(52))
    console.log(`📲 WhatsApp OTP (console mode) → ${phone}`)
    console.log(`   OTP   : ${otp}`)
    console.log(`   Msg   : Your MediERP code is ${otp}. Valid 5 min.`)
    console.log('═'.repeat(52) + '\n')
    return { success: true, messageId: `wa-console-${Date.now()}`, provider: 'console' }
  }

  /* ── Twilio WhatsApp ────────────────────────────────────────────────────── */
  async _sendTwilio(phone, otp) {
    const sid       = process.env.TWILIO_ACCOUNT_SID
    const token     = process.env.TWILIO_AUTH_TOKEN
    const from      = process.env.TWILIO_WA_FROM || 'whatsapp:+14155238886'

    if (!sid || !token) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required')
    }

    const body    = `Your MediERP verification code is: *${otp}*\n\nThis code expires in 5 minutes.\nDo not share this code with anyone.`
    const payload = new URLSearchParams({
      To:   `whatsapp:${phone}`,
      From: from,
      Body: body,
    }).toString()

    const url    = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`
    const result = await this._post(url, payload, {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
    })

    if (result.sid) return { success: true, messageId: result.sid, provider: 'twilio' }
    return { success: false, error: result.message || 'Twilio WA failed', provider: 'twilio' }
  }

  /* ── Meta Cloud API ─────────────────────────────────────────────────────── */
  async _sendMeta(phone, otp) {
    const waToken    = process.env.META_WA_TOKEN
    const phoneId    = process.env.META_WA_PHONE_ID
    const template   = process.env.META_WA_TEMPLATE_NAME || 'otp_verification'

    if (!waToken || !phoneId) {
      throw new Error('META_WA_TOKEN and META_WA_PHONE_ID are required')
    }

    // Meta Cloud API uses pre-approved templates with variable substitution.
    // The template must have a body component with {{1}} for the OTP code.
    // Example approved template body: "Your verification code is {{1}}. Valid for 5 minutes."
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to:                phone.replace('+', ''),  // Meta wants no leading +
      type:              'template',
      template: {
        name:     template,
        language: { code: 'en_US' },
        components: [
          {
            type:       'body',
            parameters: [{ type: 'text', text: otp }],
          },
          {
            // Button component for OTP templates (copy code button)
            type:     'button',
            sub_type: 'url',
            index:    '0',
            parameters: [{ type: 'text', text: otp }],
          },
        ],
      },
    })

    const result = await this._post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      payload,
      {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${waToken}`,
      }
    )

    if (result.messages?.[0]?.id) {
      return { success: true, messageId: result.messages[0].id, provider: 'meta' }
    }
    const errMsg = result.error?.message || JSON.stringify(result)
    return { success: false, error: errMsg, provider: 'meta' }
  }

  /* ── Gupshup ────────────────────────────────────────────────────────────── */
  async _sendGupshup(phone, otp) {
    const apiKey   = process.env.GUPSHUP_API_KEY
    const appName  = process.env.GUPSHUP_APP_NAME  || 'MediERP'
    const srcName  = process.env.GUPSHUP_SRC_NAME  || appName

    if (!apiKey) throw new Error('GUPSHUP_API_KEY is required')

    const message = `Your MediERP verification code is: ${otp}. Valid for 5 minutes. Do not share.`
    const payload = new URLSearchParams({
      channel:  'whatsapp',
      source:   srcName,
      destination: phone.replace('+', ''),
      message:  JSON.stringify({ type: 'text', text: message }),
      'src.name': appName,
    }).toString()

    const result = await this._post(
      'https://api.gupshup.io/sm/api/v1/msg',
      payload,
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        'apikey':       apiKey,
      }
    )

    if (result.status === 'submitted') {
      return { success: true, messageId: result.messageId, provider: 'gupshup' }
    }
    return { success: false, error: result.message || 'Gupshup failed', provider: 'gupshup' }
  }

  /* ── HTTP helper ────────────────────────────────────────────────────────── */
  _post(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const lib    = parsed.protocol === 'https:' ? https : http
      const opts   = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  { 'Content-Length': Buffer.byteLength(body), ...headers },
      }
      const req = lib.request(opts, (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ raw: data }) }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

module.exports = new WhatsAppService()
