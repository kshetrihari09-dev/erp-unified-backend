/**
 * smsService.js — SMS provider abstraction
 *
 * Supports multiple providers via SMS_PROVIDER env var:
 *   - 'sparrow'   — Sparrow SMS (Nepal, https://sparrowsms.com)
 *   - 'aakash'    — Aakash SMS (Nepal)
 *   - 'twilio'    — Twilio (international)
 *   - 'console'   — Development: logs OTP to console (default when not configured)
 *
 * Set in .env:
 *   SMS_PROVIDER=sparrow
 *   SMS_API_KEY=your_token_here
 *   SMS_SENDER_ID=YourBrand
 *   SMS_FROM=+977...   (for Twilio)
 *   TWILIO_ACCOUNT_SID=ACxxx
 *   TWILIO_AUTH_TOKEN=xxx
 */

const https = require('https')
const http  = require('http')

class SMSService {
  constructor() {
    this.provider   = (process.env.SMS_PROVIDER || 'console').toLowerCase()
    this.apiKey     = process.env.SMS_API_KEY
    this.senderId   = process.env.SMS_SENDER_ID || 'MediERP'
  }

  /**
   * Send an OTP to a phone number.
   * @param {string} phone  — E.164 or local format
   * @param {string} otp    — 6-digit plain OTP
   * @returns {{ success: boolean, messageId?: string, error?: string }}
   */
  async sendOTP(phone, otp) {
    const message = `Your MediERP verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`

    try {
      switch (this.provider) {
        case 'sparrow':
          return await this._sendSparrow(phone, message)
        case 'aakash':
          return await this._sendAakash(phone, message)
        case 'twilio':
          return await this._sendTwilio(phone, message)
        case 'console':
        default:
          return this._consoleSend(phone, otp, message)
      }
    } catch (err) {
      console.error('[SMS] Send error:', err.message)
      return { success: false, error: err.message }
    }
  }

  /** Development: log to console */
  _consoleSend(phone, otp, message) {
    console.log('\n' + '═'.repeat(50))
    console.log(`📱 SMS (console mode) → ${phone}`)
    console.log(`   OTP: ${otp}`)
    console.log(`   Msg: ${message}`)
    console.log('═'.repeat(50) + '\n')
    return { success: true, messageId: `console-${Date.now()}` }
  }

  /** Sparrow SMS (Nepal) */
  async _sendSparrow(phone, message) {
    // Sparrow expects local format: 98XXXXXXXX
    const localPhone = phone.replace(/^\+977/, '').replace(/\s/g, '')
    const payload = JSON.stringify({
      token:  this.apiKey,
      from:   this.senderId,
      to:     localPhone,
      text:   message,
    })

    const result = await this._post('https://api.sparrowsms.com/v2/sms/', payload, {
      'Content-Type': 'application/json',
    })

    if (result.response_code === 200) {
      return { success: true, messageId: result.uid }
    }
    return { success: false, error: result.message || 'Sparrow send failed' }
  }

  /** Aakash SMS (Nepal) */
  async _sendAakash(phone, message) {
    const localPhone = phone.replace(/^\+977/, '').replace(/\s/g, '')
    const payload = new URLSearchParams({
      auth_token: this.apiKey,
      to:         localPhone,
      text:       message,
    }).toString()

    const result = await this._post('https://sms.aakashsms.com/sms/v3/send/', payload, {
      'Content-Type': 'application/x-www-form-urlencoded',
    })

    if (result.success) {
      return { success: true, messageId: result.uid }
    }
    return { success: false, error: result.message || 'Aakash SMS send failed' }
  }

  /** Twilio */
  async _sendTwilio(phone, message) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID
    const authToken  = process.env.TWILIO_AUTH_TOKEN
    const from       = process.env.SMS_FROM

    if (!accountSid || !authToken || !from) {
      throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_FROM)')
    }

    const payload = new URLSearchParams({
      To:   phone,
      From: from,
      Body: message,
    }).toString()

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
    const result = await this._post(url, payload, {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
    })

    if (result.sid) {
      return { success: true, messageId: result.sid }
    }
    return { success: false, error: result.message || 'Twilio send failed' }
  }

  /** Generic HTTPS POST helper */
  _post(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const isHttps   = parsedUrl.protocol === 'https:'
      const lib       = isHttps ? https : http

      const options = {
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || (isHttps ? 443 : 80),
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'POST',
        headers:  {
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      }

      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve({ raw: data })
          }
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

module.exports = new SMSService()
