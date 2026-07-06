/**
 * model_config — 从 Redis SYSTEM:CONFIG:AI_MODELS 读取各 capability 的默认模型
 *
 * 优先级：params.model > Redis 配置 > hardcoded default
 * TTL 60 秒，避免每次请求都读 Redis。
 */
const { createLogger } = require('../../../library/logger');
const jsonrpc = require('../handlers/jsonrpc');
const logger = createLogger('agent');

const REDIS_KEY = 'SYSTEM:CONFIG:AI_MODELS';
const TTL_MS = 60_000;

// 硬编码兜底，Redis 未配置时生效
const HARDCODED_DEFAULTS = {
    // 图像
    'image.parse':              'gemini-2.5-flash',  // mode='product' 时也走此 key
    'image.generate':           'gemini-2.0-flash-exp',
    'image.classify':           'qwen-vl-plus',
    // Only QwenProvider implements processImage (DashScope background-generation). The
    // name just selects the provider (must start with 'qwen' — see providers/index.js
    // auto-detect); processImage ignores it and uses MODEL_BG_GEN internally. A gemini
    // default here routed to a provider with no processImage -> runtime crash.
    'image.process':            'qwen-bg-gen',
    'image.ps':                 null,           // null = 走 removebg / provider default
    // 音频 / 标签
    'audio.transcribe':         'gemini-2.5-flash',
    'label.scan':               'qwen-vl-plus',
    'embedding':                'gemini-embedding-2',
    'agent.tensor.embedding':   'gemini-embedding-2',
    // 文本
    'text.parse':               'gemini-2.5-flash',
    'text.translate':           'gemini-2.5-flash',
    // 对话 / 意图 / 工作流
    'agent.chat':               'gemini-1.5-flash',
    'agent.purpose':            'gemini-1.5-flash',
    'agent.focus':              'gemini-1.5-flash',
    'agent.decide':             'gemini-2.5-flash-lite',   // 决策契约：默认走便宜的 flash-lite
    // 业务增强（product / category / case）
    'agent.product.inquiry':    'gemini-1.5-flash',
    'agent.category.attr.suggest': 'gemini-1.5-flash',
    'agent.case.generate':      'gemini-1.5-flash',
};

let _cache = null;
let _cacheAt = 0;
let _redis = null;

function init(redis) {
    _redis = redis;
    _cache = null;      // a new backing store invalidates any cached config
    _cacheAt = 0;
}

async function _load() {
    if (!_redis) return {};
    try {
        const raw = await _redis.get(REDIS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        logger.warn('Failed to load AI model config from Redis:', e.message);
        return {};
    }
}

async function getModelMap() {
    const now = Date.now();
    if (!_cache || now - _cacheAt > TTL_MS) {
        const overrides = await _load();
        _cache = { ...HARDCODED_DEFAULTS, ...overrides };
        _cacheAt = now;
    }
    return _cache;
}

/**
 * 解析某 capability 最终使用的 model
 * @param {string} capability  例如 'image.parse'
 * @param {string|undefined} paramsModel  调用方传入的 model（最高优先级）
 */
async function resolve(capability, paramsModel) {
    if (paramsModel) return paramsModel;
    const map = await getModelMap();
    return map[capability] || null;
}

// ── Admin write path (agent.model.*) — replaces the redis-cli-only workflow ────────
// The capability key MUST be a known one (∈ HARDCODED_DEFAULTS): this both prevents
// typo'd garbage keys silently accumulating and bounds the config surface to declared
// capabilities. Writes bust the in-process cache so the change takes effect immediately
// (not after the 60 s TTL).

function assertKnownCapability(capability) {
    if (!(capability in HARDCODED_DEFAULTS)) {
        throw jsonrpc.INVALID_PARAMS(`unknown capability "${capability}" — must be one of the declared model keys (see agent.model.list)`);
    }
}

/** Effective map + per-capability {default, override} — for the admin/settings view. */
async function listModels() {
    const overrides = await _load();
    return {
        models: Object.keys(HARDCODED_DEFAULTS).sort().map((capability) => ({
            capability,
            effective: (capability in overrides) ? overrides[capability] : HARDCODED_DEFAULTS[capability],
            default: HARDCODED_DEFAULTS[capability],
            override: (capability in overrides) ? overrides[capability] : undefined,
        })),
    };
}

/** Set (or clear, via model:null = "provider default") the override for one capability. */
async function setModel({ capability, model } = {}) {
    if (!capability) throw jsonrpc.MISSING_PARAM('capability');
    assertKnownCapability(capability);
    if (model !== null && (typeof model !== 'string' || model.length === 0)) {
        throw jsonrpc.INVALID_PARAMS('model must be a non-empty string, or null for the provider default');
    }
    const overrides = await _load();
    overrides[capability] = model;
    await _redis.set(REDIS_KEY, JSON.stringify(overrides));
    _cache = null;   // bust → next resolve() reflects it immediately
    return { capability, model, effective: model ?? HARDCODED_DEFAULTS[capability] };
}

/** Remove a capability's override → falls back to its hardcoded default. */
async function resetModel({ capability } = {}) {
    if (!capability) throw jsonrpc.MISSING_PARAM('capability');
    assertKnownCapability(capability);
    const overrides = await _load();
    delete overrides[capability];
    await _redis.set(REDIS_KEY, JSON.stringify(overrides));
    _cache = null;
    return { capability, effective: HARDCODED_DEFAULTS[capability], reset: true };
}

module.exports = { init, resolve, getModelMap, listModels, setModel, resetModel, REDIS_KEY, HARDCODED_DEFAULTS };
