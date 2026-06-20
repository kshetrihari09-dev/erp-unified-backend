const twilio = require('twilio');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  throw new Error(
    'Missing Twilio config: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_FROM are required.'
  );
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/**
 * Converts a raw phone number into E.164 international format (+countrycode...).
 * Throws if the number is invalid or ambiguous without a default region.
 *
 * @param {string} rawPhone - phone number as entered by the user
 * @param {string} [defaultCountry] - ISO 3166-1 alpha-2 fallback (e.g. 'US', 'NP') if rawPhone has no leading '+'
 * @returns {string} E.164 formatted number, e.g. '+9779812345678'
 */
function toE164(rawPhone, defaultCountry) {
  const parsed = parsePhoneNumberFromString(rawPhone, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    throw new Error(`Invalid phone number: ${rawPhone}`);
  }
  return parsed.number; // E.164 string
}

/**
 * Sends a one-time password to a user via WhatsApp using Twilio.
 *
 * @param {string} phone - destination phone number (any reasonable format)
 * @param {string} otp - the OTP code to deliver
 * @param {string} [defaultCountry] - ISO country code fallback for parsing local numbers
 * @returns {Promise<{ success: true, messageSid: string } | { success: false, error: string }>}
 */
async function sendWhatsAppOTP(phone, otp, defaultCountry) {
  let toNumber;

  try {
    toNumber = toE164(phone, defaultCountry);
  } catch (err) {
    console.error('[whatsappService] Phone formatting failed:', err.message);
    return { success: false, error: 'Invalid phone number format.' };
  }

  try {
    const message = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${toNumber}`,
      body: `Your verification code is ${otp}. It expires in 5 minutes. Do not share this code with anyone.`,
    });

    console.log(`[whatsappService] OTP sent via WhatsApp. SID: ${message.sid}, status: ${message.status}`);
    return { success: true, messageSid: message.sid };
  } catch (err) {
    // Twilio errors expose .code and .message; log both for debugging
    console.error(
      `[whatsappService] Failed to send WhatsApp OTP to ${toNumber}. Code: ${err.code || 'n/a'}, message: ${err.message}`
    );

    return {
      success: false,
      error: 'Failed to deliver OTP via WhatsApp. Please try again or use an alternate method.',
    };
  }
}

module.exports = { sendWhatsAppOTP, toE164 };
