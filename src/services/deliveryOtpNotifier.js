/**
 * services/deliveryOtpNotifier.js — get the delivery code to the customer.
 *
 * Reuses the notification providers this project already ships
 * (services/smsService.js, services/whatsappService.js) — no new
 * provider, no new account, no new env surface beyond what those two
 * already read (spec §14). If neither is configured for real, both fall
 * back to their existing console mode and the customer still has the
 * code on their authenticated tracking page, which is the source of
 * truth either way.
 *
 * Channel choice, in order:
 *   1. WhatsApp, if WA_PROVIDER is set to a real provider. Preferred
 *      where it works — the existing service's Meta path uses a
 *      pre-approved OTP template, which is the only reliable way to get
 *      a code through WhatsApp Business.
 *   2. SMS. Always attempted if WhatsApp is not really configured,
 *      because it carries the full contextual wording (order number +
 *      the "do not share until your order arrives" warning) that a
 *      locked WhatsApp template cannot.
 *
 * Delivery failure NEVER fails the caller. Marking an order out for
 * delivery must not roll back because an SMS gateway had a bad minute —
 * the code is already issued and visible on the tracking page. Every
 * function here resolves to a plain result object and throws nothing.
 */
'use strict'

const smsService = require('./smsService')
const whatsappService = require('./whatsappService')

/** Is a channel pointed at something other than its dev console stub? */
const whatsappConfigured = () =>
  !!process.env.WA_PROVIDER && process.env.WA_PROVIDER.toLowerCase() !== 'console'

function buildMessage(orderNo, code) {
  return `Your order ${orderNo} is out for delivery. Your delivery verification code is ${code}. Do not share this code until your order arrives.`
}

/**
 * @param {object} args
 * @param {string} args.phone    — customer's delivery/contact phone
 * @param {string} args.orderNo  — human order number, e.g. CO-2081-014
 * @param {string} args.code     — the plain 6-digit code. Passed straight
 *                                 to a provider and never returned,
 *                                 logged, or stored by this module.
 * @returns {Promise<{ sent: boolean, channel: string|null, error?: string }>}
 */
async function sendDeliveryOtp({ phone, orderNo, code }) {
  if (!phone) return { sent: false, channel: null, error: 'no_phone_on_file' }

  if (whatsappConfigured()) {
    try {
      const res = await whatsappService.sendOTP(phone, code)
      if (res?.success) return { sent: true, channel: 'whatsapp' }
    } catch (err) {
      // Deliberately swallowed and retried on SMS — see docblock.
      console.error('[DeliveryOTP] WhatsApp send failed, falling back to SMS:', err.message)
    }
  }

  try {
    const res = await smsService.sendMessage(phone, buildMessage(orderNo, code), 'Delivery code')
    if (res?.success) return { sent: true, channel: 'sms' }
    return { sent: false, channel: 'sms', error: res?.error || 'send_failed' }
  } catch (err) {
    console.error('[DeliveryOTP] SMS send failed:', err.message)
    return { sent: false, channel: 'sms', error: err.message }
  }
}

/**
 * Which number a delivery code should go to.
 *
 * The delivery phone captured at checkout wins — for a delivery order
 * that is, by definition, the number of whoever will be standing at the
 * door. Only if it was never captured (a pickup order later switched to
 * delivery, or a guest who left it blank) does this fall back to the
 * party's own contact number.
 *
 * Accepts a knex instance or a transaction, so callers can resolve this
 * inside or outside their transaction as suits them.
 */
async function resolveCustomerPhone(qb, order) {
  if (order.delivery_phone) return order.delivery_phone
  const party = await qb('parties').where({ id: order.party_id }).select('phone').first()
  return party?.phone || null
}

module.exports = { sendDeliveryOtp, resolveCustomerPhone }
