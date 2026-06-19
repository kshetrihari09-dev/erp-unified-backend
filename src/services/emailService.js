/**
 * emailService.js — Professional OTP email delivery
 *
 * Supports:
 *   - 'nodemailer_smtp'  any SMTP server (Gmail, Outlook, custom)
 *   - 'brevo'            Brevo transactional email HTTPS API (recommended on
 *                         Render free tier — SMTP ports 25/465/587 are
 *                         blocked there, but HTTPS/443 is never blocked)
 *   - 'sendgrid'         SendGrid API
 *   - 'mailgun'          Mailgun API
 *   - 'console'          Development: print to terminal (default)
 *
 * .env keys:
 *   EMAIL_PROVIDER=smtp|brevo|sendgrid|mailgun|console
 *   EMAIL_FROM_NAME=MediERP
 *   EMAIL_FROM_ADDRESS=noreply@yourcompany.com
 *
 *   # SMTP
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false          (true for port 465)
 *   SMTP_USER=your@gmail.com
 *   SMTP_PASS=your_app_password
 *
 *   # Brevo (HTTPS API — use this on Render free tier instead of smtp)
 *   BREVO_API_KEY=xkeysib-xxxx   (from Brevo: Settings > SMTP & API > API Keys
 *                                 tab — NOT the SMTP key from the SMTP tab)
 *
 *   # SendGrid
 *   SENDGRID_API_KEY=SG.xxxx
 *
 *   # Mailgun
 *   MAILGUN_API_KEY=xxx
 *   MAILGUN_DOMAIN=mg.yourcompany.com
 *   MAILGUN_REGION=us            (or eu)
 */

const https  = require('https')
const http   = require('http')

const APP_NAME    = process.env.APP_NAME          || 'MediERP'
const FROM_NAME   = process.env.EMAIL_FROM_NAME   || APP_NAME
const FROM_ADDR   = process.env.EMAIL_FROM_ADDRESS || `noreply@byapar-nepal.vercel.app`

class EmailService {
  constructor() {
    this.provider = (process.env.EMAIL_PROVIDER || 'console').toLowerCase()
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  /**
   * Send OTP verification email.
   * @param {string} email  recipient email
   * @param {string} otp    plain 6-digit code
   * @param {string} name   recipient name (optional, for personalisation)
   * @returns {{ success: boolean, messageId?: string, provider: string, error?: string }}
   */
  async sendOTP(email, otp, name = '') {
    const subject = `${otp} is your ${APP_NAME} verification code`
    const html    = this._buildEmailHTML(otp, name)
    const text    = this._buildEmailText(otp)

    try {
      switch (this.provider) {
        case 'smtp':
        case 'nodemailer_smtp':
          return await this._sendSMTP(email, subject, html, text)
        case 'brevo':
          return await this._sendBrevo(email, subject, html, text)
        case 'sendgrid':
          return await this._sendSendGrid(email, subject, html, text)
        case 'mailgun':
          return await this._sendMailgun(email, subject, html, text)
        case 'console':
        default:
          return this._consoleSend(email, otp, subject)
      }
    } catch (err) {
      console.error('[Email] Send error:', err.message)
      return { success: false, error: err.message, provider: this.provider }
    }
  }

  /* ── HTML email template ────────────────────────────────────────────────── */

  _buildEmailHTML(otp, name = '') {
    const greeting = name ? `Hi ${name},` : 'Hello,'
    const digits   = otp.split('').map(d =>
      `<span style="display:inline-block;width:44px;height:52px;line-height:52px;text-align:center;font-size:28px;font-weight:700;color:#101828;background:#f0f4ff;border:2px solid #2563eb;border-radius:10px;margin:0 3px;">${d}</span>`
    ).join('')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${APP_NAME} Verification Code</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#2563eb;padding:28px 40px;text-align:center;">
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="width:42px;height:42px;background:rgba(255,255,255,0.18);border-radius:10px;text-align:center;vertical-align:middle;padding:0 8px;">
                  <span style="font-size:22px;font-weight:700;color:#fff;line-height:42px;">✚</span>
                </td>
                <td style="padding-left:10px;">
                  <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${APP_NAME}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 32px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#101828;">${greeting}</p>
            <p style="margin:0 0 24px;font-size:15px;color:#667085;line-height:1.6;">
              Your verification code for <strong>${APP_NAME}</strong> is:
            </p>

            <!-- OTP digits -->
            <div style="text-align:center;margin:0 0 28px;">
              ${digits}
            </div>

            <!-- Expiry notice -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#fff8ed;border:1px solid #fbbf24;border-radius:10px;padding:14px 18px;">
                  <p style="margin:0;font-size:13px;color:#92400e;">
                    ⏱  This code expires in <strong>5 minutes</strong>.
                    If you didn't request this, please ignore this email.
                  </p>
                </td>
              </tr>
            </table>

            <p style="margin:24px 0 0;font-size:13px;color:#98a2b3;">
              For security, never share this code with anyone.
              ${APP_NAME} will never ask for your OTP over the phone or chat.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e4e7ec;">
            <p style="margin:0;font-size:12px;color:#98a2b3;text-align:center;">
              © ${new Date().getFullYear()} ${APP_NAME} &middot; Pharma ERP &amp; Accounting System<br/>
              This is an automated message, please do not reply.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
  }

  _buildEmailText(otp) {
    return [
      `Your ${APP_NAME} verification code is: ${otp}`,
      '',
      `This code expires in 5 minutes.`,
      `Do not share this code with anyone.`,
      '',
      `If you didn't request this, please ignore this email.`,
      '',
      `— ${APP_NAME} Team`,
    ].join('\n')
  }

  /* ── Providers ──────────────────────────────────────────────────────────── */

  _consoleSend(email, otp, subject) {
    console.log('\n' + '═'.repeat(54))
    console.log(`📧 Email OTP (console mode) → ${email}`)
    console.log(`   Subject : ${subject}`)
    console.log(`   OTP     : ${otp}`)
    console.log(`   Expires : 5 minutes`)
    console.log('═'.repeat(54) + '\n')
    return { success: true, messageId: `email-console-${Date.now()}`, provider: 'console' }
  }

  async _sendSMTP(to, subject, html, text) {
    // Use nodemailer if available, otherwise fall back to raw SMTP
    try {
      const nodemailer = require('nodemailer')
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      })

      const info = await transporter.sendMail({
        from:    `"${FROM_NAME}" <${FROM_ADDR}>`,
        to,
        subject,
        text,
        html,
      })

      return { success: true, messageId: info.messageId, provider: 'smtp' }
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        throw new Error('nodemailer not installed. Run: npm install nodemailer')
      }
      throw err
    }
  }

  async _sendBrevo(to, subject, html, text) {
    // .trim() guards against trailing newlines/whitespace that can sneak in
    // when copy-pasting the key into a dashboard input field — Node's http
    // module rejects header values containing \n/\r with
    // "Invalid character in header content".
    const apiKey = (process.env.BREVO_API_KEY || '').trim()
    if (!apiKey) throw new Error('BREVO_API_KEY is required (Brevo dashboard: Settings > SMTP & API > API Keys tab)')

    const payload = JSON.stringify({
      sender:      { name: FROM_NAME, email: FROM_ADDR },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    })

    const result = await this._post(
      'https://api.brevo.com/v3/smtp/email',
      payload,
      {
        'Content-Type': 'application/json',
        'api-key':      apiKey,
        'Accept':       'application/json',
      }
    )

    if (result.messageId) {
      return { success: true, messageId: result.messageId, provider: 'brevo' }
    }
    return { success: false, error: result.message || JSON.stringify(result), provider: 'brevo' }
  }

  async _sendSendGrid(to, subject, html, text) {
    const apiKey = process.env.SENDGRID_API_KEY
    if (!apiKey) throw new Error('SENDGRID_API_KEY is required')

    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from:    { email: FROM_ADDR, name: FROM_NAME },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html',  value: html },
      ],
    })

    const result = await this._post(
      'https://api.sendgrid.com/v3/mail/send',
      payload,
      {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      }
    )

    // SendGrid returns 202 with empty body on success
    if (result._status === 202 || !result.errors) {
      return { success: true, messageId: `sg-${Date.now()}`, provider: 'sendgrid' }
    }
    return { success: false, error: JSON.stringify(result.errors), provider: 'sendgrid' }
  }

  async _sendMailgun(to, subject, html, text) {
    const apiKey = process.env.MAILGUN_API_KEY
    const domain = process.env.MAILGUN_DOMAIN
    const region = (process.env.MAILGUN_REGION || 'us').toLowerCase()

    if (!apiKey || !domain) throw new Error('MAILGUN_API_KEY and MAILGUN_DOMAIN are required')

    const baseUrl = region === 'eu'
      ? `https://api.eu.mailgun.net/v3/${domain}/messages`
      : `https://api.mailgun.net/v3/${domain}/messages`

    const payload = new URLSearchParams({
      from:    `${FROM_NAME} <${FROM_ADDR}>`,
      to,
      subject,
      text,
      html,
    }).toString()

    const result = await this._post(baseUrl, payload, {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
    })

    if (result.id) return { success: true, messageId: result.id, provider: 'mailgun' }
    return { success: false, error: result.message || 'Mailgun failed', provider: 'mailgun' }
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
          try {
            const parsed = JSON.parse(data)
            parsed._status = res.statusCode
            resolve(parsed)
          } catch {
            resolve({ raw: data, _status: res.statusCode })
          }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

module.exports = new EmailService()
