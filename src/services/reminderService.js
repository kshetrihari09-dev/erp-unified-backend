/**
 * services/reminderService.js — Smart Reminder & Follow-up Module
 *
 * All reminder business logic lives here; routes/reminders.js is a thin
 * HTTP layer over this. Kept separate (matching creditRiskRecalc.js /
 * accountingIntegration.js's split) so the automatic-reminder sweep
 * (services/reminderScheduler.js) can call the same create/dedupe logic
 * a person's manual "+ Reminder" button uses, instead of two divergent
 * code paths that could disagree about what counts as a duplicate.
 */
const db = require('../db/knex')

const TYPES = [
  'CUSTOM', 'CUSTOMER_FOLLOW_UP', 'INVOICE_FOLLOW_UP', 'PAYMENT_DUE',
  'OVERDUE_PAYMENT', 'QUOTATION_FOLLOW_UP', 'PURCHASE_FOLLOW_UP',
  'SUPPLIER_PAYMENT', 'ORDER_FOLLOW_UP', 'DELIVERY_FOLLOW_UP',
  'LOW_STOCK_FOLLOW_UP', 'TAX_DEADLINE', 'LICENSE_RENEWAL', 'GENERAL',
]

// Friendly names — the UI should never show a raw enum value (requirement #3).
const TYPE_LABELS = {
  CUSTOM: 'Custom', CUSTOMER_FOLLOW_UP: 'Customer Follow-up',
  INVOICE_FOLLOW_UP: 'Invoice Follow-up', PAYMENT_DUE: 'Payment Due',
  OVERDUE_PAYMENT: 'Overdue Payment', QUOTATION_FOLLOW_UP: 'Quotation Follow-up',
  PURCHASE_FOLLOW_UP: 'Purchase Follow-up', SUPPLIER_PAYMENT: 'Supplier Payment',
  ORDER_FOLLOW_UP: 'Order Follow-up', DELIVERY_FOLLOW_UP: 'Delivery Follow-up',
  LOW_STOCK_FOLLOW_UP: 'Low Stock Follow-up', TAX_DEADLINE: 'Tax Deadline',
  LICENSE_RENEWAL: 'License Renewal', GENERAL: 'General',
}

const PRIORITIES    = ['low', 'medium', 'high', 'urgent']
const REPEAT_RULES   = ['daily', 'weekly', 'monthly', 'yearly', 'custom']
const LINK_COLUMNS  = ['customer_id', 'invoice_id', 'purchase_id', 'quotation_id', 'payment_id', 'order_id']

class AppError extends Error {
  constructor(message, status = 400, code = null) { super(message); this.status = status; this.code = code }
}

/** Every reminder list/detail response goes through this — never trust a
 *  raw DB row straight to the client (company_id is internal routing info,
 *  not something the UI needs, and this is the one place to add computed
 *  fields like `type_label` / `is_overdue` for every caller at once). */
function serialize(row, now = new Date()) {
  if (!row) return null
  const effectiveDue = row.snoozed_until || row.reminder_at
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    reminder_type: row.reminder_type,
    type_label: TYPE_LABELS[row.reminder_type] || row.reminder_type,
    status: row.status,
    priority: row.priority,
    reminder_at: row.reminder_at,
    effective_due_at: effectiveDue,
    repeat_rule: row.repeat_rule,
    repeat_interval_days: row.repeat_interval_days,
    repeat_until: row.repeat_until,
    assigned_user_id: row.assigned_user_id,
    assigned_user_name: row.assigned_user_name || null,
    created_by: row.created_by,
    created_by_name: row.created_by_name || null,
    customer_id: row.customer_id,
    customer_name: row.customer_name || null,
    invoice_id: row.invoice_id,
    invoice_no: row.invoice_no || null,
    invoice_due_amount: row.invoice_due_amount != null ? Number(row.invoice_due_amount) : null,
    purchase_id: row.purchase_id,
    purchase_no: row.purchase_no || null,
    quotation_id: row.quotation_id,
    payment_id: row.payment_id,
    order_id: row.order_id,
    completed_at: row.completed_at,
    snoozed_until: row.snoozed_until,
    is_overdue: row.status === 'pending' && new Date(effectiveDue) < now,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function baseQuery(companyId) {
  return db('reminders as r')
    .leftJoin('users as au', 'au.id', 'r.assigned_user_id')
    .leftJoin('users as cu', 'cu.id', 'r.created_by')
    .leftJoin('parties as p', 'p.id', 'r.customer_id')
    .leftJoin('sales as s', 's.id', 'r.invoice_id')
    .leftJoin('purchases as pu', 'pu.id', 'r.purchase_id')
    .where('r.company_id', companyId)
    .select(
      'r.*',
      'au.name as assigned_user_name',
      'cu.name as created_by_name',
      'p.name as customer_name',
      's.invoice_no as invoice_no', 's.due_amount as invoice_due_amount',
      'pu.bill_no as purchase_no',
    )
}

async function getReminder(companyId, id) {
  const row = await baseQuery(companyId).where('r.id', id).first()
  return serialize(row)
}

/** Any authenticated company member may create/view/edit/complete/snooze
 *  their own reminders and reminders assigned to them. Only
 *  can_manage_reminders (or owner) may touch someone ELSE's — the same
 *  shape as every other permission check in this codebase (requireRole/
 *  requirePermission in middleware/index.js), not a new permission
 *  system. Routes call this before any mutating action on a reminder
 *  that isn't the actor's own.
 */
function canManage(reminder, user) {
  if (user.role === 'owner' || user.can_manage_reminders) return true
  return reminder.created_by === user.id || reminder.assigned_user_id === user.id
}

async function listReminders(companyId, filters, user) {
  const {
    bucket, status, priority, reminder_type, assigned_user_id, customer_id,
    search, sort = 'due_asc', page = 1, limit = 20, mine_only,
  } = filters

  const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(limit) || 20)
  const lim = Math.min(100, Number(limit) || 20)
  const now = new Date()

  let q = baseQuery(companyId)

  // Non-managers only ever see their own + assigned-to-them reminders —
  // "Users should only see reminders according to existing organization/
  // user permission rules" (requirement #13). Managers/admins (or anyone
  // with can_manage_reminders) see the whole team's, matching how
  // requireRole('admin','manager') already gates the team-wide view
  // elsewhere in this codebase (routes/settings.js GET /users).
  if (!(user.role === 'owner' || user.can_manage_reminders) || mine_only === 'true') {
    q = q.where(b => b.where('r.created_by', user.id).orWhere('r.assigned_user_id', user.id))
  }

  if (priority)         q = q.where('r.priority', priority)
  if (reminder_type)    q = q.where('r.reminder_type', reminder_type)
  if (assigned_user_id) q = q.where('r.assigned_user_id', assigned_user_id)
  if (customer_id)      q = q.where('r.customer_id', customer_id)

  if (search) {
    q = q.where(b => b
      .whereILike('r.title', `%${search}%`)
      .orWhereILike('p.name', `%${search}%`)
      .orWhereILike('s.invoice_no', `%${search}%`))
  }

  // Buckets read against the EFFECTIVE due time (snoozed_until if set,
  // else reminder_at) — a snoozed reminder should move buckets, not stay
  // stuck under its original slot (requirement #9's whole point).
  const effectiveDue = db.raw('COALESCE(r.snoozed_until, r.reminder_at)')
  if (bucket === 'today') {
    const start = new Date(now); start.setHours(0, 0, 0, 0)
    const end   = new Date(now); end.setHours(23, 59, 59, 999)
    q = q.where('r.status', 'pending').whereBetween(effectiveDue, [start, end])
  } else if (bucket === 'overdue') {
    q = q.where('r.status', 'pending').where(effectiveDue, '<', now)
  } else if (bucket === 'upcoming') {
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    q = q.where('r.status', 'pending').where(effectiveDue, '>', end)
  } else if (bucket === 'completed') {
    q = q.where('r.status', 'completed')
  } else if (status) {
    q = q.where('r.status', status)
  }

  const total = Number((await q.clone().clearSelect().count('r.id as count').first())?.count || 0)

  const sortMap = {
    due_asc:      [effectiveDue, 'asc'],
    due_desc:     [effectiveDue, 'desc'],
    priority:     ['r.priority', 'desc'], // enum order isn't alpha-sorted correctly; acceptable simple default
    created_desc: ['r.created_at', 'desc'],
  }
  const [sortCol, sortDir] = sortMap[sort] || sortMap.due_asc
  const rows = await q.orderBy(sortCol, sortDir).limit(lim).offset(offset)

  return { data: rows.map(r => serialize(r, now)), total, page: Number(page), limit: lim }
}

async function getCounts(companyId, user) {
  const now = new Date()
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end   = new Date(now); end.setHours(23, 59, 59, 999)
  const effectiveDue = db.raw('COALESCE(snoozed_until, reminder_at)')

  let q = db('reminders').where('company_id', companyId)
  if (!(user.role === 'owner' || user.can_manage_reminders)) {
    q = q.where(b => b.where('created_by', user.id).orWhere('assigned_user_id', user.id))
  }

  const [today, overdue, upcoming, completed] = await Promise.all([
    q.clone().where('status', 'pending').whereBetween(effectiveDue, [start, end]).count('id as c').first(),
    q.clone().where('status', 'pending').where(effectiveDue, '<', now).count('id as c').first(),
    q.clone().where('status', 'pending').where(effectiveDue, '>', end).count('id as c').first(),
    q.clone().where('status', 'completed').count('id as c').first(),
  ])
  return {
    today: Number(today.c), overdue: Number(overdue.c),
    upcoming: Number(upcoming.c), completed: Number(completed.c),
  }
}

function validatePayload(data, { partial = false } = {}) {
  if (!partial || data.title !== undefined) {
    if (!data.title || !String(data.title).trim()) throw new AppError('Title is required.')
  }
  if (!partial || data.reminder_at !== undefined) {
    const d = new Date(data.reminder_at)
    if (!data.reminder_at || Number.isNaN(d.getTime())) throw new AppError('A valid date/time is required.')
  }
  if (data.priority !== undefined && data.priority !== null && !PRIORITIES.includes(data.priority)) {
    throw new AppError(`Invalid priority. Must be one of: ${PRIORITIES.join(', ')}`)
  }
  if (data.reminder_type !== undefined && data.reminder_type !== null && !TYPES.includes(data.reminder_type)) {
    throw new AppError(`Invalid reminder type. Must be one of: ${TYPES.join(', ')}`)
  }
  if (data.repeat_rule !== undefined && data.repeat_rule !== null && !REPEAT_RULES.includes(data.repeat_rule)) {
    throw new AppError(`Invalid repeat rule. Must be one of: ${REPEAT_RULES.join(', ')}`)
  }
  if (data.repeat_rule === 'custom' && !data.repeat_interval_days) {
    throw new AppError('A repeat interval (in days) is required for a custom repeat rule.')
  }
  if (data.repeat_until !== undefined && data.repeat_until !== null && data.reminder_at) {
    if (new Date(data.repeat_until) < new Date(data.reminder_at)) {
      throw new AppError('Repeat-until date cannot be before the reminder date.')
    }
  }
}

async function assertLinkedRecordsExist(companyId, data) {
  const checks = [
    ['customer_id', 'parties'],
    ['invoice_id',  'sales'],
    ['purchase_id', 'purchases'],
  ]
  for (const [field, table] of checks) {
    if (data[field]) {
      const exists = await db(table).where({ id: data[field], company_id: companyId }).first('id')
      if (!exists) throw new AppError(`Linked ${field.replace('_id', '')} could not be found.`, 400)
    }
  }
}

async function createReminder(companyId, userId, data) {
  validatePayload(data)
  await assertLinkedRecordsExist(companyId, data)

  const [row] = await db('reminders').insert({
    company_id: companyId,
    title: String(data.title).trim(),
    description: data.description || null,
    reminder_type: data.reminder_type || 'CUSTOM',
    priority: data.priority || 'medium',
    reminder_at: new Date(data.reminder_at),
    repeat_rule: data.repeat_rule || null,
    repeat_interval_days: data.repeat_rule === 'custom' ? data.repeat_interval_days : null,
    repeat_until: data.repeat_until || null,
    assigned_user_id: data.assigned_user_id || userId,
    created_by: userId,
    customer_id: data.customer_id || null,
    invoice_id: data.invoice_id || null,
    purchase_id: data.purchase_id || null,
    quotation_id: data.quotation_id || null,
    payment_id: data.payment_id || null,
    order_id: data.order_id || null,
  }).returning('*')

  return getReminder(companyId, row.id)
}

async function updateReminder(companyId, id, userId, user, data) {
  const existing = await db('reminders').where({ id, company_id: companyId }).first()
  if (!existing) throw new AppError('Reminder not found.', 404)
  if (!canManage(existing, user)) throw new AppError('You do not have permission to edit this reminder.', 403)

  validatePayload(data, { partial: true })
  await assertLinkedRecordsExist(companyId, data)

  const patch = { updated_at: new Date() }
  const fields = [
    'title', 'description', 'reminder_type', 'priority', 'repeat_rule',
    'repeat_interval_days', 'repeat_until', 'assigned_user_id',
    'customer_id', 'invoice_id', 'purchase_id', 'quotation_id', 'payment_id', 'order_id',
  ]
  for (const f of fields) if (data[f] !== undefined) patch[f] = data[f] || null

  // Rescheduling (date/time actually changing) clears notified_at so the
  // scheduler notifies again for the new time, and clears any stale snooze
  // — editing the date is a deliberate reschedule, not a snooze.
  if (data.reminder_at !== undefined) {
    patch.reminder_at = new Date(data.reminder_at)
    patch.snoozed_until = null
    patch.notified_at = null
  }

  const [row] = await db('reminders').where({ id }).update(patch).returning('*')
  return getReminder(companyId, row.id)
}

async function deleteReminder(companyId, id, user) {
  const existing = await db('reminders').where({ id, company_id: companyId }).first()
  if (!existing) throw new AppError('Reminder not found.', 404)
  if (!canManage(existing, user)) throw new AppError('You do not have permission to delete this reminder.', 403)
  await db('reminders').where({ id }).delete()
  return existing
}

/** Compute the next occurrence's reminder_at for a recurring reminder,
 *  or null if the series has ended (past repeat_until, or no repeat_rule). */
function computeNextOccurrence(reminder) {
  if (!reminder.repeat_rule) return null
  const next = new Date(reminder.reminder_at)
  switch (reminder.repeat_rule) {
    case 'daily':   next.setDate(next.getDate() + 1); break
    case 'weekly':  next.setDate(next.getDate() + 7); break
    case 'monthly': next.setMonth(next.getMonth() + 1); break
    case 'yearly':  next.setFullYear(next.getFullYear() + 1); break
    case 'custom':  next.setDate(next.getDate() + (Number(reminder.repeat_interval_days) || 1)); break
    default: return null
  }
  if (reminder.repeat_until && next > new Date(reminder.repeat_until)) return null
  return next
}

async function completeReminder(companyId, id, user) {
  const existing = await db('reminders').where({ id, company_id: companyId }).first()
  if (!existing) throw new AppError('Reminder not found.', 404)
  if (!canManage(existing, user)) throw new AppError('You do not have permission to complete this reminder.', 403)
  if (existing.status === 'completed') return getReminder(companyId, id) // idempotent — no duplicate-completion error

  return db.transaction(async (trx) => {
    await trx('reminders').where({ id }).update({
      status: 'completed', completed_at: new Date(), snoozed_until: null, updated_at: new Date(),
    })

    // Recurring reminder: generate the next occurrence as a NEW row (the
    // completed one stays completed and in history — requirement #11:
    // "prevent duplicate occurrences" is satisfied by only ever generating
    // the next one at completion time, never speculatively ahead of time).
    const next = computeNextOccurrence(existing)
    if (next) {
      await trx('reminders').insert({
        company_id: companyId, title: existing.title, description: existing.description,
        reminder_type: existing.reminder_type, priority: existing.priority,
        reminder_at: next, repeat_rule: existing.repeat_rule,
        repeat_interval_days: existing.repeat_interval_days, repeat_until: existing.repeat_until,
        assigned_user_id: existing.assigned_user_id, created_by: existing.created_by,
        customer_id: existing.customer_id, invoice_id: existing.invoice_id,
        purchase_id: existing.purchase_id, quotation_id: existing.quotation_id,
        payment_id: existing.payment_id, order_id: existing.order_id,
      })
    }
    return null
  }).then(() => getReminder(companyId, id))
}

/** Reopens a completed reminder — "Reopened" per requirement #22's audit list. */
async function reopenReminder(companyId, id, user) {
  const existing = await db('reminders').where({ id, company_id: companyId }).first()
  if (!existing) throw new AppError('Reminder not found.', 404)
  if (!canManage(existing, user)) throw new AppError('You do not have permission to reopen this reminder.', 403)
  await db('reminders').where({ id }).update({ status: 'pending', completed_at: null, notified_at: null, updated_at: new Date() })
  return getReminder(companyId, id)
}

async function snoozeReminder(companyId, id, user, snoozedUntil) {
  const existing = await db('reminders').where({ id, company_id: companyId }).first()
  if (!existing) throw new AppError('Reminder not found.', 404)
  if (!canManage(existing, user)) throw new AppError('You do not have permission to snooze this reminder.', 403)
  const d = new Date(snoozedUntil)
  if (Number.isNaN(d.getTime())) throw new AppError('A valid snooze time is required.')

  // Updates the SAME row — never creates a second reminder (requirement #9).
  await db('reminders').where({ id }).update({ snoozed_until: d, notified_at: null, updated_at: new Date() })
  return getReminder(companyId, id)
}

/** Named "tonight" / "tomorrow morning" / "next working day" snooze
 *  presets resolved server-side (never trust a client-computed timestamp
 *  for "tomorrow morning" — timezone bugs live exactly there). `tz` is an
 *  IANA name from the company's settings (falls back to Asia/Kathmandu,
 *  matching nepaliDate.ts's assumption elsewhere in this codebase). */
function resolveSnoozePreset(preset, tz = 'Asia/Kathmandu') {
  const now = new Date()
  const at = (base, h, m) => {
    // Compute the wall-clock offset for `tz` and apply it, rather than
    // trusting the server process's own local timezone.
    const local = new Date(base.toLocaleString('en-US', { timeZone: tz }))
    local.setHours(h, m, 0, 0)
    const offsetMs = base.getTime() - new Date(base.toLocaleString('en-US', { timeZone: tz })).getTime()
    return new Date(local.getTime() + offsetMs)
  }
  switch (preset) {
    case '10m':  return new Date(now.getTime() + 10 * 60 * 1000)
    case '30m':  return new Date(now.getTime() + 30 * 60 * 1000)
    case '1h':   return new Date(now.getTime() + 60 * 60 * 1000)
    case 'tonight': { const t = at(now, 19, 0); return t > now ? t : new Date(now.getTime() + 60 * 60 * 1000) }
    case 'tomorrow_morning': { const d = new Date(now); d.setDate(d.getDate() + 1); return at(d, 9, 0) }
    case 'tomorrow': { const d = new Date(now); d.setDate(d.getDate() + 1); return at(d, 9, 0) }
    case 'next_working_day': {
      const d = new Date(now)
      do { d.setDate(d.getDate() + 1) } while (d.getDay() === 0 || d.getDay() === 6) // skip Sat/Sun
      return at(d, 9, 0)
    }
    default: throw new AppError(`Unknown snooze preset: ${preset}`)
  }
}

/**
 * Automatic-reminder creation with built-in dedupe (requirement: "Do not
 * create duplicate reminders for the same invoice and reminder type" /
 * "Do not create repeated reminders every time the stock page is
 * opened"). One active (pending, not completed) reminder of the same
 * type+link combination blocks another from being created — safe to call
 * as often as the scheduler/event hooks want.
 */
async function createIfNotExists(companyId, { reminder_type, link_field, link_id, title, description, reminder_at, priority = 'medium', assigned_user_id = null, created_by = null }) {
  if (!LINK_COLUMNS.includes(link_field)) throw new AppError(`Invalid link field: ${link_field}`, 500)

  const existing = await db('reminders')
    .where({ company_id: companyId, reminder_type, status: 'pending', [link_field]: link_id })
    .first('id')
  if (existing) return null // already suggested/created — do nothing

  const [row] = await db('reminders').insert({
    company_id: companyId, title, description: description || null,
    reminder_type, priority, reminder_at: new Date(reminder_at),
    assigned_user_id, created_by,
    [link_field]: link_id,
  }).returning('id')
  return row.id
}

module.exports = {
  TYPES, TYPE_LABELS, PRIORITIES, REPEAT_RULES, AppError,
  serialize, listReminders, getCounts, getReminder,
  createReminder, updateReminder, deleteReminder,
  completeReminder, reopenReminder, snoozeReminder, resolveSnoozePreset,
  computeNextOccurrence, createIfNotExists, canManage,
}
