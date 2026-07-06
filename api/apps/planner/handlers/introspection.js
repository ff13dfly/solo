/**
 * Service Capability Registry (Introspection)
 * 
 * @why This list defines the service's "Surface Area". The Router fetches this 
 *      during handshake to populate its global routing map.
 */

// --- PARAM DESCRIPTOR VOCABULARY ---
//
// Strengthened param schemas: every string param declares a length cap, and identifier-ish
// params declare the named `pattern` 'id' from library/validate.js's registry. The Router
// enforces these warn-mode by default (flip PARAM_VALIDATION=enforce to reject), so completing
// these declarations changes no runtime behavior — it just lets autocheck's ParamSchema go green
// and prepares for a future enforce-mode flip. Caps are conservative so valid input is never rejected.
//   required  — present on lookup/mutation keys and on required create inputs
//   maxLength — hard length cap (in addition to the global OOM shield)
//   pattern   — named format from library/validate PATTERNS ('id' here)
const ID       = { name: 'id', type: 'string', required: true, maxLength: 64, pattern: 'id' };
const USER_ID  = { name: 'userId', type: 'string', maxLength: 64, pattern: 'id' };
const TITLE    = { name: 'title', type: 'string', required: true, maxLength: 128 };
const NAME     = { name: 'name', type: 'string', maxLength: 128 };
// date/time values: short bounded strings, no slug pattern (not lowercase-hyphen slugs)
const DATE     = { name: 'date', type: 'string', required: true, maxLength: 64 };
const START    = { name: 'startTime', type: 'string', required: true, maxLength: 64 };
const END      = { name: 'endTime', type: 'string', required: true, maxLength: 64 };
// markdown body: free text, length only — no pattern so prose stays unconstrained
const CONTENT  = { name: 'content', type: 'string', maxLength: 4000 };

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) is the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`) — what the return-contract test asserts. Legacy `returns`
// MUST stay a subset of `returns_schema` (no drift; lintReturnContract enforces it).
//
// Verified against logic/agenda.js + logic/todo.js + library/entity.js (Entity Factory)
// create/get/update/delete/list results, and index.js's inline analyze/schedule stubs
// (2026-06-18). Hermetic proof lives in tests/returns-contract.test.js.
//
// ENTITY shape — agenda/todo create/get/update all resolve to an Entity-Factory record.
//   create returns { status: 'ACTIVE', ...params, id, createdAt, updatedAt }
//   get    returns the stored record verbatim (same keys)
//   update returns { ...existing, ...updates, updatedAt }
// On EVERY non-throwing path id/status/createdAt/updatedAt are present → required. All
// other fields (title, name, content, date, startTime, endTime, userId, todoId, priority,
// tags, relatedAgendas, ext, …) are caller-supplied params persisted as-is: present only
// when the caller sent them, so they are typed-but-NOT-required (a create that omits
// `content` returns a record without it). We declare the always-present core plus the
// common optional fields that the entity schema (handlers/entities.js) documents, so an
// orchestrator can bind to them when present without the contract lying about presence.
const AGENDA_RETURN = [
    { name: 'id',        type: 'string', required: true },
    { name: 'status',    type: 'string', required: true },   // entity lifecycle: ACTIVE | DELETED | SCHEDULED…
    { name: 'createdAt', type: 'number', required: true },
    { name: 'updatedAt', type: 'number', required: true },
    { name: 'title',     type: 'string' },                   // create param (persisted; not on get of a record stored without it)
    { name: 'date',      type: 'string' },
    { name: 'startTime', type: 'string' },
    { name: 'endTime',   type: 'string' },
    { name: 'content',   type: 'string' },                   // optional notes
    { name: 'userId',    type: 'string' },                   // owner, when supplied
    { name: 'todoId',    type: 'string' },                   // set only when a #todoId tag links (and NOT on the create return — see codeBugs)
];

const TODO_RETURN = [
    { name: 'id',        type: 'string', required: true },
    { name: 'status',    type: 'string', required: true },   // entity lifecycle: ACTIVE | DELETED | PENDING…
    { name: 'createdAt', type: 'number', required: true },
    { name: 'updatedAt', type: 'number', required: true },
    { name: 'name',      type: 'string' },                   // create param (persisted)
    { name: 'content',   type: 'string' },                   // markdown body, optional
    { name: 'userId',    type: 'string' },
    { name: 'priority',  type: 'string' },
    { name: 'tags',      type: 'array' },
    { name: 'relatedAgendas', type: 'array' },               // grown by agenda #-tag linking
    { name: 'ext',       type: 'object' },
];

// LIST shape — Entity-Factory .list always returns { items, total } (never a bare array).
const LIST_RETURN = [
    { name: 'items', type: 'array',  required: true },
    { name: 'total', type: 'number', required: true },
];

// SYNC shape — agenda.sync/todo.sync both end every non-throwing path with
// { success: true, count, idMap }. idMap (local-id → server-id) is the business-critical
// reconciliation map the Local-First client depends on; always present (possibly {}).
const SYNC_RETURN = [
    { name: 'success', type: 'boolean', required: true },
    { name: 'count',   type: 'number',  required: true },
    { name: 'idMap',   type: 'object',  required: true },
];

// STUB shape — index.js analyze/schedule are Phase-2 placeholders returning a fixed
// { status: 'PENDING', message }. Both keys are literal constants → required.
const STUB_RETURN = [
    { name: 'status',  type: 'string', required: true },
    { name: 'message', type: 'string', required: true },
];

// DELETE shape — agenda is HARD delete (softDelete:false) → entity.delete returns
// { success: true }. (todo is SOFT delete → returns the updated entity, see TODO_RETURN.)
const DELETE_RETURN = [
    { name: 'success', type: 'boolean', required: true },
];

// --- REGISTERED RPC METHODS ---

const methods = [
    // Infrastructure Methods
    { name: 'ping', params: [], returns: ['pong'], description: 'Health check' },
    { name: 'methods', params: [], returns: ['methods'], description: 'Get surface area' },
    { name: 'entities', params: [], returns: ['entities'], description: 'Get schemas' },

    // Agenda Methods
    { name: 'planner.agenda.create', params: [TITLE, DATE, START, END], returns: ['id', 'status'], returns_schema: AGENDA_RETURN, description: 'Create agenda item', ai: true },
    { name: 'planner.agenda.get', params: [ID], returns: ['id', 'status'], returns_schema: AGENDA_RETURN, description: 'Get agenda detail', ai: true },
    { name: 'planner.agenda.update', params: [ID], returns: ['id', 'status'], returns_schema: AGENDA_RETURN, description: 'Update agenda', ai: true },
    { name: 'planner.agenda.delete', params: [ID], returns: ['success'], returns_schema: DELETE_RETURN, description: 'Delete agenda item (hard delete)', ai: true },
    { name: 'planner.agenda.list', params: [USER_ID], returns: ['items', 'total'], returns_schema: LIST_RETURN, description: 'List agendas', ai: true },
    { name: 'planner.agenda.sync', params: [{ name: 'events', type: 'array' }], returns: ['success', 'count', 'idMap'], returns_schema: SYNC_RETURN, description: 'Bulk sync agendas (Local-First)', ai: true },

    // Todo Methods
    { name: 'planner.todo.create', params: [NAME, CONTENT], returns: ['id', 'status'], returns_schema: TODO_RETURN, description: 'Create todo (markdown)', ai: true },
    { name: 'planner.todo.get', params: [ID], returns: ['id', 'status'], returns_schema: TODO_RETURN, description: 'Get todo detail', ai: true },
    { name: 'planner.todo.update', params: [ID], returns: ['id', 'status'], returns_schema: TODO_RETURN, description: 'Update todo', ai: true },
    { name: 'planner.todo.delete', params: [ID], returns: ['id', 'status'], returns_schema: TODO_RETURN, description: 'Soft delete todo (returns the updated record, status=DELETED)', ai: true },
    { name: 'planner.todo.list', params: [], returns: ['items', 'total'], returns_schema: LIST_RETURN, description: 'List all todos', ai: true },
    { name: 'planner.todo.sync', params: [{ name: 'todos', type: 'array' }], returns: ['success', 'count', 'idMap'], returns_schema: SYNC_RETURN, description: 'Bulk sync todos (Local-First)', ai: true },

    { name: 'planner.todo.analyze',  params: [ID], returns: ['status', 'message'], returns_schema: STUB_RETURN, description: 'AI Project analysis (Phase 2 stub: returns status=PENDING)', ai: true },
    { name: 'planner.todo.schedule', params: [ID], returns: ['status', 'message'], returns_schema: STUB_RETURN, description: 'AI auto-scheduling for a todo (Phase 2 stub: returns status=PENDING)', ai: true }
];

module.exports = methods;
