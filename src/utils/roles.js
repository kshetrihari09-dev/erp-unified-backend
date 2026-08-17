/**
 * roles.js — single authoritative definition of user roles + role
 * validation/authorization rules.
 *
 * IMPORTANT: this list must exactly match the Postgres enum on
 * users.role (see migrations/001_foundation.js:
 *   t.enum('role', ['owner','admin','accountant','cashier','auditor','viewer'])
 * ). There is no 'manager' role in this codebase's data model — some
 * routes pass requireRole('admin','manager') defensively, which is
 * harmless (manager can never actually be assigned) but should not be
 * read as evidence that 'manager' is a real, assignable role.
 */
const USER_ROLES = ['owner', 'admin', 'accountant', 'cashier', 'auditor', 'viewer']

// Every role except 'owner' — 'owner' is a protected system role that
// cannot be granted through normal user-management endpoints (see
// validateRole's allowOwner option below).
const ASSIGNABLE_ROLES = USER_ROLES.filter(r => r !== 'owner')

/**
 * Is `role` a syntactically/semantically valid role value?
 * (Whether the ACTOR is allowed to assign it is a separate question —
 * see canAssignRole below. Never conflate the two.)
 */
function validateRole(role, { allowOwner = false, required = false } = {}) {
  if (role === undefined || role === null) {
    if (required) return { valid: false, code: 'ROLE_REQUIRED', message: 'Role is required.' }
    return { valid: true }
  }
  if (typeof role !== 'string') {
    return { valid: false, code: 'INVALID_ROLE', message: 'Role must be a string.' }
  }
  if (!USER_ROLES.includes(role)) {
    return { valid: false, code: 'INVALID_ROLE', message: `Invalid role. Must be one of: ${USER_ROLES.join(', ')}` }
  }
  if (role === 'owner' && !allowOwner) {
    return { valid: false, code: 'OWNER_ROLE_NOT_ASSIGNABLE', message: 'The owner role cannot be assigned through this endpoint.' }
  }
  return { valid: true, role }
}

/**
 * Can `actorRole` assign/change a user's role to `targetRole`?
 * Business rules (see PRIMARY OBJECTIVE / section 10-11 of the audit):
 *   - only 'owner' may ever assign or remove the 'owner' role
 *   - a non-owner can never modify a user who is currently 'owner'
 *   - a user can never change their own role (self-escalation guard) —
 *     callers should check this separately since it needs the actor's
 *     own id, not just their role
 *   - owner can assign any role
 *   - admin can assign any non-owner role, but cannot touch an owner
 */
function canAssignRole({ actorRole, targetCurrentRole, newRole }) {
  if (actorRole === 'owner') return { ok: true }

  if (targetCurrentRole === 'owner') {
    return { ok: false, code: 'TARGET_ROLE_PROTECTED', message: 'The owner account cannot be modified.' }
  }
  if (newRole === 'owner') {
    return { ok: false, code: 'OWNER_ROLE_NOT_ASSIGNABLE', message: 'Only the owner can grant the owner role.' }
  }
  if (actorRole === 'admin') return { ok: true }

  // Every other role has no user-management privileges at all — routes
  // should already be gated by requireRole('admin') before reaching
  // here, but fail closed just in case this is ever called elsewhere.
  return { ok: false, code: 'ROLE_FORBIDDEN', message: 'You do not have permission to manage user roles.' }
}

module.exports = { USER_ROLES, ASSIGNABLE_ROLES, validateRole, canAssignRole }
