/**
 * settingsDefaults.js
 *
 * Default shape for `companies.settings` (jsonb). Every field here is
 * actually read somewhere (see settings.js GET/PUT /preferences, and the
 * requireSensitiveConfirm middleware for `sensitiveActions`) — nothing in
 * this default object is decorative.
 *
 * Existing typed company columns (name, currency, vat_percent,
 * invoice_prefix, date_system, ...) are NOT duplicated here; General/
 * Company settings on the frontend read/write those via the existing
 * GET/PUT /settings/company endpoints.
 */
const DEFAULT_SETTINGS = {
  general: {
    dateDisplayMode:    'AD',    // 'AD' | 'BS' | 'BOTH' — mirrors/seeds the frontend's global dateMode
    numberFormat:       'en-IN', // Intl.NumberFormat locale used for amounts
    timeZone:           'Asia/Kathmandu',
    defaultPaymentMode: 'none',  // 'none' = force manual selection; otherwise one of PAYMENT_MODES
    roundOff:           true,    // whether invoices auto round-off net total
  },
  salesPurchase: {
    invoicePrefixOverride: '',   // '' = use companies.invoice_prefix as-is
    roundOff:              true,
    taxPercentOverride:    null, // null = use companies.vat_percent
    creditDays:            30,
    allowNegativeStock:    false,
    allowExpiredBatchSale: false,
    requireBatchOnSale:    true,
    requireExpiryOnBatch:  true,
  },
  accounting: {
    voucherNumberingPrefix: {
      RECEIPT: 'RCPT', PAYMENT: 'PAY', JOURNAL: 'JV', CONTRA: 'CN',
      DEBIT_NOTE: 'DN', CREDIT_NOTE: 'CRN', OPENING: 'OP',
    },
    defaultCashAccountId:     null,
    defaultBankAccountId:     null,
    customerControlAccountId: null,
    supplierControlAccountId: null,
    discountAccountId:        null,
    roundOffAccountId:        null,
  },
  notifications: {
    lowStock:          true,
    expiry:            true,
    outstandingBalance: true,
    paymentDue:        true,
    backupFailure:     true,
    systemAlerts:      true,
  },
  sensitiveActions: {
    // When true, the matching backend route requires a correct
    // `confirmPassword` (the acting user's own account password) in the
    // request body, verified in requireSensitiveConfirm(). Voucher editing
    // itself is intentionally NOT listed — it already always requires
    // both `edit_posted_vouchers` permission AND password confirmation
    // (see accounting.js PUT /vouchers/:id/edit + verify-password), so
    // it can't be weakened from here.
    paymentModeEdit:   false,
    invoiceCancel:     false,
    fiscalYearChange:  false,
    companySettings:   false,
  },
  backup: {
    autoEnabled: false,
    frequency:   'daily', // 'daily' | 'weekly' | 'monthly'
  },
}

/** One level deep-merge per top-level section — enough for this flat shape
 *  and avoids a generic deep-merge dependency. Unknown top-level keys in
 *  `incoming` are ignored (keeps the settings object bounded/typed). */
function mergeSettings(stored = {}, incoming = {}) {
  const merged = {}
  for (const section of Object.keys(DEFAULT_SETTINGS)) {
    merged[section] = {
      ...DEFAULT_SETTINGS[section],
      ...(stored?.[section] || {}),
      ...(incoming?.[section] || {}),
    }
  }
  return merged
}

/** Fill in any missing sections/fields with defaults (used for GET / reads). */
function withDefaults(stored = {}) {
  return mergeSettings(stored, {})
}

module.exports = { DEFAULT_SETTINGS, mergeSettings, withDefaults }
