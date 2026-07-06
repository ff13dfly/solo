/**
 * tokenLogger — AI 调用 token 统计
 *
 * 单例模式，由 agent/index.js 在 Redis 连接后调用 init()。
 * 各 provider 直接 require 并调用 log()，fire-and-forget。
 *
 * Redis 结构：
 *   AGENT:TOKEN:LOG            List  最新 1000 条原始记录（LPUSH + LTRIM）
 *   AGENT:TOKEN:DAILY:YYYYMMDD Hash  当日汇总（calls / inputTokens / outputTokens / costUsd）
 */

let _redis = null;

// ── 计费参考单价（$/M tokens）── 仅供相对比较，不作结算依据 ──────────────
// 注意：更具体的 key 必须排在前面，避免 'gemini-2.5-flash' 先于 'gemini-2.5-flash-image' 命中
const PRICING = {
    'gemini-2.5-flash-image': { in: 0.075, out: 0.30, imageOut: 0.04 }, // 图片输出 $0.04/张
    'gemini-2.5-flash':       { in: 0.075, out: 0.30 },
    'gemini-2.0-flash':       { in: 0.075, out: 0.30 },
    'qwen-vl-plus':           { in: 0.50,  out: 0.50  },
    'qwen-vl-max':            { in: 1.10,  out: 1.10  },
    'default':                { in: 0.10,  out: 0.30  },
};

function estimateCost(model, inputTokens, outputTokens, hasImageOutput) {
    // 优先精确匹配，再前缀匹配，避免短 key 先命中
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

function todayKey() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

module.exports = {
    init(redis) {
        _redis = redis;
    },

    /**
     * @param {object} p
     * @param {string} p.method       — e.g. 'agent.image.ps'
     * @param {string} p.model        — e.g. 'gemini-2.5-flash-image'
     * @param {string} p.provider     — 'gemini' | 'qwen' | ...
     * @param {number} [p.inputTokens]
     * @param {number} [p.outputTokens]
     * @param {boolean} [p.hasImageOutput]
     */
    async log({ method, model, provider, inputTokens = 0, outputTokens = 0, hasImageOutput = false }) {
        if (!_redis) return;
        const costUsd = estimateCost(model, inputTokens, outputTokens, hasImageOutput);
        const entry = JSON.stringify({
            ts: Date.now(),
            method, model, provider,
            inputTokens, outputTokens,
            hasImageOutput, costUsd,
        });

        const now = new Date();
        const dayStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hourStr = String(now.getUTCHours()).padStart(2, '0');

        const dayKey    = `AGENT:TOKEN:DAILY:${dayStr}`;
        const hourlyKey = `AGENT:TOKEN:HOURLY:${dayStr}:${hourStr}`;
        const modelClean = (model || 'unknown').replace(/:/g, '_');

        try {
            await Promise.all([
                _redis.lPush('AGENT:TOKEN:LOG', entry)
                    .then(() => _redis.lTrim('AGENT:TOKEN:LOG', 0, 999)),
                
                _redis.hIncrBy(dayKey, 'calls', 1),
                _redis.hIncrByFloat(dayKey, 'inputTokens', inputTokens),
                _redis.hIncrByFloat(dayKey, 'outputTokens', outputTokens),
                _redis.hIncrByFloat(dayKey, 'costUsd', costUsd),
                _redis.expire(dayKey, 90 * 86400),

                _redis.hIncrBy(hourlyKey, 'calls', 1),
                _redis.hIncrByFloat(hourlyKey, 'costUsd', costUsd),
                _redis.hIncrByFloat(hourlyKey, `model:${modelClean}:costUsd`, costUsd),
                _redis.expire(hourlyKey, 90 * 86400),
            ]);
        } catch (_) { /* fire-and-forget */ }
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
                result.push({
                    date: dateStr,
                    calls:        parseInt(h.calls        || 0),
                    inputTokens:  parseFloat(h.inputTokens  || 0),
                    outputTokens: parseFloat(h.outputTokens || 0),
                    costUsd:      parseFloat(h.costUsd      || 0),
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
        // 为保证性能，限制区间跨度
        const maxSteps = 1000;
        let count = 0;

        for (let current = start; current < end && count < maxSteps; current += step) {
            const next = Math.min(current + step, end);
            
            // 我们目前只有按小时汇总的 bucket (UTC 时间)
            // 所以如果 step 不是 1 小时，或者不是对齐的，会有一定的精度损失
            // 但对于仪表盘展示来说足够了
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
