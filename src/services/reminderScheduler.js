/**
 * services/reminderScheduler.js — Section 21/4 of the Smart Reminder spec.
 *
 * This codebase has no external job queue or cron infrastructure — the
 * one precedent (automatic backups, services/backupService.js) runs as a
 * plain in-process `setInterval` from server.js. This follows the exact
 * same shape rather than introducing a new scheduling mechanism, per the
 * spec's own instruction: "If the current deployment architecture cannot
 * reliably run background jobs, ... integrate with the project's existing
 * scheduler/cron architecture rather than introducing an incompatible
 * service."
 *
 * Two independent jobs, each per-company, each never throwing into the
 * caller and never letting one company's failure affect another's
 * (same isolation guarantee as recalcAllCustomers/checkAndRunDueBackups):
 *
 *   processDueReminders()      — write a `notifications` row for every
 *                                 reminder whose effective due time has
 *                                 arrived and hasn't been notified for
 *                                 yet (notified_at tracks this per
 *                                 reminder — see migration 033).
 *
 *   generateAutomaticReminders() — sweep overdue invoices and suggest
 *                                 (create, deduplicated) a payment
 *                                 follow-up reminder for each one that
 *                                 doesn't already have a pending one.
 *                                 Low-stock is intentionally NOT swept
 *                                 here yet — see the docblock on
 *                                 sweepLowStock() below for why.
 */
const db = require('../db/knex')
const { createIfNotExists } = require('./reminderService')

async function notify(companyId, reminder) {
  try {
    await db('notifications').insert({
      company_id: companyId,
      user_id: reminder.assigned_user_id || null, // null = company-wide, same convention as creditRiskRecalc.js
      category: 'reminder',
      severity: reminder.priority === 'urgent' || reminder.priority === 'high' ? 'warning' : 'info',
      title: `🔔 ${reminder.title}`,
      message: reminder.description || 'Reminder due now.',
      related_customer_id: reminder.customer_id || null,
      metadata: JSON.stringify({ reminder_id: reminder.id, reminder_type: reminder.reminder_type, invoice_id: reminder.invoice_id || null }),
    })
  } catch (err) {
    // Never let a failed notification write block marking the reminder as
    // notified below — requirement #21.6/21.8's "handle failed
    // notification delivery safely" would otherwise turn one bad insert
    // into the same reminder re-notifying (or worse, blocking) forever.
    console.error('[reminderScheduler] failed to write notification for reminder', reminder.id, err.message)
  }
}

/** One pass: find every company's due, un-notified reminders and notify. */
async function processDueReminders() {
  const now = new Date()
  const due = await db('reminders')
    .where('status', 'pending')
    .where(db.raw('COALESCE(snoozed_until, reminder_at)'), '<=', now)
    .whereNull('notified_at')
    .select('*')

  for (const reminder of due) {
    try {
      await notify(reminder.company_id, reminder)
      await db('reminders').where({ id: reminder.id }).update({ notified_at: now })
    } catch (err) {
      // One reminder's failure (e.g. its company was deleted mid-sweep)
      // must never stop the rest of the batch.
      console.error('[reminderScheduler] failed processing reminder', reminder.id, err.message)
    }
  }
  return { notified: due.length }
}

/**
 * Overdue-invoice → payment-follow-up reminder (requirement #4's primary
 * example). "Overdue" mirrors the same definition services/
 * creditRiskEngine.js uses elsewhere in this codebase: an active sale
 * with due_amount > 0 whose customer's credit term (parties.credit_days)
 * has elapsed since the invoice date — not a separate/di verging
 * definition of "overdue" invented just for reminders.
 */
async function sweepOverdueInvoices(companyId) {
  const rows = await db('sales as s')
    .join('parties as p', 'p.id', 's.party_id')
    .where('s.company_id', companyId)
    .where('s.status', 'active')
    .where('s.due_amount', '>', 0)
    .whereRaw(`s.date_ad + (COALESCE(p.credit_days, 30) || ' days')::interval < now()`)
    .select('s.id', 's.invoice_no', 's.due_amount', 's.date_ad', 'p.id as customer_id', 'p.name as customer_name', 'p.credit_days')

  let created = 0
  for (const row of rows) {
    const daysOverdue = Math.floor((Date.now() - new Date(row.date_ad).getTime()) / 86400000) - (row.credit_days || 30)
    const id = await createIfNotExists(companyId, {
      reminder_type: 'INVOICE_FOLLOW_UP',
      link_field: 'invoice_id',
      link_id: row.id,
      title: `Payment follow-up for ${row.customer_name}`,
      description: `Invoice ${row.invoice_no} — Rs. ${Number(row.due_amount).toFixed(2)} outstanding, ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue.`,
      reminder_at: new Date(), // due immediately — it's already overdue
      priority: daysOverdue > 14 ? 'urgent' : daysOverdue > 7 ? 'high' : 'medium',
    }).catch(err => { console.error('[reminderScheduler] overdue-invoice reminder failed for sale', row.id, err.message); return null })
    if (id) created++
  }
  return created
}

/**
 * Low-stock → reorder reminder. Deliberately NOT wired into the interval
 * sweep below. This codebase's existing low-stock detection
 * (reportsAPI.dashboard()'s low_stock_items, AppLayout.tsx's nav badge)
 * is a live COUNT computed on read, not a table of "which specific
 * products are currently low" with stable IDs to key a dedupe check off
 * of — building that mapping correctly (and re-checking it on every
 * sweep without recreating a reminder for a product that's still low
 * from the last sweep) is genuinely more than a one-file addition, and
 * guessing at it risks exactly the "repeated reminder every time stock
 * changes" bug the spec explicitly warns against. Left as a manual
 * "+ Reminder" action from the Stock page for now (LOW_STOCK_FOLLOW_UP
 * type already exists end-to-end for that); wiring the automatic sweep
 * is a clean, isolated follow-up once the product's low-stock query is
 * confirmed alongside whoever owns routes/stock.js.
 */
async function sweepLowStock(_companyId) { return 0 }

async function generateAutomaticReminders() {
  const companies = await db('companies').select('id')
  let totalCreated = 0
  for (const c of companies) {
    try {
      totalCreated += await sweepOverdueInvoices(c.id)
      totalCreated += await sweepLowStock(c.id)
    } catch (err) {
      console.error('[reminderScheduler] automatic-reminder sweep failed for company', c.id, err.message)
    }
  }
  return { created: totalCreated }
}

module.exports = { processDueReminders, generateAutomaticReminders, sweepOverdueInvoices }
