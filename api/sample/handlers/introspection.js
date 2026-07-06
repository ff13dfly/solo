/**
 * Service Capability Registry (Introspection)
 *
 * @why This list defines the service's "Surface Area". The Router fetches this
 *      during handshake to populate its global routing map.
 * @attention
 *   1. `ai: true`     — method is exposed to LLM for autonomous invocation.
 *   2. `returns`      — REQUIRED for ai:true methods. Lists the top-level fields
 *                       returned so external AI can chain calls without guessing.
 *                       Format: array of field name strings, e.g. ['id', 'name', 'status']
 *   3. `public: true` — Router bypasses permission check for this method.
 */

// --- PARAM DESCRIPTOR VOCABULARY ---
//
// Strengthened param schemas: every string param declares a length cap, and identifier-ish
// params declare a named `pattern` from library/validate.js's registry. The Router enforces
// these (warn-mode by default; flip PARAM_VALIDATION=enforce to reject). This is the template
// every service should follow — declare here, enforce at the Router, implement in library/validate.js.
//   required  — missing or blank-after-trim is rejected
//   maxLength — hard length cap (in addition to the global 5MB OOM shield)
//   pattern   — named format from library/validate PATTERNS ('id' | 'slug' | 'username' | …)
// Free-text fields (description) declare length only — no pattern, so prose stays unconstrained.
const ID       = { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' };
const NAME     = { name: 'name', type: 'string', required: true, maxLength: 64 };
const NAME_OPT = { name: 'name', type: 'string', maxLength: 64 };
const DESC     = { name: 'description', type: 'string', maxLength: 2000 };
const STATUS   = { name: 'status', type: 'string', required: true, maxLength: 32, pattern: 'slug' };
// Category vocabulary — MUST match what library/category.js destructures (key / id / label).
// `key` names the category (uppercased server-side, free-form ≤64 — no `id` pattern); the ID
// descriptor above doubles as the item id within a category; `label` is the item's display text.
// Declaring categoryId/itemId here would lie to the Router and crash the lib with MISSING_PARAM('key').
const KEY      = { name: 'key', type: 'string', required: true, maxLength: 64 };
const LABEL    = { name: 'label', type: 'string', maxLength: 128 };

// --- REGISTERED RPC METHODS ---

const methods = [
    // Item Methods
    { name: 'sample.item.create', params: [NAME, DESC], returns: ['id', 'name', 'status', 'createdAt'], description: 'Create item', ai: true },
    { name: 'sample.item.get',    params: [ID], returns: ['id', 'name', 'status', 'createdAt'], description: 'Get item detail', ai: true },
    { name: 'sample.item.update', params: [ID, NAME_OPT, DESC], returns: ['id', 'name', 'status', 'updatedAt'], description: 'Update item', ai: true },
    { name: 'sample.item.delete', params: [ID], returns: ['id', 'deleted'], description: 'Soft delete item', ai: true },
    { name: 'sample.item.restore',params: [ID], returns: ['id', 'status'], description: 'Restore item', ai: true },
    { name: 'sample.item.status', params: [ID, STATUS], returns: ['id', 'status'], description: 'Set item status', ai: true },
    { name: 'sample.item.list',   params: [], returns: ['items', 'total'], description: 'List all sample items', ai: true },
    { name: 'sample.item.purgeable', params: [ID], description: 'Verify if item can be purged', ai: false },
    { name: 'sample.item.destroy',   params: [ID], description: 'Permanently purge item', ai: false },

    // Category Methods
    // Category methods mirror library/category.js EXACTLY: params use key/id/label, and `returns`
    // lists the real top-level fields the lib emits. category.list returns a BARE top-level array
    // (not { items, total }) — the flat returns dialect can't express that, so it declares none.
    { name: 'sample.category.create',      params: [KEY], returns: ['key', 'type', 'scope', 'status'], description: 'Create category', ai: false },
    { name: 'sample.category.update',      params: [KEY], returns: ['key', 'type', 'scope', 'status'], description: 'Update category', ai: false },
    { name: 'sample.category.delete',      params: [KEY], returns: ['success'], description: 'Delete category', ai: false },
    { name: 'sample.category.list',        params: [], description: 'List categories (returns a bare array)', ai: false },
    { name: 'sample.category.get',         params: [KEY], returns: ['key', 'type', 'scope', 'items', 'status'], description: 'Get category detail', ai: false },
    { name: 'sample.category.item.add',    params: [KEY, ID, LABEL], returns: ['id', 'label', 'createdAt'], description: 'Add item to category', ai: false },
    { name: 'sample.category.item.get',    params: [KEY, ID], returns: ['id', 'label', 'desc', 'parentId', 'meta', 'createdAt'], description: 'Get a single category item', ai: false },
    { name: 'sample.category.item.update', params: [KEY, ID], returns: ['id'], description: 'Update category item', ai: false },
    { name: 'sample.category.item.remove', params: [KEY, ID], returns: ['success'], description: 'Remove item from category', ai: false },

    // Index Methods
    { name: 'sample.index.rebuild',  params: [], returns: ['status'], description: 'Rebuild RediSearch index', ai: false },
    { name: 'sample.index.schemas',  params: [], returns: ['schemas'], description: 'Get index schemas', ai: false },

    // --- System Methods ---
    { name: 'ping',    params: [], returns: ['status', 'version', 'uptime'], description: 'Health check', ai: true },
    { name: 'methods', params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions', ai: false }
];

module.exports = methods;
