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
    saleDateEdit:      false,
    invoiceCancel:     false,
    fiscalYearChange:  false,
    companySettings:   false,
  },
  backup: {
    autoEnabled: false,
    frequency:   'daily', // 'daily' | 'weekly' | 'monthly'
  },
  devices: {
    // Enforced in routes/devices.js POST /register — kept here (not
    // hard-coded) so an account can be granted a higher/lower limit
    // without a code change, same pattern as every other per-company
    // toggle in this file.
    maxDevices: 5,
  },
  // Read by services/purchaseSuggestionsEngine.js + routes/purchaseSuggestions.js.
  // Product-specific columns (products.supplier_lead_time_days,
  // safety_stock_days, safety_stock_qty, reorder_point_override) always take
  // precedence over these company-wide defaults when useProductSpecificSettings
  // is true and a product has set them.
  purchaseSuggestions: {
    defaultPeriodDays:          30,    // 7 | 30 | 60 | 90 | custom (custom handled via explicit date_from/date_to params)
    includeZeroSalesProducts:   false, // if true, products with no sales in the period still appear (status "No Sales Data")
    salesAnalysisMethod:        'average', // 'average' — reserved for future methods (e.g. weighted/moving average)
    defaultLeadTimeDays:        3,
    safetyStockDays:            2,
    criticalStockDays:          3,     // days_remaining <= this → Critical
    lowStockDays:                7,    // days_remaining <= this (and > critical) → Low
    considerIncomingPurchaseOrders: true,
    considerReservedStock:      false, // reserved_stock is always 0 in this system today (no sales-order/reservation module); kept as a forward-compatible toggle
    useProductSpecificSettings: true,
  },
  // Read by services/creditRiskEngine.js + routes/creditRisk.js.
  creditRisk: {
    scoringPeriodDays: 180, // "Last 6 months" — 90 | 180 | 365 | custom (custom via explicit date params)
    weights: {
      // Must sum to 100 — validated in routes/creditRisk.js PUT /settings.
      onTimePaymentRate:   25,
      paymentDelay:        20,
      overdueExposure:     20,
      creditUtilization:   15,
      latePaymentFrequency: 10,
      defaultHistory:      10,
    },
    thresholds: {
      lowRiskMin:    80, // score >= this → Low Risk
      mediumRiskMin: 50, // score >= this (and < lowRiskMin) → Medium Risk; below → High Risk
    },
    // How many risk-score points an average day of payment delay costs,
    // before weighting — e.g. 3 → a 33-day average delay alone drives the
    // payment-delay factor to 0. Transparent & configurable per requirement #2/#4.
    delayScorePenaltyPerDay: 3,
    onTimeGraceDays: 0, // a payment this many days after due date still counts as "on time"
    // Bad debt: kept as a single transparent multiplier + per-incident
    // penalty rather than a black-box model — requirement #6 explicitly
    // forbids presenting this as an AI prediction.
    badDebt: {
      probabilityMultiplier: 1.15, // bad_debt_probability = min(100, (100 - score) * multiplier + badDebtRecordCount * perIncidentBump)
      perIncidentBump: 10,
    },
    // Trend comparison: recent window vs. the remainder of the scoring
    // period (e.g. scoringPeriodDays=180 → last 90 days vs. prior 90 days).
    trendRecentWindowDays: 90,
    trendChangeThresholdDays: 3, // recent avg delay must differ by more than this to call it Improving/Worsening rather than Stable
    // Recommendation rules (requirement #8) — recommendation-only by default (requirement #9).
    recommendations: {
      mediumRiskLimitPct: 65,   // recommended limit = this % of current limit, when Medium Risk
      highRiskLowLimit:   0,    // recommended limit when High Risk (0 = require prepayment, no open credit)
      mediumRiskTermsDays: 15,  // "Net-15"
      highRiskTermsDays:   0,   // 0 = prepayment
    },
    automaticActions: 'recommendation_only', // 'recommendation_only' | 'require_approval' | 'block_high_risk'
    alerts: {
      highRiskEnabled: true,
      scoreDropThreshold: 15,      // alert when score drops by more than this within scoreDropWindowDays
      scoreDropWindowDays: 30,
      badDebtProbabilityThreshold: 60, // alert when bad-debt probability exceeds this
      criticalOverdueAmount: 100000,    // company-currency amount; alert when a customer's overdue exceeds this
    },
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
