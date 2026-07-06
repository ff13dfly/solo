// --- PARAM DESCRIPTOR VOCABULARY ---
//
// Strengthened param schemas: every string param declares a length cap, and identifier-ish
// params declare a named `pattern` from library/validate.js's registry. The Router enforces
// these (warn-mode by default; flip PARAM_VALIDATION=enforce to reject). Declared conservatively
// so a future enforce-mode flip won't reject valid input.
//   required  — missing or blank-after-trim is rejected (lookup/mutation keys only)
//   maxLength — hard length cap (in addition to the global OOM shield)
//   pattern   — named format from library/validate PATTERNS ('id' | 'uid' | 'slug' | 'username' | 'email' | 'phone')
const USERNAME = { name: 'username', type: 'string', required: true, maxLength: 64, pattern: 'username' };
const SERVICE  = { name: 'service', type: 'string', required: true, maxLength: 64 }; // service name key
const SERVICE_OPT = { name: 'service', type: 'string', maxLength: 64 };
const CFG_KEY  = { name: 'key', type: 'string', required: true, maxLength: 64 };     // config override key
const CFG_VAL  = { name: 'value', type: 'string', required: true, maxLength: 512 };  // opaque config value
const CHALLENGE = { name: 'challenge', type: 'string', required: true, maxLength: 512 }; // opaque challenge
const RESPONSE  = { name: 'response', type: 'string', required: true, maxLength: 512 };  // opaque challenge-response
const PASSWORD  = { name: 'password', type: 'string', required: true, maxLength: 512 };  // opaque credential
// Display-manifest store (Display Protocol §6). scope key = `${service}_${entity}`.
const DISPLAY_ID = { name: 'id', type: 'string', maxLength: 160 };       // scope key, or pass service+entity
const ENTITY_OPT = { name: 'entity', type: 'string', maxLength: 64 };
const MANIFEST   = { name: 'manifest', type: 'object', required: true }; // an EntityDisplay object

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`). Each entry below was re-verified against the ACTUAL handler
// (logic/*.js for the *.login.*/*.password.*/*.log.* methods, index.js for the inline
// setting.* methods) — `required:true` ONLY for keys present on EVERY non-throwing path.
//
// ⚠ Several legacy `returns` arrays were LIES vs. the code and have been corrected here
// (DECLARATION-side only — no handler/wire change). See tests/returns-contract.test.js and
// the audit notes for the specifics (e.g. login.verify never returns `user`; password.reset
// returns {success,username} not {ok}; log.error returns {logs[, service]} not {items,total}).

module.exports = [
    // 0 Dots
    {
        name: 'ping',
        params: [],
        returns: ["status", "version", "uptime"],
        description: 'Health check',
        ai: false
    },
    {
        // handler: identity.loginRequest → always { challenge, salt, iterations }
        // (salt/iterations come from the stored user, or randomly generated when the user
        //  is unknown — both branches still return all three keys).
        name: 'admin.login.request',
        params: [USERNAME],
        returns: ["challenge"],
        returns_schema: [
            { name: 'challenge',  type: 'string', required: true },
            { name: 'salt',       type: 'string', required: true },
            { name: 'iterations', type: 'number', required: true },
        ],
        description: 'Initiate login process',
        ai: false,
        public: true
    },
    {
        // handler: identity.loginVerify → { success: true, token } on the only non-throwing
        // path (failure throws AUTH_FAILED / INVALID_CHALLENGE). It NEVER returns `user`.
        name: 'admin.login.verify',
        params: [USERNAME, CHALLENGE, RESPONSE],
        returns: ["token"],
        returns_schema: [
            { name: 'success', type: 'boolean', required: true },
            { name: 'token',   type: 'string',  required: true },
        ],
        description: 'Verify login challenge',
        ai: false,
        public: true
    },
    {
        // handler: identity.saveAdmin → { success: true, username }. Never returns `ok`.
        name: 'admin.password.reset',
        params: [USERNAME, PASSWORD],
        returns: ["success"],
        returns_schema: [
            { name: 'success',  type: 'boolean', required: true },
            { name: 'username', type: 'string',  required: true },
        ],
        description: 'Set/reset the administrator credentials (PBKDF2 over password+username)',
        ai: false
    },

    // 2 Dots — Self management
    {
        // handler: identity.lockAdmin → { ok: true, tokenExpiresIn: 60 }
        name: 'admin.self.lock',
        params: [],
        returns: ['ok', 'tokenExpiresIn'],
        returns_schema: [
            { name: 'ok',             type: 'boolean', required: true },
            { name: 'tokenExpiresIn', type: 'number',  required: true },
        ],
        description: 'Shorten caller session to 60s and close administrator HTTP port (just-in-time admin)',
        ai: false
    },

    // 2 Dots
    {
        // handler: error.list. Two paths:
        //   - with `service`  → { service, logs }
        //   - without service → error.listAll → { logs }     (no `service` key)
        // `logs` is the ONLY always-present key; `service` is path-conditional. The legacy
        // {items,total} contract was a lie (those keys do not exist).
        name: 'admin.log.error',
        params: [SERVICE_OPT, {name: 'limit', type: 'number'}, {name: 'offset', type: 'number'}],
        returns: ["logs"],
        returns_schema: [
            { name: 'logs',    type: 'array',  required: true },
            { name: 'service', type: 'string' }, // only present on the single-service path
        ],
        description: 'List service errors',
        ai: true
    },
    {
        // handler: error.clear. Two paths:
        //   - with `service`  → { success: true, service }
        //   - without service → error.clearAll → { success: true }   (no `service` key)
        // `success` is the only always-present key.
        name: 'admin.log.clear',
        params: [SERVICE],
        returns_schema: [
            { name: 'success', type: 'boolean', required: true },
            { name: 'service', type: 'string' }, // only present on the single-service path
        ],
        description: 'Clear service errors',
        ai: true
    },

    // 2 Dots — Service Config
    {
        // handler (index.js): returns `redisClient.hGetAll('config:'+service) || {}` — a BARE
        // hash map { overrideKey: rawStringValue, ... } with ARBITRARY (data-dependent) keys,
        // NOT a wrapper { overrides }. The flat object-key dialect cannot name arbitrary keys,
        // so NO returns_schema is declared and the false legacy `returns:['overrides']` is removed.
        name: 'setting.config.get',
        params: [SERVICE],
        description: 'Get Redis config overrides for a service',
        ai: false
    },
    {
        // handler (index.js): { ok: true }
        name: 'setting.config.set',
        params: [SERVICE, CFG_KEY, CFG_VAL],
        returns_schema: [
            { name: 'ok', type: 'boolean', required: true },
        ],
        description: 'Set a config override for a service',
        ai: false
    },
    {
        // handler (index.js): { ok: true }
        name: 'setting.config.del',
        params: [SERVICE, CFG_KEY],
        returns_schema: [
            { name: 'ok', type: 'boolean', required: true },
        ],
        description: 'Delete a config override for a service',
        ai: false
    },
    {
        // handler (index.js): returns `keys.map(...)` — a BARE top-level ARRAY of service-name
        // strings, NOT { services }. A bare array cannot be expressed by the object-key dialect,
        // so the false legacy `returns:['services']` is removed and no returns_schema is added.
        name: 'setting.config.list',
        params: [],
        description: 'List all services with config overrides',
        ai: false
    },
    {
        // handler (index.js): JSON.parse(SYSTEM:CONFIG:SCHEMA:{service}) or `null` when unpublished.
        // When non-null the stored shape (library/config.js publish) IS { service, publishedAt, keys };
        // none can be `required` because the not-found path returns a bare null. Keys typed, not required.
        name: 'setting.config.schema',
        params: [SERVICE],
        returns: ['service', 'publishedAt', 'keys'],
        returns_schema: [
            { name: 'service',     type: 'string' },
            { name: 'publishedAt', type: 'string' },
            { name: 'keys',        type: 'array'  },
        ],
        description: 'Get declared config keys and defaults for a service',
        ai: false
    },
    // System-level auto↔manual automation control (operator seam).
    {
        // handler (index.js): { services, allPaused, anyPaused }
        name: 'setting.automation.status',
        params: [],
        returns: ['services', 'allPaused', 'anyPaused'],
        returns_schema: [
            { name: 'services',  type: 'object',  required: true }, // { svc: { paused: bool } }
            { name: 'allPaused', type: 'boolean', required: true },
            { name: 'anyPaused', type: 'boolean', required: true },
        ],
        description: 'Admin: system-wide automation pause state (per service + aggregate)',
        ai: false
    },
    {
        // handler (index.js): { paused: true }
        name: 'setting.automation.pause',
        params: [],
        returns: ['paused'],
        returns_schema: [
            { name: 'paused', type: 'boolean', required: true },
        ],
        description: 'Admin: pause ALL automation (nexus + orchestrator loops) — degrade to manual',
        ai: false
    },
    {
        // handler (index.js): { paused: false }
        name: 'setting.automation.resume',
        params: [],
        returns: ['paused'],
        returns_schema: [
            { name: 'paused', type: 'boolean', required: true },
        ],
        description: 'Admin: resume ALL automation',
        ai: false
    },
    {
        // handler (index.js): JSON.parse(SYSTEM:INDEX_SCHEMA:{service}) or `null` when unset.
        // When non-null the stored shape (library/indexer.saveSchemas) is a BARE map keyed by
        // entity name → { name, prefix, schema } with ARBITRARY top-level keys — NOT
        // { service, indexedAt, redisearch } (those keys never exist; the legacy `returns` was a
        // total lie). Arbitrary-key object + nullable → no expressible object-key contract; removed.
        name: 'setting.index.schema',
        params: [SERVICE],
        description: 'Get RediSearch index schema for a service',
        ai: false
    },

    // --- Entity display-manifest store (Display Protocol §6, layer ②-B) ---
    // operator boot-fetches list() and merges over its static base; admin edits via
    // set()/delete(). Server-side set() is a STRUCTURAL guard only — full field-reference
    // lint runs operator-side against the live introspection index.
    {
        // handler (index.js): the EntityDisplay manifest object, or null if unset
        name: 'setting.display.list',
        params: [],
        description: 'List all entity display manifests (operator boot)',
        ai: false
    },
    {
        name: 'setting.display.get',
        params: [DISPLAY_ID, SERVICE_OPT, ENTITY_OPT],
        description: 'Get one entity display manifest by id (or service+entity)',
        ai: false
    },
    {
        // handler (index.js): { ok: true, scope, warnings[] }
        name: 'setting.display.set',
        params: [MANIFEST, DISPLAY_ID, SERVICE_OPT, ENTITY_OPT],
        returns_schema: [
            { name: 'ok', type: 'boolean', required: true },
            { name: 'scope', type: 'string', required: true },
        ],
        description: 'Upsert an entity display manifest (structural-validated)',
        ai: false
    },
    {
        // handler (index.js): { ok: true, scope }
        name: 'setting.display.delete',
        params: [DISPLAY_ID, SERVICE_OPT, ENTITY_OPT],
        returns_schema: [
            { name: 'ok', type: 'boolean', required: true },
            { name: 'scope', type: 'string', required: true },
        ],
        description: 'Delete an entity display manifest (reset to static base)',
        ai: false
    },

    // Fleet-standard system methods (declaration ↔ registration sync, CLAUDE.md §5)
    { name: 'methods',  params: [], description: 'Get surface area definition', ai: false },
    { name: 'entities', params: [], description: 'Get entity definitions (administrator manages no business entities — empty)', ai: false },
];
