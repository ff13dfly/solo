/**
 * Gateway Service Capability Registry
 *
 * @why Defines the service's API surface for the Router.
 * @attention
 *   - Methods marked with `ai: true` are discoverable by the AI Agent.
 *   - Public methods (ping, methods, entities) are whitelisted in auth.js.
 */

// --- RETURN CONTRACT VOCABULARY (returns_schema) ---
//
// `returns` (flat key list) is the legacy AI-discovery hint the Router advertises.
// `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
// same rule-items as `params`). The return-contract test asserts the ACTUAL handler output
// against these. required:true ONLY for keys present on EVERY non-throwing path.
//
// Entity-Factory CRUD (library/entity.js) guarantees these four keys on every create/get/
// update result (get throws NOT_FOUND rather than returning null, so the success path always
// carries them). The user-supplied content fields (name/host/subject/…) are passed straight
// through from params and are NOT factory-guaranteed → typed but never required.
const ENTITY_BASE = [
    { name: 'id',        type: 'string', required: true },
    { name: 'status',    type: 'string', required: true },   // Entity lifecycle: ACTIVE | DELETED
    { name: 'createdAt',  type: 'number', required: true },
    { name: 'updatedAt',  type: 'number', required: true },
];

// SMTP account record (logic/smtp.js stripPass → `pass` never present in output).
const SMTP_RETURN = [
    ...ENTITY_BASE,
    { name: 'name',   type: 'string' },
    { name: 'host',   type: 'string' },
    { name: 'port',   type: 'number' },
    { name: 'secure', type: 'boolean' },
    { name: 'user',   type: 'string' },
    { name: 'from',   type: 'string' },
];

const EMAIL_TEMPLATE_RETURN = [
    ...ENTITY_BASE,
    { name: 'name',        type: 'string' },
    { name: 'subject',     type: 'string' },
    { name: 'html',        type: 'string' },
    { name: 'variables',   type: 'array' },
    { name: 'description', type: 'string' },
];

const SMS_TEMPLATE_RETURN = [
    ...ENTITY_BASE,
    { name: 'name',         type: 'string' },
    { name: 'channel',      type: 'string' },
    { name: 'providerCode', type: 'string' },
    { name: 'variables',    type: 'array' },
    { name: 'description',  type: 'string' },
];

// Entity-Factory .list() → { items, total } (an OBJECT, not a bare array).
const LIST_RETURN = [
    { name: 'items', type: 'array',  required: true },
    { name: 'total', type: 'number', required: true },
];

// Hard delete (no softDelete configured on any gateway entity) → { success: true }.
const DELETE_RETURN = [
    { name: 'success', type: 'boolean', required: true },
];

// email.send / sms.send providers (logic/email.js, logic/sms.js, and the inline smtpId
// branch in logic/index.js) every non-throwing path returns exactly these three keys.
const SEND_RETURN = [
    { name: 'success',   type: 'boolean', required: true },
    { name: 'messageId', type: 'string',  required: true },
    { name: 'provider',  type: 'string',  required: true },
];

module.exports = [
    { name: 'ping', params: [], returns: ['status', 'uptime'], description: 'Check service health', ai: false },
    { name: 'entities', params: [], description: 'Get entity schema definitions', ai: false },

    // --- Echo ---
    { name: 'gateway.echo', params: ['data'], returns: ['echo'], returns_schema: [{ name: 'echo', type: 'object', required: true }], description: 'Echo input data', ai: false },

    // --- SMTP Account Management ---
    { name: 'gateway.smtp.create', params: ['name', 'host', 'port', 'secure', 'user', 'pass', 'from'], returns: ['id', 'status', 'createdAt'], returns_schema: SMTP_RETURN, description: 'Create SMTP account (pass encrypted at rest)', ai: false },
    { name: 'gateway.smtp.get',    params: ['id'], returns: ['id', 'status'], returns_schema: SMTP_RETURN, description: 'Get SMTP account by ID (pass omitted)', ai: false },
    { name: 'gateway.smtp.list',   params: [], returns: ['items', 'total'], returns_schema: LIST_RETURN, description: 'List SMTP accounts (pass omitted)', ai: false },
    { name: 'gateway.smtp.update', params: ['id'], returns: ['id', 'status', 'updatedAt'], returns_schema: SMTP_RETURN, description: 'Update SMTP account fields', ai: false },
    { name: 'gateway.smtp.delete', params: ['id'], returns: ['success'], returns_schema: DELETE_RETURN, description: 'Delete SMTP account', ai: false },
    { name: 'gateway.smtp.test',   params: ['id'], returns: ['success', 'message'], returns_schema: [{ name: 'success', type: 'boolean', required: true }, { name: 'message', type: 'string', required: true }], description: 'Verify SMTP connection for an account', ai: false },

    // --- Email Template Management ---
    { name: 'gateway.email.template.create', params: ['name', 'subject', 'html', 'variables'], returns: ['id', 'status', 'createdAt'], returns_schema: EMAIL_TEMPLATE_RETURN, description: 'Create email template', ai: false },
    { name: 'gateway.email.template.get',    params: ['id'], returns: ['id', 'status'], returns_schema: EMAIL_TEMPLATE_RETURN, description: 'Get email template by ID', ai: false },
    { name: 'gateway.email.template.list',   params: [], returns: ['items', 'total'], returns_schema: LIST_RETURN, description: 'List email templates', ai: false },
    { name: 'gateway.email.template.update', params: ['id'], returns: ['id', 'status', 'updatedAt'], returns_schema: EMAIL_TEMPLATE_RETURN, description: 'Update email template', ai: false },
    { name: 'gateway.email.template.delete', params: ['id'], returns: ['success'], returns_schema: DELETE_RETURN, description: 'Delete email template', ai: false },

    // --- Email Send ---
    {
        name: 'gateway.email.send',
        params: ['to', 'subject', 'content', 'templateId', 'variables', 'smtpId'],
        returns: ['success', 'messageId', 'provider'],
        returns_schema: SEND_RETURN,
        description: 'Send email — directly (subject+content) or via template (templateId+variables). Optional smtpId selects a stored SMTP account.',
        ai: true
    },

    // --- SMS Template Management ---
    { name: 'gateway.sms.template.create', params: ['name', 'channel', 'providerCode', 'variables'], returns: ['id', 'status', 'createdAt'], returns_schema: SMS_TEMPLATE_RETURN, description: 'Create SMS template', ai: false },
    { name: 'gateway.sms.template.get',    params: ['id'], returns: ['id', 'status'], returns_schema: SMS_TEMPLATE_RETURN, description: 'Get SMS template by ID', ai: false },
    { name: 'gateway.sms.template.list',   params: [], returns: ['items', 'total'], returns_schema: LIST_RETURN, description: 'List SMS templates', ai: false },
    { name: 'gateway.sms.template.update', params: ['id'], returns: ['id', 'status', 'updatedAt'], returns_schema: SMS_TEMPLATE_RETURN, description: 'Update SMS template', ai: false },
    { name: 'gateway.sms.template.delete', params: ['id'], returns: ['success'], returns_schema: DELETE_RETURN, description: 'Delete SMS template', ai: false },

    // --- SMS Send ---
    {
        name: 'gateway.sms.send',
        params: ['templateId', 'phone', 'variables'],
        returns: ['success', 'messageId', 'provider'],
        returns_schema: SEND_RETURN,
        description: 'Send SMS via stored template (templateId + phone + variables)',
        ai: true
    },

    // --- Outbound Webhook Send ---
    {
        name: 'gateway.webhook.send',
        params: ['url', 'payload', 'type', 'targetId', 'secret', 'timeoutMs'],
        returns: ['success', 'status', 'provider', 'messageId'],
        returns_schema: [
            { name: 'success',   type: 'boolean', required: true },
            { name: 'status',    type: 'number',  required: true },  // upstream HTTP status (2xx)
            { name: 'provider',  type: 'string',  required: true },  // always 'webhook'
            { name: 'messageId', type: 'string',  required: true },  // `wh-<sentAt>`
        ],
        description: 'POST a JSON payload to an external endpoint (machine target). Optional secret → HMAC-SHA256 X-Solo-Signature header.',
        ai: false
    },

    // --- Image Processing ---
    {
        name: 'gateway.rmbg.cutout',
        params: ['image'],
        // ⚠ Only `provider` is present on EVERY path. The local-ONNX path spreads the local
        // server's JSON ({ ...result, provider:'local' }) — `image` is whatever that server
        // returns, NOT computed by gateway — while the remove.bg path always sets `image`.
        // So `image` is typed but NOT required, and the legacy `returns` is corrected from
        // ['image','provider'] → ['provider'] (see codeBugsFlagged: non-uniform shape).
        returns: ['provider'],
        returns_schema: [
            { name: 'provider', type: 'string', required: true },   // 'local' | 'removebg'
            { name: 'image',    type: 'string' },                   // base64 cutout — guaranteed only on the remove.bg path
        ],
        description: 'Remove image background via local ONNX server or cloud API fallback',
        ai: false
    }
];
