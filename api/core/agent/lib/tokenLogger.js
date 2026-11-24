/**
 * tokenLogger — AI 调用分层计量、跨箱委托归因与 fulfillment 单据级用量账本
 *
 * 单例模式，由 agent/index.js 在 Redis 连接后调用 init()。
 * 各 provider 直接 require 并调用 log()，fire-and-forget；
 * 外部异构算子/RPA 会话经 `agent.stats.record` 调用 record() 幂等写入。
 *
 * Redis 结构：
 *   AGENT:TOKEN:LOG                      List  最新 1000 条原始记录（LPUSH + LTRIM）
 *   AGENT:TOKEN:DAILY:YYYYMMDD           Hash  当日汇总（保留原顶层字段 + tier:* + provider:*）
 *   AGENT:TOKEN:HOURLY:YYYYMMDD:HH       Hash  小时汇总（calls / costUsd / model:* / tier:*）
 *   AGENT:TOKEN:FULFILLMENT:<id>         Hash  履约单级累计账本（90d TTL）
 *   AGENT:TOKEN:PROFILE:YYYYMMDD:<prof>  Hash  履约模板日汇总（90d TTL）
 *   AGENT:TOKEN:IDEMP:<key>              Str   `agent.stats.record` 24h 幂等防重锁
 */

const { walContext } = require('../../../library/entity');
const jsonrpc = require('../handlers/jsonrpc');

let _redis = null;

const VALID_TIERS = new Set(['local', 'cloud', 'peer', 'rpa']);
const FULFILLMENT_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const FULFILLMENT_PROFILE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const IDEMP_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TTL_90_DAYS = 90 * 86400;
const IDEMP_TTL_SEC = 86400;

// ── 计费参考单价（$/M tokens）── 仅供相对比较，不作结算依据 ──────────────
// 注意：更具体的 key 必须排在前面，避免 'gemini-2.5-flash' 先于 'gemini-2.5-flash-image' 命中
const PRICING = {
    'gemini-2.5-flash-image': { in: 0.075, out: 0.30, imageOut: 0.04 }, // 图片输出 $0.04/张
    'gemini-2.5-flash':       { in: 0.075, out: 0.30 },
    'gemini-2.0-flash':       { in: 0.075, out: 0.30 },
    'qwen-vl-max':            { in: 1.10,  out: 1.10  },
    'qwen-vl-plus':           { in: 0.50,  out: 0.50  },
    'qwen-max':               { in: 1.60,  out: 6.40  },
    'qwen-plus':              { in: 0.12,  out: 0.36  },
    'qwen-turbo':             { in: 0.05,  out: 0.15  },
    'gpt-4o-mini':            { in: 0.15,  out: 0.60  },
    'gpt-4o':                 { in: 2.50,  out: 10.00 },
    'deepseek-chat':          { in: 0.14,  out: 0.28  },
    'default':                { in: 0.10,  out: 0.30  },
};

function resolveTier(provider, explicitTier) {
    if (typeof explicitTier === 'string' && VALID_TIERS.has(explicitTier)) {
        return explicitTier;
    }
    const p = String(provider || '').trim().toLowerCase();
    if (p === 'ollama' || p === 'local' || p === 'apple-vision') return 'local';
    if (p === 'solo-peer') return 'peer';
    if (p === 'rpa' || p.endsWith('-rpa')) return 'rpa';
    return 'cloud';
}

function estimateCost(model, inputTokens, outputTokens, hasImageOutput, { tier = 'cloud', explicitCostUsd } = {}) {
    if (typeof explicitCostUsd === 'number' && Number.isFinite(explicitCostUsd) && explicitCostUsd >= 0) {
        return +explicitCostUsd.toFixed(6);
    }
    // Local compute (ollama), cross-box delegation caller side (solo-peer), and session RPA default to $0
    if (tier === 'local' || tier === 'peer' || tier === 'rpa') {
        return 0;
    }
    const m = model || '';
    const key = Object.keys(PRICING).find(k => k !== 'default' && m === k)
             || Object.keys(PRICING).find(k => k !== 'default' && m.startsWith(k))
             || 'default';
    const p = PRICING[key];
    const inCost  = (inputTokens  / 1_000_000) * p.in;
    const outCost = (outputTokens / 1_000_000) * p.out;
    const imgCost = hasImageOutput ? (p.imageOut || 0) : 0;
    return +(inCost + outCost + imgCost).toFixed(6);
}

function cleanKeySegment(raw, fallback = 'unknown') {
    const s = String(raw || fallback).trim().replace(/[^A-Za-z0-9_.-]/g, '_');
    return s || fallback;
}

function assertStatsRecordAuthorized(req) {
    const permit = req && req.permit;
    const user = String((req && req.user) || '');
    if (permit === 'admin' || user === 'admin' || user.startsWith('system.') || user.startsWith('bot.')) {
        return;
    }
    throw jsonrpc.UNAUTHORIZED();
}

async function _writeUsage(redis, {
    method = 'agent.unknown',
    model = 'unknown',
    provider = 'unknown',
    tier: rawTier,
    calls: rawCalls = 1,
    inputTokens: rawIn = 0,
    outputTokens: rawOut = 0,
    images: rawImages,
    hasImageOutput = false,
    costUsd: explicitCostUsd,
    fulfillmentId: explicitFulfillmentId,
    profileId: explicitProfileId,
    uid: explicitUid,
    trace: explicitTrace,
} = {}) {
    const tier = resolveTier(provider, rawTier);
    const calls = Math.max(0, Math.trunc(Number(rawCalls ?? 1) || 0));
    const inputTokens = Math.max(0, Number(rawIn) || 0);
    const outputTokens = Math.max(0, Number(rawOut) || 0);
    const imageCount = typeof rawImages === 'number' && Number.isFinite(rawImages)
        ? Math.max(0, Math.trunc(rawImages))
        : (hasImageOutput ? 1 : 0);
    const costUsd = estimateCost(model, inputTokens, outputTokens, hasImageOutput || imageCount > 0, {
        tier,
        explicitCostUsd,
    });

    const store = walContext.getStore() || {};
    const candFid = explicitFulfillmentId || store.fulfillmentId || null;
    const fulfillmentId = (typeof candFid === 'string' && FULFILLMENT_ID_RE.test(candFid)) ? candFid : null;
    const candProf = explicitProfileId || store.profileId || null;
    const profileId = (typeof candProf === 'string' && FULFILLMENT_PROFILE_RE.test(candProf)) ? candProf : null;
    const uid = explicitUid || store.uid || null;
    const trace = explicitTrace || store.trace || null;

    const nowMs = Date.now();
    const now = new Date(nowMs);
    const dayStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const hourStr = String(now.getUTCHours()).padStart(2, '0');

    const dayKey    = `AGENT:TOKEN:DAILY:${dayStr}`;
    const hourlyKey = `AGENT:TOKEN:HOURLY:${dayStr}:${hourStr}`;
    const modelClean = cleanKeySegment(model, 'unknown');
    const provClean  = cleanKeySegment(provider, 'unknown');

    const entry = JSON.stringify({
        ts: nowMs,
        method,
        model,
        provider,
        tier,
        calls,
        inputTokens,
        outputTokens,
        images: imageCount,
        hasImageOutput: Boolean(hasImageOutput || imageCount > 0),
        costUsd,
        ...(uid ? { uid } : {}),
        ...(trace ? { trace } : {}),
        ...(fulfillmentId ? { fulfillmentId } : {}),
        ...(profileId ? { profileId } : {}),
    });

    const ops = [
        redis.lPush('AGENT:TOKEN:LOG', entry)
            .then(() => redis.lTrim('AGENT:TOKEN:LOG', 0, 999)),

        // Top-level legacy daily counters (100% backward-compatible; local/peer $0 no longer inflates costUsd)
        redis.hIncrBy(dayKey, 'calls', calls),
        redis.hIncrByFloat(dayKey, 'inputTokens', inputTokens),
        redis.hIncrByFloat(dayKey, 'outputTokens', outputTokens),
        redis.hIncrByFloat(dayKey, 'costUsd', costUsd),

        // Per-tier daily counters
        redis.hIncrBy(dayKey, `tier:${tier}:calls`, calls),
        redis.hIncrByFloat(dayKey, `tier:${tier}:inputTokens`, inputTokens),
        redis.hIncrByFloat(dayKey, `tier:${tier}:outputTokens`, outputTokens),
        redis.hIncrByFloat(dayKey, `tier:${tier}:costUsd`, costUsd),
        redis.hIncrBy(dayKey, `tier:${tier}:images`, imageCount),

        // Per-provider daily counters
        redis.hIncrBy(dayKey, `provider:${provClean}:calls`, calls),
        redis.hIncrByFloat(dayKey, `provider:${provClean}:inputTokens`, inputTokens),
        redis.hIncrByFloat(dayKey, `provider:${provClean}:outputTokens`, outputTokens),
        redis.hIncrByFloat(dayKey, `provider:${provClean}:costUsd`, costUsd),
        redis.hIncrBy(dayKey, `provider:${provClean}:images`, imageCount),
        redis.expire(dayKey, TTL_90_DAYS),

        // Hourly counters
        redis.hIncrBy(hourlyKey, 'calls', calls),
        redis.hIncrByFloat(hourlyKey, 'costUsd', costUsd),
        redis.hIncrByFloat(hourlyKey, `model:${modelClean}:costUsd`, costUsd),
        redis.hIncrBy(hourlyKey, `tier:${tier}:calls`, calls),
        redis.hIncrByFloat(hourlyKey, `tier:${tier}:costUsd`, costUsd),
        redis.expire(hourlyKey, TTL_90_DAYS),
    ];

    if (fulfillmentId) {
        const ffKey = `AGENT:TOKEN:FULFILLMENT:${fulfillmentId}`;
        ops.push(
            redis.hIncrBy(ffKey, 'totalCalls', calls),
            redis.hIncrByFloat(ffKey, 'costUsd', costUsd),
            redis.hIncrBy(ffKey, 'images', imageCount),
            redis.hIncrBy(ffKey, `${tier}Calls`, calls),
            redis.hIncrByFloat(ffKey, `${tier}InputTokens`, inputTokens),
            redis.hIncrByFloat(ffKey, `${tier}OutputTokens`, outputTokens),
            redis.hIncrByFloat(ffKey, `${tier}CostUsd`, costUsd),
            redis.hIncrBy(ffKey, `${tier}Images`, imageCount),
            redis.hIncrBy(ffKey, `model:${modelClean}:calls`, calls),
            redis.hIncrByFloat(ffKey, `model:${modelClean}:tokens`, inputTokens + outputTokens),
            redis.hIncrByFloat(ffKey, `model:${modelClean}:costUsd`, costUsd),
            redis.hSet(ffKey, 'updatedAt', String(nowMs)),
            redis.expire(ffKey, TTL_90_DAYS)
        );
        if (profileId) {
            ops.push(redis.hSet(ffKey, 'profileId', profileId));
        }
    }

    if (profileId) {
        const profKey = `AGENT:TOKEN:PROFILE:${dayStr}:${profileId}`;
        ops.push(
            redis.hIncrBy(profKey, 'totalCalls', calls),
            redis.hIncrByFloat(profKey, 'costUsd', costUsd),
            redis.hIncrBy(profKey, 'images', imageCount),
            redis.hIncrBy(profKey, `${tier}Calls`, calls),
            redis.hIncrByFloat(profKey, `${tier}InputTokens`, inputTokens),
            redis.hIncrByFloat(profKey, `${tier}OutputTokens`, outputTokens),
            redis.hIncrByFloat(profKey, `${tier}CostUsd`, costUsd),
            redis.hIncrBy(profKey, `${tier}Images`, imageCount),
            redis.expire(profKey, TTL_90_DAYS)
        );
    }

    await Promise.all(ops);
    return { tier, costUsd, calls, inputTokens, outputTokens, images: imageCount, fulfillmentId, profileId };
}

function parseDailyBreakdown(h) {
    const emptyTier = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, images: 0 });
    const byTier = {
        local: emptyTier(),
        cloud: emptyTier(),
        peer: emptyTier(),
        rpa: emptyTier(),
    };
    const byProvider = {};

    for (const [k, rawVal] of Object.entries(h || {})) {
        if (k.startsWith('tier:')) {
            const [, t, metric] = k.split(':');
            if (byTier[t] && metric in byTier[t]) {
                byTier[t][metric] = (metric === 'calls' || metric === 'images')
                    ? parseInt(rawVal || 0, 10)
                    : parseFloat(rawVal || 0);
            }
        } else if (k.startsWith('provider:')) {
            const [, prov, metric] = k.split(':');
            if (!prov || !metric) continue;
            if (!byProvider[prov]) byProvider[prov] = emptyTier();
            if (metric in byProvider[prov]) {
                byProvider[prov][metric] = (metric === 'calls' || metric === 'images')
                    ? parseInt(rawVal || 0, 10)
                    : parseFloat(rawVal || 0);
            }
        }
    }
    return { byTier, byProvider };
}

function shapeFulfillmentHash(id, h = {}) {
    const hasData = h && Object.keys(h).length > 0;
    const tierBucket = (t) => ({
        calls:        parseInt(h[`${t}Calls`]        || 0, 10),
        inputTokens:  parseFloat(h[`${t}InputTokens`]  || 0),
        outputTokens: parseFloat(h[`${t}OutputTokens`] || 0),
        costUsd:      parseFloat(h[`${t}CostUsd`]      || 0),
        images:       parseInt(h[`${t}Images`]       || 0, 10),
    });
    const models = {};
    if (hasData) {
        for (const [k, v] of Object.entries(h)) {
            if (!k.startsWith('model:')) continue;
            const [, mName, metric] = k.split(':');
            if (!mName || !metric) continue;
            if (!models[mName]) models[mName] = { calls: 0, tokens: 0, costUsd: 0 };
            models[mName][metric] = metric === 'calls' ? parseInt(v || 0, 10) : parseFloat(v || 0);
        }
    }
    return {
        id,
        profileId:  h.profileId || null,
        totalCalls: parseInt(h.totalCalls || 0, 10),
        costUsd:    parseFloat(h.costUsd || 0),
        images:     parseInt(h.images || 0, 10),
        tiers: {
            local: tierBucket('local'),
            cloud: tierBucket('cloud'),
            peer:  tierBucket('peer'),
            rpa:   tierBucket('rpa'),
        },
        models,
        updatedAt: h.updatedAt ? parseInt(h.updatedAt, 10) : null,
    };
}

module.exports = {
    init(redis) {
        _redis = redis;
    },

    resolveTier,
    estimateCost,
    assertStatsRecordAuthorized,

    /**
     * Fire-and-forget logger called by in-process providers (`ollama`, `qwen`, `gemini`, `solo-peer`, etc.)
     */
    async log(params = {}) {
        if (!_redis) return;
        try {
            await _writeUsage(_redis, params);
        } catch (_) { /* fire-and-forget */ }
    },

    /**
     * Idempotent usage recorder for trusted internal callers (`agent.stats.record`).
     */
    async record(redis, params = {}) {
        const client = redis || _redis;
        if (!client) throw jsonrpc.SERVICE_NOT_READY();

        const { provider, idempotencyKey } = params;
        if (!provider || typeof provider !== 'string') {
            throw jsonrpc.INVALID_PARAMS('provider is required');
        }
        const tier = resolveTier(provider, params.tier);

        if (idempotencyKey !== undefined && idempotencyKey !== null && idempotencyKey !== '') {
            if (typeof idempotencyKey !== 'string' || !IDEMP_KEY_RE.test(idempotencyKey)) {
                throw jsonrpc.INVALID_PARAMS('Invalid idempotencyKey format');
            }
            const acquired = await client.set(`AGENT:TOKEN:IDEMP:${idempotencyKey}`, '1', {
                NX: true,
                EX: IDEMP_TTL_SEC,
            });
            if (!acquired) {
                return { recorded: false, duplicate: true, tier, costUsd: 0 };
            }
        }

        const out = await _writeUsage(client, {
            ...params,
            tier,
            method: params.method || 'agent.stats.record',
            model: params.model || provider,
        });
        return {
            recorded: true,
            duplicate: false,
            tier: out.tier,
            costUsd: out.costUsd,
        };
    },

    /**
     * Query per-fulfillment-instance and/or per-profile AI usage (`agent.stats.fulfillment`).
     */
    async fulfillmentStats(redis, { id, ids, profile, days = 30 } = {}) {
        const client = redis || _redis;
        if (!client) throw jsonrpc.SERVICE_NOT_READY();

        const targetIds = [];
        if (typeof id === 'string' && id.trim()) {
            if (!FULFILLMENT_ID_RE.test(id.trim())) throw jsonrpc.INVALID_PARAMS('Invalid fulfillment id');
            targetIds.push(id.trim());
        }
        if (Array.isArray(ids)) {
            if (ids.length > 100) throw jsonrpc.INVALID_PARAMS('ids exceeds maximum batch size of 100');
            for (const raw of ids) {
                if (typeof raw !== 'string' || !FULFILLMENT_ID_RE.test(raw.trim())) {
                    throw jsonrpc.INVALID_PARAMS(`Invalid fulfillment id in ids: ${String(raw)}`);
                }
                const trimmed = raw.trim();
                if (!targetIds.includes(trimmed)) targetIds.push(trimmed);
            }
        }

        const items = [];
        for (const fid of targetIds) {
            const h = await client.hGetAll(`AGENT:TOKEN:FULFILLMENT:${fid}`);
            items.push(shapeFulfillmentHash(fid, h || {}));
        }

        const out = {
            items,
            item: typeof id === 'string' && id.trim() ? (items[0] || shapeFulfillmentHash(id.trim(), {})) : null,
        };

        if (typeof profile === 'string' && profile.trim()) {
            const profId = profile.trim();
            if (!FULFILLMENT_PROFILE_RE.test(profId)) {
                throw jsonrpc.INVALID_PARAMS('Invalid profile identifier');
            }
            const boundedDays = Math.max(1, Math.min(90, Math.trunc(Number(days) || 30)));
            const dailyList = [];
            const summary = {
                totalCalls: 0,
                costUsd: 0,
                images: 0,
                tiers: {
                    local: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, images: 0 },
                    cloud: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, images: 0 },
                    peer:  { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, images: 0 },
                    rpa:   { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, images: 0 },
                },
            };
            for (let i = 0; i < boundedDays; i++) {
                const d = new Date(Date.now() - i * 86400_000);
                const dateStr = d.toISOString().slice(0, 10);
                const key = `AGENT:TOKEN:PROFILE:${dateStr.replace(/-/g, '')}:${profId}`;
                const h = await client.hGetAll(key);
                if (h && Object.keys(h).length) {
                    const shaped = shapeFulfillmentHash(profId, h);
                    dailyList.push({
                        date: dateStr,
                        totalCalls: shaped.totalCalls,
                        costUsd: shaped.costUsd,
                        images: shaped.images,
                        tiers: shaped.tiers,
                    });
                    summary.totalCalls += shaped.totalCalls;
                    summary.costUsd = +((summary.costUsd + shaped.costUsd).toFixed(6));
                    summary.images += shaped.images;
                    for (const t of ['local', 'cloud', 'peer', 'rpa']) {
                        summary.tiers[t].calls += shaped.tiers[t].calls;
                        summary.tiers[t].inputTokens += shaped.tiers[t].inputTokens;
                        summary.tiers[t].outputTokens += shaped.tiers[t].outputTokens;
                        summary.tiers[t].costUsd = +((summary.tiers[t].costUsd + shaped.tiers[t].costUsd).toFixed(6));
                        summary.tiers[t].images += shaped.tiers[t].images;
                    }
                }
            }
            out.profile = {
                id: profId,
                daily: dailyList,
                summary,
            };
        }

        return out;
    },

    /** 供 RPC 查询：最近 N 天日汇总 */
    async daily(redis, days = 30) {
        const result = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(Date.now() - i * 86400_000);
            const dateStr = d.toISOString().slice(0, 10);
            const key = `AGENT:TOKEN:DAILY:${dateStr.replace(/-/g, '')}`;
            const h = await redis.hGetAll(key);
            if (h && Object.keys(h).length) {
                const { byTier, byProvider } = parseDailyBreakdown(h);
                result.push({
                    date: dateStr,
                    calls:        parseInt(h.calls        || 0, 10),
                    inputTokens:  parseFloat(h.inputTokens  || 0),
                    outputTokens: parseFloat(h.outputTokens || 0),
                    costUsd:      parseFloat(h.costUsd      || 0),
                    byTier,
                    byProvider,
                });
            }
        }
        return result;
    },

    /** 供 RPC 查询：最近 N 条原始记录 */
    async recent(redis, limit = 50) {
        const raw = await redis.lRange('AGENT:TOKEN:LOG', 0, limit - 1);
        return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    },

    /** 供 RPC 查询：某天的小时分布（带模型拆分） */
    async hourly(redis, date) {
        const dayStr = date.replace(/-/g, '');
        const result = [];
        for (let i = 0; i < 24; i++) {
            const hourStr = String(i).padStart(2, '0');
            const key = `AGENT:TOKEN:HOURLY:${dayStr}:${hourStr}`;
            const h = await redis.hGetAll(key);
            if (h && Object.keys(h).length) {
                const models = {};
                Object.keys(h).forEach(k => {
                    if (k.startsWith('model:')) {
                        const m = k.split(':')[1];
                        models[m] = parseFloat(h[k] || 0);
                    }
                });
                result.push({
                    hour: `${hourStr}:00`,
                    costUsd: parseFloat(h.costUsd || 0),
                    models
                });
            } else {
                result.push({ hour: `${hourStr}:00`, costUsd: 0, models: {} });
            }
        }
        return result;
    },

    /**
     * 供 RPC 查询：通用区间统计
     * @params { start: number, end: number, step: number }
     */
    async range(redis, { start, end, step = 3600000 }) {
        const result = [];
        const maxSteps = 1000;
        let count = 0;

        for (let current = start; current < end && count < maxSteps; current += step) {
            const date = new Date(current);
            const dayStr = date.toISOString().slice(0, 10).replace(/-/g, '');
            const hourStr = String(date.getUTCHours()).padStart(2, '0');
            const key = `AGENT:TOKEN:HOURLY:${dayStr}:${hourStr}`;

            const h = await redis.hGetAll(key);
            const models = {};
            if (h) {
                Object.keys(h).forEach(k => {
                    if (k.startsWith('model:')) {
                        models[k.split(':')[1]] = parseFloat(h[k] || 0);
                    }
                });
            }

            result.push({
                ts: current,
                costUsd: parseFloat(h?.costUsd || 0),
                models
            });
            count++;
        }
        return result;
    }
};
