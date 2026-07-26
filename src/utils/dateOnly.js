/**
 * dateOnly.js — helpers for handling accounting dates as plain
 * 'YYYY-MM-DD' calendar strings, never as JS Date objects.
 *
 * A JS Date object always carries an implicit timezone. Building one from
 * a date-only string and then reading it back with local-timezone methods
 * (getFullYear(), toLocaleDateString(), etc.) or UTC methods
 * (toISOString()) can silently shift the calendar day by ±1 depending on
 * the server's offset from UTC. Accounting dates (voucher_date, entry_date,
 * due_date, period boundaries) must never be exposed to that risk, so this
 * module works on the string form directly and only ever uses Date.UTC as
 * a pure calendar calculator (never to represent something that gets
 * displayed or stored).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True if `value` is a real calendar date in 'YYYY-MM-DD' form. */
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12) return false
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return d >= 1 && d <= daysInMonth
}

/** The 4-digit calendar year of a 'YYYY-MM-DD' string. */
function yearOf(dateOnly) {
  return dateOnly.slice(0, 4)
}

/** Today's date, in the server's local calendar day, as 'YYYY-MM-DD'.
 *  Deliberately avoids `new Date().toISOString()`, which reports UTC's
 *  calendar day — for servers running ahead of UTC (e.g. Nepal Time),
 *  that can read as "yesterday" for the first few hours of each day. */
function todayDateOnly() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

module.exports = { isValidDateOnly, yearOf, todayDateOnly }
