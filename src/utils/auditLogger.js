const { hashAuditEntry, getLastAuditHash } = require('./hashing')

/**
 * AuditLogger — forensic-grade append-only audit system with hash chaining.
 *
 * Usage:
 *   await AuditLogger.log(trx, {
 *     companyId, userId, action: 'POST_VOUCHER',
 *     entityType: 'voucher', entityId: voucherId,
 *     payloadBefore: null, payloadAfter: voucher,
 *     ipAddress: req.ip,
 *   })
 */
class AuditLogger {
  static async log(db, {
    companyId,
    userId,
    action,
    entityType,
    entityId,
    voucherNo,
    payloadBefore,
    payloadAfter,
    ipAddress,
    userAgent,
    sessionId,
    isSuspicious = false,
  }) {
    try {
      // Get last hash for chain (advisory lock ensures order)
      const prevHash = await getLastAuditHash(db, companyId)

      const entryHash = hashAuditEntry({
        company_id:   companyId,
        user_id:      userId,
        action,
        entity_type:  entityType,
        entity_id:    entityId,
        payload_after: payloadAfter,
        prev_hash:    prevHash,
      })

      await db('audit_log').insert({
        company_id:    companyId,
        user_id:       userId,
        action,
        entity_type:   entityType   || null,
        entity_id:     entityId     || null,
        voucher_no:    voucherNo    || null,
        payload_before: payloadBefore ? JSON.stringify(payloadBefore) : null,
        payload_after:  payloadAfter  ? JSON.stringify(payloadAfter)  : null,
        ip_address:    ipAddress    || null,
        user_agent:    userAgent    || null,
        session_id:    sessionId    || null,
        is_suspicious: isSuspicious,
        entry_hash:    entryHash,
        prev_hash:     prevHash,
      })
    } catch (err) {
      // Audit log failure should never crash the main operation
      // but must be reported
      console.error('[AUDIT] Failed to write audit log:', err.message, { action, entityId })
    }
  }

  /**
   * Like log(), but NEVER swallows a failure and is meant to be called with a
   * transaction. Use it when the audit row is part of the business operation
   * itself (e.g. editing a posted voucher): if the audit entry cannot be
   * written, the whole operation must roll back rather than succeed silently
   * without its audit trail. (log() catches its own errors; inside a Postgres
   * transaction that would leave the transaction aborted while the caller
   * carries on as if nothing happened.)
   *
   * created_at uses clock_timestamp() so several audit rows written inside
   * ONE transaction still get distinct, ordered timestamps (now() is frozen
   * at transaction start), keeping the audit hash chain unambiguous.
   */
  static async logStrict(db, {
    companyId, userId, action, entityType, entityId, voucherNo,
    payloadBefore, payloadAfter, ipAddress, userAgent, sessionId, isSuspicious = false,
  }) {
    const prevHash = await getLastAuditHash(db, companyId)
    const entryHash = hashAuditEntry({
      company_id: companyId, user_id: userId, action,
      entity_type: entityType, entity_id: entityId,
      payload_after: payloadAfter, prev_hash: prevHash,
    })
    await db('audit_log').insert({
      company_id:    companyId,
      user_id:       userId,
      action,
      entity_type:   entityType || null,
      entity_id:     entityId   || null,
      voucher_no:    voucherNo  || null,
      payload_before: payloadBefore ? JSON.stringify(payloadBefore) : null,
      payload_after:  payloadAfter  ? JSON.stringify(payloadAfter)  : null,
      ip_address:    ipAddress  || null,
      user_agent:    userAgent  || null,
      session_id:    sessionId  || null,
      is_suspicious: isSuspicious,
      entry_hash:    entryHash,
      prev_hash:     prevHash,
      created_at:    db.raw('clock_timestamp()'),
    })
  }

  static async query(db, companyId, { action, entityType, entityId, userId, limit = 100, offset = 0 } = {}) {
    let q = db('audit_log as a')
      .leftJoin('users as u', 'a.user_id', 'u.id')
      .where('a.company_id', companyId)
      .select('a.*', 'u.name as user_name', 'u.email as user_email')

    if (action)     q = q.where('a.action', action)
    if (entityType) q = q.where('a.entity_type', entityType)
    if (entityId)   q = q.where('a.entity_id', entityId)
    if (userId)     q = q.where('a.user_id', userId)

    return q.orderBy('a.created_at', 'desc').limit(limit).offset(offset)
  }
}

module.exports = AuditLogger
