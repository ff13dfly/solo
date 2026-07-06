/**
 * User Service Capability Registry (Introspection)
 *
 * @why Defines the "Surface Area" of the service. The Router fetches this
 *      during handshake to populate the global method map.
 * @attention
 *   1. `ai: true` flags indicate methods exposed for autonomous AI invocation.
 *   2. `public: true` allows the Router to bypass strict permission checks (e.g., for login).
 *
 * --- RETURN CONTRACT VOCABULARY (returns_schema) ---
 *
 * `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
 * `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
 * same rule-items as `params`) — what the return-contract test asserts and what
 * orchestration/AI binds against. Each item is { name, type?, required? }; `required:true`
 * ONLY for keys present (and non-null) on EVERY non-throwing code path. Nullable/conditional
 * keys carry a `type` but are NOT required. Derived from, and verified against, the actual
 * handlers in ../logic/*.js + the shaping in ../index.js — the handler is the source of truth.
 *
 * The legacy `returns` arrays were largely ASPIRATIONAL (declared fields the code never
 * emits). They have been corrected to be a strict subset of returns_schema (the repo
 * well-formedness sweep enforces returns ⊆ returns_schema — no drift). Where the code itself
 * is wrong (a declared-but-never-computed field, a non-uniform sibling shape, a bare-array
 * provider) the DECLARATION is made honest about today's behaviour and the bug is recorded in
 * the contract audit, NOT silently "declared away".
 */

// --- USER PROFILE RETURN (user.profile = getProfile) ---
// getProfile returns the stored user record minus salt/hash, with `id` re-stamped. The
// always-written-at-register keys are required; role/last/deletedAt appear only after
// role.assign / login / soft-delete and are therefore conditional. NOTE: there is NO
// `username` field — the login handle is stored as `name` (the legacy returns lied).
const USER_PROFILE_RETURN = [
    { name: 'id',        type: 'string',  required: true },
    { name: 'name',      type: 'string',  required: true },   // the login handle (NOT `username`)
    { name: 'email',     type: 'string'  },                   // '' when unset (a required-string rule forbids blank)
    { name: 'phone',     type: 'string'  },                   // '' when unset
    { name: 'lang',      type: 'string',  required: true },
    { name: 'way',       type: 'number',  required: true },
    { name: 'permit',    type: 'object',  required: true },
    { name: 'devices',   type: 'object',  required: true },
    { name: 'status',    type: 'string',  required: true },   // ACTIVE | DELETED
    { name: 'categories',type: 'object',  required: true },
    { name: 'meta',      type: 'object',  required: true },
    { name: 'createdAt', type: 'string',  required: true },   // ISO string
    { name: 'updatedAt', type: 'string',  required: true },   // ISO string
    { name: 'role',      type: 'string'  },                   // only after role.assign/login
    { name: 'last',      type: 'string'  },                   // only after a login
    { name: 'deletedAt', type: 'string'  },                   // only after soft-delete
];

// --- CATEGORY RETURN (library/category create|update|get all return the stored doc) ---
const CATEGORY_RETURN = [
    { name: 'key',       type: 'string',  required: true },
    { name: 'type',      type: 'string',  required: true },   // LIST | TREE
    { name: 'scope',     type: 'string',  required: true },   // LOCAL | GLOBAL
    { name: 'desc',      type: 'string'  },                   // defaults to '' (a required-string rule forbids blank)
    { name: 'meta',      type: 'object',  required: true },
    { name: 'items',     type: 'array',   required: true },
    { name: 'status',    type: 'string',  required: true },   // ACTIVE | DELETED
    { name: 'createdAt', type: 'number',  required: true },   // Date.now() ms
    { name: 'updatedAt', type: 'number',  required: true },
];

// --- CATEGORY ITEM RETURN (addItem returns the freshly-built item) ---
const CATEGORY_ITEM_RETURN = [
    { name: 'id',        type: 'string',  required: true },
    { name: 'label',     type: 'object',  required: true },   // { zh, en } (or {})
    { name: 'desc',      type: 'string'  },                   // defaults to '' (a required-string rule forbids blank)
    { name: 'parentId',  type: 'string'  },                   // null by default → not required
    { name: 'meta',      type: 'object'  },                   // null by default → not required
    { name: 'createdAt', type: 'number',  required: true },
    { name: 'updatedAt', type: 'number'  },                   // only present after an update
];

// --- BOT RETURN (bot.get returns the stored bot record) ---
const BOT_RETURN = [
    { name: 'id',        type: 'string',  required: true },
    { name: 'name',      type: 'string',  required: true },
    { name: 'type',      type: 'string',  required: true },   // 'bot'
    { name: 'hash',      type: 'string'  },                   // always null for bots → not required
    { name: 'permit',    type: 'object',  required: true },
    { name: 'desc',      type: 'string'  },                   // defaults to '' (a required-string rule forbids blank)
    { name: 'createdAt', type: 'string',  required: true },   // ISO string
    { name: 'status',    type: 'string',  required: true },   // ACTIVE | SUSPENDED
    { name: 'updatedAt', type: 'string'  },                   // only after an update/suspend/resume
];

// --- ROLE RETURN (role.get returns the stored role doc) ---
const ROLE_RETURN = [
    { name: 'id',          type: 'string', required: true },  // the role name
    { name: 'scope',       type: 'string', required: true },  // internal | external | both
    { name: 'name',        type: 'string', required: true },
    { name: 'services',    type: 'object', required: true },
    { name: 'constraints', type: 'object', required: true },
    { name: 'createdAt',   type: 'string', required: true },
    { name: 'updatedAt',   type: 'string', required: true },
];

// --- PASSPORT RETURN (passport.get returns the entity + its device ids) ---
const PASSPORT_RETURN = [
    { name: 'id',        type: 'string',  required: true },   // the anchor
    { name: 'role',      type: 'string',  required: true },
    { name: 'app',       type: 'string'  },                   // null when unset → not required
    { name: 'name',      type: 'string',  required: true },
    { name: 'meta',      type: 'object',  required: true },
    { name: 'status',    type: 'string',  required: true },   // ACTIVE | DISABLED
    { name: 'createdAt', type: 'string',  required: true },
    { name: 'updatedAt', type: 'string',  required: true },
    { name: 'devices',   type: 'array',   required: true },   // device ids only (no secrets)
];

// --- REGISTERED RPC METHODS ---

module.exports = [
    // 0 Dots
    { name: 'ping', params: [], returns: ['status', 'uptime'], description: 'Check service health', ai: false },

    // 1 Dot
    // register actually returns { success, uid } — NOT the [id,email,name,username,status] the legacy decl claimed.
    { name: 'user.register', params: [{ name: 'name', type: 'string', required: true, maxLength: 128 }, { name: 'email', type: 'string', maxLength: 254, pattern: 'email' }, { name: 'phone', type: 'string', maxLength: 32, pattern: 'phone' }], returns: ['success', 'uid'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'uid', type: 'string', required: true }], description: 'Register new user', ai: true, public: true },
    { name: 'user.login.request', params: [{ name: 'name', type: 'string', required: true, maxLength: 128 }], returns: ['challenge', 'salt', 'iterations'], returns_schema: [{ name: 'challenge', type: 'string', required: true }, { name: 'salt', type: 'string', required: true }, { name: 'iterations', type: 'number', required: true }], description: 'Step 1 of login: get challenge', ai: false, public: true },
    { name: 'user.login.verify', params: [{ name: 'name', type: 'string', required: true, maxLength: 128 }, { name: 'challenge', type: 'string', maxLength: 512 }, { name: 'response', type: 'string', maxLength: 512 }, { name: 'deviceId', type: 'string', maxLength: 64, pattern: 'id' }], returns: ['success', 'token', 'uid', 'permit', 'categories'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'token', type: 'string', required: true }, { name: 'uid', type: 'string', required: true }, { name: 'permit', type: 'object', required: true }, { name: 'categories', type: 'object', desc: 'tier axis (categories.POWER gates portal access) — surfaced at auth so the caller can read its OWN tier without a permit-gated user.profile call' }], description: 'Step 2: verify and get token', ai: false, public: true },
    { name: 'user.profile', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'email', 'name', 'role', 'status', 'categories', 'createdAt'], returns_schema: USER_PROFILE_RETURN, description: 'Get user profile (permit-gated: reading a profile requires an explicit grant; own tier is surfaced by user.login.verify instead)', ai: true, public: false },
    // stats() returns { active, total } — `deleted` is NEVER computed (legacy decl lied; see contract audit).
    { name: 'user.account.status', params: [], returns: ['total', 'active'], returns_schema: [{ name: 'active', type: 'number', required: true }, { name: 'total', type: 'number', required: true }], description: 'Get user statistics', ai: true },
    // list() returns records under `users`, NOT `items` (legacy decl lied).
    { name: 'user.account.list', params: [{ name: 'includeDeleted', type: 'boolean' }], returns: ['users', 'total', 'page', 'pageSize'], returns_schema: [{ name: 'users', type: 'array', required: true }, { name: 'total', type: 'number', required: true }, { name: 'page', type: 'number', required: true }, { name: 'pageSize', type: 'number', required: true }], description: 'List users (Admin only)', ai: true },
    { name: 'user.account.update', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'categories', type: 'object' }, { name: 'lang', type: 'string', maxLength: 64 }, { name: 'email', type: 'string', maxLength: 254, pattern: 'email' }, { name: 'phone', type: 'string', maxLength: 32, pattern: 'phone' }, { name: 'meta', type: 'object' }], returns: ['success', 'uid'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'uid', type: 'string', required: true }, { name: 'categories', type: 'object' }, { name: 'meta', type: 'object' }], description: 'Update user profile (categories, lang, email/phone contact, meta — meta is shallow-merged)', ai: true },
    // remove returns { success, id } normally, or { success, message } on the already-deleted early-return → only `success` is universal.
    { name: 'user.account.remove', params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['success'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'id', type: 'string' }, { name: 'message', type: 'string' }], description: 'Soft delete user (Admin only)', ai: false },
    // restore returns { success } (already-active early-return) or { success, id } → only `success` is universal.
    { name: 'user.account.restore', params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['success'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'id', type: 'string' }], description: 'Restore deleted user (Admin only)', ai: false },
    { name: 'user.account.check', params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['canDestroy'], returns_schema: [{ name: 'canDestroy', type: 'boolean', required: true }], description: 'Check if user can be permanently deleted', ai: false },
    { name: 'user.account.destroy', params: [{ name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['success', 'id'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'id', type: 'string', required: true }], description: 'Permanently delete user', ai: false },

    // 2 Dots
    { name: 'user.permit.update', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'permit', type: 'object' }], returns: ['success', 'uid'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'uid', type: 'string', required: true }], description: 'Update user permissions (Admin only)', ai: true },
    { name: 'user.permit.get', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['uid', 'permit'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'permit', type: 'object', required: true }], description: 'Get user permissions (Admin only)', ai: true },
    { name: 'user.permit.batch', params: [{ name: 'permits', type: 'array' }], returns: ['results'], returns_schema: [{ name: 'results', type: 'array', required: true }], description: 'Batch update permissions (Admin only)', ai: true },
    // category.create/delete reserve/delete in the Router first (outbound RPC) — return shapes are static-derived.
    { name: 'user.category.create', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }], returns: ['key', 'type', 'scope', 'status'], returns_schema: CATEGORY_RETURN, description: 'Create category', ai: true },
    { name: 'user.category.update', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }], returns: ['key', 'type', 'scope', 'status'], returns_schema: CATEGORY_RETURN, description: 'Update category metadata', ai: true },
    { name: 'user.category.delete', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }], returns: ['success'], returns_schema: [{ name: 'success', type: 'boolean', required: true }], description: 'Delete category', ai: true },
    // category.list returns a BARE top-level array — NOT { items, total }. The flat object-key
    // dialect cannot express a top-level array, so NO returns_schema is declared (see contract audit).
    { name: 'user.category.list', params: [], description: 'List categories', ai: true },
    { name: 'user.category.get', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }], returns: ['key', 'type', 'scope', 'items', 'status'], returns_schema: CATEGORY_RETURN, description: 'Get category details', ai: true },

    // 3 Dots
    { name: 'user.category.item.add', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }, { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'label', type: 'string', maxLength: 128 }], returns: ['id', 'label', 'createdAt'], returns_schema: CATEGORY_ITEM_RETURN, description: 'Add item to category', ai: true },
    // getItem reads the whole category and returns the single matching item (same shape as item.add).
    { name: 'user.category.item.get', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }, { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'label', 'createdAt'], returns_schema: CATEGORY_ITEM_RETURN, description: 'Get a single category item', ai: true },
    // updateItem returns the (possibly legacy-shaped) stored item — only `id` is guaranteed present.
    { name: 'user.category.item.update', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }, { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id'], returns_schema: [{ name: 'id', type: 'string', required: true }, { name: 'label', type: 'object' }, { name: 'desc', type: 'string' }, { name: 'parentId', type: 'string' }, { name: 'meta', type: 'object' }, { name: 'createdAt', type: 'number' }, { name: 'updatedAt', type: 'number' }], description: 'Update category item', ai: true },
    { name: 'user.category.item.remove', params: [{ name: 'key', type: 'string', required: true, maxLength: 64 }, { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['success'], returns_schema: [{ name: 'success', type: 'boolean', required: true }], description: 'Remove item from category', ai: true },

    // Bot Account Management (admin only, ai: false — not exposed to AI/capability discovery)
    { name: 'user.bot.create', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'permit', type: 'object' }, { name: 'desc', type: 'string', maxLength: 4000 }], returns: ['id'], returns_schema: [{ name: 'id', type: 'string', required: true }], description: 'Create a passwordless bot account (admin)', ai: false },
    { name: 'user.bot.list', params: [], returns: ['items'], returns_schema: [{ name: 'items', type: 'array', required: true }], description: 'List all bot accounts (admin)', ai: false },
    { name: 'user.bot.get', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'permit', 'desc', 'createdAt', 'status'], returns_schema: BOT_RETURN, description: 'Get bot account details (admin)', ai: false },
    { name: 'user.bot.update', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'permit', type: 'object' }, { name: 'desc', type: 'string', maxLength: 4000 }], returns: ['id'], returns_schema: [{ name: 'id', type: 'string', required: true }], description: 'Update bot account permit or description (admin)', ai: false },
    { name: 'user.bot.delete', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id'], returns_schema: [{ name: 'id', type: 'string', required: true }], description: 'Delete a bot account (admin)', ai: false },
    { name: 'user.bot.issue.token', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['token', 'expiresAt'], returns_schema: [{ name: 'token', type: 'string', required: true }, { name: 'expiresAt', type: 'number', required: true }], description: 'Issue a session token for a bot account (admin)', ai: false },
    { name: 'user.bot.suspend', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'status', 'revoked'], returns_schema: [{ name: 'id', type: 'string', required: true }, { name: 'status', type: 'string', required: true }, { name: 'revoked', type: 'number', required: true }], description: 'Reversibly suspend a bot: blocks refresh/issue, kills live sessions (admin)', ai: false },
    // resume returns { id, status } on both the no-op early-return and the normal path — no `revoked`.
    { name: 'user.bot.resume', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['id', 'status'], returns_schema: [{ name: 'id', type: 'string', required: true }, { name: 'status', type: 'string', required: true }], description: 'Resume a suspended bot to ACTIVE; re-issue token to bring it back online (admin)', ai: false },
    { name: 'user.token.refresh', params: [], returns: ['token', 'expiresAt'], returns_schema: [{ name: 'token', type: 'string', required: true }, { name: 'expiresAt', type: 'number', required: true }], description: 'Refresh caller\'s own bot session token (bot accounts only)', ai: false },
    { name: 'user.token.revoke', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['uid', 'revoked'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'revoked', type: 'number', required: true }], description: 'Revoke all live session tokens of a uid (admin)', ai: false },

    // Roles (authority.md) — named permit templates for internal users + external passports (ai: false)
    // set returns the COMPACT { role, scope } (NOT the full role doc) — distinct from get below.
    { name: 'user.role.set', params: [{ name: 'role', type: 'string', required: true, maxLength: 64 }, { name: 'services', type: 'object' }, { name: 'ownerField', type: 'string', maxLength: 64 }, { name: 'constraints', type: 'object' }, { name: 'scope', type: 'string', maxLength: 64 }, { name: 'name', type: 'string', maxLength: 128 }], returns: ['role', 'scope'], returns_schema: [{ name: 'role', type: 'string', required: true }, { name: 'scope', type: 'string', required: true }], description: 'Define/update a role (named permit template) (permit-gated)', ai: false },
    { name: 'user.role.list', params: [], returns: ['items'], returns_schema: [{ name: 'items', type: 'array', required: true }], description: 'List roles (permit-gated)', ai: false },
    { name: 'user.role.get', params: [{ name: 'role', type: 'string', required: true, maxLength: 64 }], returns: ['id', 'scope', 'services', 'constraints'], returns_schema: ROLE_RETURN, description: 'Get a role (permit-gated)', ai: false },
    { name: 'user.role.assign', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'role', type: 'string', required: true, maxLength: 64 }], returns: ['uid', 'role'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'role', type: 'string', required: true }], description: "Materialize a role's permit onto an internal user (permit-gated)", ai: false },

    // External principals (passport) — manageable entity + auth bridge (authority.md, ai: false)
    { name: 'user.passport.register', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 64 }, { name: 'role', type: 'string', maxLength: 64 }, { name: 'app', type: 'string', maxLength: 64 }, { name: 'deviceId', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'deviceToken', type: 'string', maxLength: 512 }, { name: 'name', type: 'string', maxLength: 128 }, { name: 'meta', type: 'object' }], returns: ['anchor', 'role', 'deviceId', 'status'], returns_schema: [{ name: 'anchor', type: 'string', required: true }, { name: 'role', type: 'string', required: true }, { name: 'app', type: 'string' }, { name: 'deviceId', type: 'string', required: true }, { name: 'status', type: 'string', required: true }], description: 'Onboard/update an external principal (binds role, optional app) + register a device (permit-gated)', ai: false },
    { name: 'user.passport.list', params: [{ name: 'app', type: 'string', maxLength: 64 }], returns: ['items'], returns_schema: [{ name: 'items', type: 'array', required: true }], description: 'List external principals (optionally by app) (permit-gated)', ai: false },
    { name: 'user.passport.get', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 64 }], returns: ['id', 'role', 'status', 'devices'], returns_schema: PASSPORT_RETURN, description: 'Get an external principal + its device ids (permit-gated)', ai: false },
    { name: 'user.passport.disable', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 64 }], returns: ['anchor', 'status', 'revoked'], returns_schema: [{ name: 'anchor', type: 'string', required: true }, { name: 'status', type: 'string', required: true }, { name: 'revoked', type: 'number', required: true }], description: 'Disable an external principal + revoke its live sessions (permit-gated)', ai: false },
    { name: 'user.passport.verify', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 64 }, { name: 'deviceId', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'deviceToken', type: 'string', maxLength: 512 }], returns: ['token', 'expiresAt', 'anchor', 'role'], returns_schema: [{ name: 'token', type: 'string', required: true }, { name: 'expiresAt', type: 'number', required: true }, { name: 'anchor', type: 'string', required: true }, { name: 'role', type: 'string', required: true }], description: 'External user authenticates with a device token; role read from the entity, returns a restricted session', ai: false, public: true },
    // Self-service issuance (spec-passport-self-issuance.md §4) — PUBLIC, fail-closed via config.passport.issuance.
    { name: 'user.passport.otp.request', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 128 }, { name: 'channel', type: 'string', required: true, maxLength: 16 }, { name: 'app', type: 'string', maxLength: 64 }], returns: ['status'], returns_schema: [{ name: 'status', type: 'string', required: true }, { name: 'devCode', type: 'string' }], description: 'Self-service: request an OTP proving anchor ownership (email/sms via gateway); anti-enumeration uniform response; gated by config.passport.issuance', ai: false, public: true },
    { name: 'user.passport.otp.verify', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 128 }, { name: 'otp', type: 'string', required: true, maxLength: 16 }, { name: 'channel', type: 'string', maxLength: 16 }, { name: 'app', type: 'string', maxLength: 64 }, { name: 'name', type: 'string', maxLength: 128 }, { name: 'meta', type: 'object' }], returns: ['anchor'], returns_schema: [{ name: 'anchor', type: 'string', required: true }, { name: 'deviceToken', type: 'string' }, { name: 'deviceId', type: 'string' }, { name: 'role', type: 'string' }, { name: 'status', type: 'string' }], description: 'Self-service: verify OTP → issue device token (otp mode) or land PENDING (pending mode); role = config defaultRole, never client-supplied', ai: false, public: true },
    { name: 'user.passport.device.issue', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 128 }, { name: 'app', type: 'string', maxLength: 64 }, { name: 'name', type: 'string', maxLength: 128 }, { name: 'meta', type: 'object' }], returns: ['deviceToken', 'deviceId', 'anchor'], returns_schema: [{ name: 'deviceToken', type: 'string', required: true }, { name: 'deviceId', type: 'string', required: true }, { name: 'anchor', type: 'string', required: true }, { name: 'role', type: 'string' }, { name: 'bot', type: 'string' }], description: 'Identity-line: device-anchor TOFU issuance (no OTP); routes to the app default bot/role; gated by config.passport.issuance=device', ai: false, public: true },
    { name: 'user.passport.upgrade', params: [{ name: 'anchor', type: 'string', required: true, maxLength: 128 }, { name: 'deviceId', type: 'string', required: true, maxLength: 64, pattern: 'id' }, { name: 'deviceToken', type: 'string', required: true, maxLength: 512 }, { name: 'newAnchor', type: 'string', required: true, maxLength: 128 }, { name: 'otp', type: 'string', required: true, maxLength: 16 }, { name: 'channel', type: 'string', maxLength: 16 }, { name: 'name', type: 'string', maxLength: 128 }, { name: 'meta', type: 'object' }], returns: ['anchor', 'deviceToken', 'deviceId'], returns_schema: [{ name: 'anchor', type: 'string', required: true }, { name: 'deviceToken', type: 'string', required: true }, { name: 'deviceId', type: 'string', required: true }, { name: 'role', type: 'string' }, { name: 'bot', type: 'string' }, { name: 'upgradedFrom', type: 'string' }], description: 'Identity-line: upgrade a device-anchor passport to an email/phone anchor (carries role/bot/meta); needs device proof AND newAnchor OTP', ai: false, public: true },

    // Signing keys (VERSION.md §3.2) — approval sign-off. generate/sign self-only; password never stored.
    // generate also returns `createdAt` (the legacy decl omitted it).
    { name: 'user.key.generate', params: [{ name: 'password', type: 'string', required: true, maxLength: 512 }], returns: ['uid', 'publicKey'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'publicKey', type: 'string', required: true }, { name: 'createdAt', type: 'number', required: true }], description: 'Generate/re-provision your Ed25519 signing keypair (private key password-encrypted, self-only)', ai: false },
    // sign also returns uid + digest alongside signature + publicKey (the legacy decl omitted them).
    { name: 'user.key.sign', params: [{ name: 'uid', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'digest', type: 'string', required: true, maxLength: 128 }, { name: 'password', type: 'string', required: true, maxLength: 512 }], returns: ['signature', 'publicKey'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'digest', type: 'string', required: true }, { name: 'signature', type: 'string', required: true }, { name: 'publicKey', type: 'string', required: true }], description: 'Sign a hex digest as yourself (uid defaults to your session; rate-limited, self-only)', ai: false },
    // getPublic returns uid + status too; publicKey is null when the uid has no key → NOT required.
    { name: 'user.key.public', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['publicKey', 'history'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'publicKey', type: 'string' }, { name: 'status', type: 'string', required: true }, { name: 'history', type: 'array', required: true }], description: 'Get a uid public key + retired-key history (for verifying signatures)', ai: false },
    // status returns uid too; publicKey null when no key → NOT required.
    { name: 'user.key.status', params: [{ name: 'uid', type: 'string', maxLength: 64, pattern: 'id' }], returns: ['hasKey'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'hasKey', type: 'boolean', required: true }, { name: 'publicKey', type: 'string' }], description: 'Whether a uid has an active signing key (uid defaults to your session)', ai: false },
    // revoke returns { uid, revoked:false, reason } on the no-key path, { uid, revoked:true } otherwise — reason conditional.
    { name: 'user.key.revoke', params: [{ name: 'uid', type: 'string', required: true, maxLength: 64, pattern: 'id' }], returns: ['uid', 'revoked'], returns_schema: [{ name: 'uid', type: 'string', required: true }, { name: 'revoked', type: 'boolean', required: true }, { name: 'reason', type: 'string' }], description: 'Admin: retire a uid signing key (forgot-password recovery)', ai: false },

    { name: 'methods', params: [], description: 'Get method definitions', returns: ['methods', 'description'], ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', returns: ['entities'], ai: false }
];
