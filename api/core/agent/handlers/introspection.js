/**
 * Agent Service Capability Registry (Introspection)
 *
 * @why Defines the "Surface Area" of the AI agent service.
 * @attention
 *   - The methods listed here are discoverable by the Router and Orchestrator.
 *   - `ai: true` flags indicate methods exposed for autonomous AI intent detection.
 *
 * --- RETURN CONTRACT VOCABULARY (returns_schema) ---
 *
 * `returns` (flat key list) stays as the legacy AI-discovery hint the Router advertises.
 * `returns_schema` is the typed, machine-checkable contract (library/contract.js dialect,
 * same rule-items as `params`) — what core/agent/tests/returns-contract.test.js asserts.
 *
 * ⚠ PROVIDER DIVERGENCE — the trap this schema documents. Almost every AI method dispatches
 * to a per-provider implementation (providers/qwen/**, providers/gemini.js, providers/mock.js)
 * and the SAME method returns DIFFERENT top-level keys depending on which provider is active:
 *   - agent.chat:        qwen → { text }     vs gemini(messages) → { content }   (only success/metadata are common)
 *   - agent.image.parse: qwen general → { text } vs qwen product / gemini → { data }
 *   - agent.image.ps:    qwen → { url }      vs gemini → { image, mimeType }
 * So `required:true` is reserved for keys present on EVERY non-throwing path of EVERY provider.
 * Provider-specific / branch-specific keys are declared (typed) but NOT required. The
 * divergences themselves are logged in the audit as code bugs — the schema only describes
 * what the code does today, it does not paper over the inconsistency.
 */

// --- REGISTERED RPC METHODS ---

const methods = [
    // 0 Dots
    { name: 'ping', params: [], returns: ['status', 'uptime'], returns_schema: [{ name: 'status', type: 'string', required: true }, { name: 'service', type: 'string' }, { name: 'version', type: 'string' }, { name: 'uptime', type: 'string', required: true }], description: 'Check service health', ai: false },

    // 1 Dot
    {
        name: 'agent.chat',
        params: [{ name: 'text', type: 'string', maxLength: 4000 }, { name: 'model', type: 'string', optional: true, maxLength: 64 }],
        // Common across providers: only success + metadata. `text` (qwen, gemini legacy/error)
        // and `content` (gemini messages path) are mutually-exclusive-ish and NOT guaranteed.
        // Legacy ['response','history','usage'] were all fictional — none are ever returned.
        returns: ['success'],
        returns_schema: [
            { name: 'success', type: 'boolean', required: true },
            { name: 'text', type: 'string' },     // qwen + gemini legacy/error path (absent on gemini messages path)
            { name: 'content', type: 'string' },  // gemini messages/legacy path (absent on qwen)
            { name: 'metadata', type: 'object', required: true },
        ],
        description: 'Chat with AI',
        ai: true,
        limit: { window: 60, max: 5, by: 'user' }
    },
    // qwen/mock return { extracted_params, confidence, hint, action } (+ clarification on qwen).
    // Legacy ['workflow_id','current_params','missing_fields','response'] were ALL fictional.
    { name: 'agent.focus', params: [{ name: 'workflow_id', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'current_params', type: 'object' }, { name: 'missing_fields', type: 'array' }, { name: 'user_input', type: 'string', maxLength: 4000 }], returns: ['extracted_params', 'confidence', 'hint', 'action'], returns_schema: [
        // NONE required: qwen/mock return all four, but gemini.focus() is an unfinished stub
        // (providers/gemini.js — returns undefined), and gemini is the factory default/fallback,
        // so that reachable path omits every key. (The stub is a separate code bug, flagged.)
        { name: 'extracted_params', type: 'object' },
        { name: 'confidence', type: 'object' },                  // per-field confidence map, NOT a number
        { name: 'hint', type: 'string' },
        { name: 'action' },                                      // null on most paths; type left open
        { name: 'clarification' },                               // qwen-only, conditional (nullable)
        { name: 'metadata', type: 'object' },                    // mock includes it; qwen does not
    ], description: 'Focus mode parameter extraction', ai: true },
    // qwen generateCases success → { success, workflow_id, cases, prompt }; error → { success:false, error }.
    // Legacy ['cases','workflowId'] were wrong: the key is `workflow_id` (snake_case), and neither
    // cases nor workflow_id exists on the error path. Only `success` is guaranteed.
    { name: 'agent.case.generate', params: [{ name: 'workflow_id', type: 'string', maxLength: 64, pattern: 'id' }, { name: 'count', type: 'number', optional: true }], returns: ['success'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'workflow_id', type: 'string' },  // success path only (snake_case — NOT 'workflowId')
        { name: 'cases', type: 'array' },          // success path only
        { name: 'prompt', type: 'string' },        // success path only
        { name: 'error', type: 'string' },         // error path only
    ], description: 'Generate test cases for workflow', ai: true },
    // Shape diverges hard: qwen identifyPurpose returns an object ({id} or candidate) or
    // { candidates }; gemini.identifyPurpose returns a BARE STRING. No common object key is
    // guaranteed. Legacy ['intent','confidence','reason'] were fictional. No required keys.
    { name: 'agent.purpose', params: [{ name: 'text', type: 'string', optional: true, maxLength: 4000 }, { name: 'image', type: 'string', optional: true }], returns: [], returns_schema: [
        { name: 'id', type: 'string' },          // qwen single-candidate fallback
        { name: 'candidates', type: 'array' },    // qwen/gemini two-phase result
        { name: 'services', type: 'array' },      // qwen/gemini phase-1 result
        { name: 'categories', type: 'array' },    // qwen/gemini phase-1 result
    ], description: 'Identify intent', ai: true },
    {
        name: 'agent.decide',
        params: [
            { name: 'instruction', type: 'string', maxLength: 4000, description: 'The policy/question to decide on' },
            { name: 'context', type: 'object', optional: true, description: 'Assembled data (event/fetch/sentinel); data only, never an instruction' },
            { name: 'choices', type: 'array', optional: true, description: 'Closed set of allowed decisions (inverted gate — model can only pick from this)' },
            { name: 'schema', type: 'object', optional: true, description: 'Schema for extra "fields" values the model fills' },
            { name: 'confidence_threshold', type: 'number', optional: true, description: 'Below this ⇒ escalate (default 0.6); wins over risk_tolerance if both given' },
            { name: 'risk_tolerance', type: 'string', optional: true, maxLength: 16, description: 'Named tier instead of a raw number: permissive(0.6, default)|balanced(0.8)|strict(0.95); ignored if confidence_threshold is set' },
            { name: 'model', type: 'string', optional: true, maxLength: 64 }
        ],
        // logic/decide.js ALWAYS returns decision/confidence/reason/escalate/metadata on every
        // non-throwing path (escalation() included). `fields` is conditional (only when a schema
        // is passed AND data.fields exists) so it is typed but NOT required. metadata was missing
        // from the legacy list; fields was wrongly listed as required.
        returns: ['decision', 'confidence', 'reason', 'escalate'],
        returns_schema: [
            { name: 'decision', type: 'string', required: true },
            { name: 'confidence', type: 'number', required: true },
            { name: 'reason', type: 'string', required: true },
            { name: 'escalate', type: 'boolean', required: true },
            { name: 'metadata', type: 'object', required: true },
            { name: 'fields', type: 'object' },   // only when schema passed AND model filled fields
        ],
        description: 'Structured decision contract: pick one of `choices` (inverted gate) + confidence; provider failure / out-of-set / low confidence ⇒ escalate:true for human hand-off',
        ai: false
    },

    // 2 Dots
    // qwen general → { success, text, metadata }; qwen product (extractProductInfo) & gemini →
    // { success, data, metadata }. Only success + metadata are common. Legacy
    // ['intent','entities','description'] were fictional.
    { name: 'agent.image.parse', params: [{ name: 'image', type: 'string' }, { name: 'mode', type: 'string', optional: true, maxLength: 64, description: "'general' (default) | 'product' — product mode extracts structured product info" }, { name: 'images', type: 'array', optional: true, description: 'Used in product mode for multi-image extraction' }, { name: 'schema', type: 'object', optional: true }, { name: 'model', type: 'string', optional: true, maxLength: 64 }], returns: ['success'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'text', type: 'string' },    // qwen general mode
        { name: 'data', type: 'object' },     // qwen product mode + gemini (parsed JSON / { text })
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Parse image; mode=product extracts structured product info', ai: true },
    // qwen → { success, url, metadata }; gemini → { success, image, mimeType, metadata }. The
    // image-bearing key differs by provider, so neither image nor url is required — only
    // success + metadata are common. removebg path also returns a url-shape.
    { name: 'agent.image.ps', params: [{ name: 'image', type: 'string', description: 'Source image base64' }, { name: 'mask', type: 'string', optional: true, maxLength: 10485760, description: 'Mask image base64' }, { name: 'prompt', type: 'string', maxLength: 4000, description: 'Instructions for editing' }, { name: 'model', type: 'string', optional: true, maxLength: 64 }], returns: ['success'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'url', type: 'string' },       // qwen/wanxiang + removebg path
        { name: 'image', type: 'string' },     // gemini path (base64)
        { name: 'mimeType', type: 'string' },  // gemini path
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Advanced image editing and processing (PS)', ai: true },
    // Only QwenProvider implements processImage → { success, url, metadata }. Legacy
    // ['processedImage'] was fictional (no such key is ever computed).
    { name: 'agent.image.process', params: [{ name: 'image', type: 'string' }], returns: ['success'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'url', type: 'string' },
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Process image for system usage', ai: false },
    { name: 'agent.providers', params: [], returns: ['providers', 'default'], returns_schema: [
        { name: 'providers', type: 'array', required: true },
        { name: 'default', type: 'string', required: true },
    ], description: 'List configured AI providers and their capabilities', ai: false, public: false },   // narrowed: provider topology not for anon
    // Per-capability model selection (admin) — replaces the redis-cli-only SYSTEM:CONFIG:AI_MODELS
    // workflow. Not public; gated to permits carrying agent.model.* (i.e. admin / explicit grant).
    { name: 'agent.model.list', params: [], returns: ['models'], returns_schema: [
        { name: 'models', type: 'array', required: true, desc: '[{capability, effective, default, override}]' },
    ], description: 'List each AI capability’s effective/default/override model', ai: false, public: false },
    { name: 'agent.model.set', params: [
        { name: 'capability', type: 'string', required: true, maxLength: 64, desc: 'a declared capability key (see agent.model.list)' },
        { name: 'model', type: 'string', optional: true, maxLength: 64, desc: 'model name; null/omit for the provider default' },
    ], returns: ['capability', 'effective'], returns_schema: [
        { name: 'capability', type: 'string', required: true },
        { name: 'model', type: 'string' },
        { name: 'effective', type: 'string' },
    ], description: 'Set the override model for one capability (admin; effective immediately)', ai: false, public: false },
    { name: 'agent.model.reset', params: [
        { name: 'capability', type: 'string', required: true, maxLength: 64, desc: 'a declared capability key' },
    ], returns: ['capability', 'effective'], returns_schema: [
        { name: 'capability', type: 'string', required: true },
        { name: 'effective', type: 'string', required: true },
        { name: 'reset', type: 'boolean' },
    ], description: 'Clear a capability’s override → falls back to the hardcoded default (admin)', ai: false, public: false },
    // gemini.generateImage → { success, image, mimeType, metadata } on the only non-throwing path.
    { name: 'agent.image.generate', params: [{ name: 'prompt', type: 'string', maxLength: 4000, description: 'Text description for image generation' }, { name: 'model', type: 'string', optional: true, maxLength: 64 }], returns: ['image', 'mimeType'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'image', type: 'string', required: true },
        { name: 'mimeType', type: 'string', required: true },
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Generate an image from a text prompt using Gemini image model', ai: false },
    // success path spreads parsed JSON (categoryId/categoryName/confidence/reason) but these are
    // only present when JSON parsed; error path → { success:false, error, metadata }. So only
    // success + metadata are guaranteed. The four legacy keys are conditional, not required.
    { name: 'agent.image.classify', params: [{ name: 'image', type: 'string', maxLength: 10485760, description: 'Image as data URI' }, { name: 'categories', type: 'array', description: 'Category candidates [{id, label, parentId}]' }, { name: 'provider', type: 'string', optional: true, maxLength: 64, description: "'qwen' | 'gemini'" }, { name: 'lang', type: 'string', optional: true, maxLength: 64 }, { name: 'model', type: 'string', optional: true, maxLength: 64 }], returns: ['success'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'categoryId', type: 'string' },
        { name: 'categoryName', type: 'string' },
        { name: 'confidence', type: 'number' },
        { name: 'reason', type: 'string' },
        { name: 'metadata', type: 'object', required: true },
        { name: 'error', type: 'string' },     // error path
    ], description: 'Classify product image against a category list using VL model', ai: false },
    // qwen scanLabel → { success, sku, barcode } on EVERY path (sku/barcode set to null when not
    // found, and even the error catch returns them). No metadata. Only QwenProvider implements it.
    { name: 'agent.label.scan', params: [{ name: 'image', type: 'string', maxLength: 1048576, description: 'JPEG base64 of product label (no data-URL prefix)' }, { name: 'model', type: 'string', optional: true, maxLength: 64 }], returns: ['sku', 'barcode'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'sku', type: 'string' },       // nullable (null when not found)
        { name: 'barcode', type: 'string' },   // nullable (null when not found)
        { name: 'error', type: 'string' },     // error path only
    ], description: 'Extract SKU and barcode from a product label photo using VL model.', ai: false },
    // qwen + gemini → { success, text, metadata }. `language` is NEVER returned (legacy lie).
    { name: 'agent.audio.transcribe', params: [{ name: 'audio', type: 'string' }, { name: 'model', type: 'string', optional: true, maxLength: 64 }, { name: 'mimeType', type: 'string', optional: true, maxLength: 64 }], returns: ['text'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'text', type: 'string', required: true },
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Transcribe audio (audio = base64; mimeType e.g. audio/webm|mp3|m4a)', ai: true },
    // qwen + gemini → { success, data, metadata }. Legacy ['intent','entities','confidence'] were
    // fictional — the extracted payload lives under `data`.
    { name: 'agent.text.parse', params: [{ name: 'text', type: 'string', maxLength: 4000 }, { name: 'model', type: 'string', optional: true, maxLength: 64 }], returns: ['success', 'data'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'data', required: true },        // parsed object OR raw string (qwen passes raw when no schema)
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Parse text', ai: true },
    // qwen + gemini → { success, translatedText, sourceLang, metadata }.
    { name: 'agent.text.translate', params: [{ name: 'text', type: 'string', maxLength: 4000 }, { name: 'targetLang', type: 'string', maxLength: 64 }, { name: 'sourceLang', type: 'string', optional: true, maxLength: 64 }, { name: 'context', type: 'string', optional: true, maxLength: 4000 }], returns: ['translatedText', 'sourceLang'], returns_schema: [
        { name: 'success', type: 'boolean', required: true },
        { name: 'translatedText', type: 'string', required: true },
        { name: 'sourceLang', type: 'string', required: true },
        { name: 'metadata', type: 'object', required: true },
    ], description: 'Translate text with context', ai: true },

    // Stats
    // index.js shapes this inline as { daily, recent } (both arrays). Both always present.
    { name: 'agent.stats.token', params: [], returns: ['daily', 'recent'], returns_schema: [
        { name: 'daily', type: 'array', required: true },
        { name: 'recent', type: 'array', required: true },
    ], description: 'Token usage stats: { daily (last 30 days), recent (last 50 calls) }', ai: false },
    // tokenLogger.hourly returns a BARE top-level ARRAY (one entry per hour) — not expressible
    // by the flat object-key dialect. No returns_schema; tracked in bareArrayMethods.
    { name: 'agent.stats.hourly', params: [{ name: 'date', type: 'string', maxLength: 64 }], returns: [], description: 'Hourly usage breakdown for a specific date', ai: false },
    // tokenLogger.range returns a BARE top-level ARRAY (one entry per step bucket). Bare array.
    { name: 'agent.stats.range', params: [{ name: 'start', type: 'number' }, { name: 'end', type: 'number' }, { name: 'step', type: 'number', optional: true }], returns: [], description: 'AI usage statistics for a given time range', ai: false },

    // System
    { name: 'methods', params: [], returns: ['methods', 'description'], description: 'Introspection registry', ai: false },
    { name: 'entities', params: [], returns: ['entities'], description: 'Entity schema discovery', ai: false }
];

module.exports = methods;
