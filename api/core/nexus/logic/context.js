/**
 * nexus/logic/context.js — Agent 上下文装配（context.md v1 实现）
 *
 * @why 事件到达 Nexus 后、投递给 Agent 前，按 Agent 档案里声明式的 `context`：
 *        ① guard      —— JsonLogic 判断是否要唤醒该 Agent（不满足则跳过，不投递）
 *        ② data_fetchers —— 按 DAG 顺序经 Router 拉只读数据，挂到 {{fetch.<key>}}
 *        ③ system_prompt_template —— 用 {{event.*}}/{{fetch.*}}/{{sentinel.*}} 插值渲染
 *      产出标准化 Context Payload（见 context.md §6），Agent 收到即完整工作上下文，
 *      无需自己再发 RPC。
 *
 * 授权模型（接地到现实，authority 服务不存在 / ADR 1.4.1）：
 *   - 配置时（validateContext，纯函数）：每个 fetcher 方法必须是**只读后缀**
 *     （get/list/query/search/count/resolve/info），depends_on 无环、可解析。
 *     这挡住"把写方法配成 fetcher"和"循环依赖"两类错配。
 *   - 运行时（§1.2 per-Sentinel identity）：authorityRole 为 system.* 的 Sentinel，其 fetch
 *     经**该 Sentinel 自己的 bot token**（logic/identity.js 持有，relay.callAs 透传）发起，
 *     Router 的 checkAccess 用该 Sentinel 的窄 permit 兜底（越权方法直接 FORBIDDEN），审计也归属到它。
 *     authorityRole 非 system.*（描述性）的 Sentinel 退回共享 nexus 服务账号（legacy）。
 *   - 另有配置时预审（identity.preauditMethods）：create/update 时校验声明的 fetcher 方法 ⊆ 该
 *     Sentinel permit，提前 fail（仅在已发证时执行；否则运行时 checkAccess 仍兜底）。
 */
const { createLogger } = require('../../../library/logger');
const jsonlogic = require('../../../library/jsonlogic');
const jsonrpc = require('../handlers/jsonrpc');

const logger = createLogger('nexus-context');

// context.md §5.1 step 3 —— 只读动作后缀白名单。fetcher 只允许读，绝不触发副作用。
const READ_SUFFIXES = new Set(['get', 'list', 'query', 'search', 'count', 'resolve', 'info']);

// Per-fetcher timeout. relay already bounds each call at its socket timeout (~90s) — far too
// generous for a context fetch: nexus consumes events on a SINGLE loop, so a slow upstream
// would stall the WHOLE consumer for up to ~90s per event. This tighter bound caps that; a
// timeout is handled by the fetcher's existing on_error policy (skip/fallback/abort).
const fetcherTimeoutMs = () => parseInt(process.env.NEXUS_FETCHER_TIMEOUT_MS, 10) || 8000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(jsonrpc.INTERNAL_ERROR(`data_fetcher '${label}' timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── 模板插值（{{namespace.path}}）─────────────────────────────────────────────

function getPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * 用变量袋 bag 插值。
 *  - 整串恰好是单个 {{path}} → 返回原始值（保留类型：数字/对象，供 fetcher params 用）
 *  - 串内多处 {{path}} → 字符串替换（对象 JSON 序列化，标量 String 化）
 *  - 数组/对象 → 递归
 */
function interpolate(value, bag) {
    if (typeof value === 'string') {
        const whole = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
        if (whole) {
            const v = getPath(bag, whole[1]);
            return v === undefined ? '' : v;
        }
        return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => {
            const v = getPath(bag, p);
            if (v === undefined || v === null) return '';
            return typeof v === 'object' ? JSON.stringify(v) : String(v);
        });
    }
    if (Array.isArray(value)) return value.map(v => interpolate(v, bag));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, bag);
        return out;
    }
    return value;
}

// ── 配置时静态校验（纯函数，nexus.sentinel.create 调用）─────────────────────────

function detectCycle(fetchers) {
    const adj = new Map(fetchers.map(f => [f.key, f.depends_on || []]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(fetchers.map(f => [f.key, WHITE]));

    function dfs(key) {
        color.set(key, GRAY);
        for (const dep of (adj.get(key) || [])) {
            const c = color.get(dep);
            if (c === GRAY) throw jsonrpc.INVALID_PARAMS(`context.data_fetchers: cyclic dependency at "${key}" → "${dep}"`);
            if (c === WHITE) dfs(dep);
        }
        color.set(key, BLACK);
    }
    for (const f of fetchers) if (color.get(f.key) === WHITE) dfs(f.key);
}

/**
 * 校验 Agent 档案的 context 字段。失败抛 jsonrpc.INVALID_PARAMS。
 * context 为空（未声明）直接放行 —— 这类 Agent 收原始事件，不做装配。
 */
function validateContext(context) {
    if (context === undefined || context === null) return;
    if (typeof context !== 'object' || Array.isArray(context)) {
        throw jsonrpc.INVALID_PARAMS('context must be an object');
    }

    if (context.guard !== undefined && (typeof context.guard !== 'object' || context.guard === null || Array.isArray(context.guard))) {
        throw jsonrpc.INVALID_PARAMS('context.guard must be a JsonLogic object');
    }
    if (context.system_prompt_template !== undefined && typeof context.system_prompt_template !== 'string') {
        throw jsonrpc.INVALID_PARAMS('context.system_prompt_template must be a string');
    }
    // autorun: nexus-hosted decision agent — after assembly, invoke agent.decide with the
    // rendered prompt as the instruction and deliver the STRUCTURED decision
    // ({ decision, confidence, reason, escalate, fields? }) on context.output.
    //   - boolean true → free-form decision (no closed choice set)
    //   - object       → { choices?: string[], schema?: object, confidence_threshold?: number,
    //     risk_tolerance?: string }
    //     INVERTED GATE: choices/schema are fixed HERE at config time; the model only
    //     picks a listed option / fills values — it can never name the target action.
    if (context.autorun !== undefined) {
        const a = context.autorun;
        if (typeof a !== 'boolean') {
            if (typeof a !== 'object' || a === null || Array.isArray(a)) {
                throw jsonrpc.INVALID_PARAMS('context.autorun must be a boolean or an object');
            }
            if (a.choices !== undefined && (!Array.isArray(a.choices) || !a.choices.every(c => typeof c === 'string'))) {
                throw jsonrpc.INVALID_PARAMS('context.autorun.choices must be an array of strings');
            }
            if (a.schema !== undefined && (typeof a.schema !== 'object' || a.schema === null || Array.isArray(a.schema))) {
                throw jsonrpc.INVALID_PARAMS('context.autorun.schema must be an object');
            }
            if (a.confidence_threshold !== undefined && typeof a.confidence_threshold !== 'number') {
                throw jsonrpc.INVALID_PARAMS('context.autorun.confidence_threshold must be a number');
            }
            // Named tier alternative to confidence_threshold (agent.decide's RISK_TOLERANCE_LEVELS:
            // permissive/balanced/strict). Only type-checked here; unknown tier names fall back to
            // the default threshold at decide-time (fail-soft, logged) rather than rejected here —
            // keeps the enum's single source of truth in agent/logic/decide.js.
            if (a.risk_tolerance !== undefined && typeof a.risk_tolerance !== 'string') {
                throw jsonrpc.INVALID_PARAMS('context.autorun.risk_tolerance must be a string');
            }
        }
    }

    // emit: the declarative ACTION (§2.2 action loop). After assembly/autorun the
    // Sentinel emits a NEW event onto the bus. INVERTED GATE — stream + type are
    // FIXED here at config time; the model only fills payload_template VALUES, never
    // the target (a hallucinating model can't name a new stream/type). emit_when
    // (JsonLogic) optionally gates whether to emit.
    if (context.emit !== undefined) {
        const em = context.emit;
        if (typeof em !== 'object' || em === null || Array.isArray(em)) {
            throw jsonrpc.INVALID_PARAMS('context.emit must be an object');
        }
        if (!em.stream || typeof em.stream !== 'string') throw jsonrpc.INVALID_PARAMS('context.emit.stream (string) is required');
        if (!em.type   || typeof em.type   !== 'string') throw jsonrpc.INVALID_PARAMS('context.emit.type (string) is required');
        if (em.emit_when !== undefined && (typeof em.emit_when !== 'object' || em.emit_when === null || Array.isArray(em.emit_when))) {
            throw jsonrpc.INVALID_PARAMS('context.emit.emit_when must be a JsonLogic object');
        }
        if (em.payload_template !== undefined && (typeof em.payload_template !== 'object' || em.payload_template === null || Array.isArray(em.payload_template))) {
            throw jsonrpc.INVALID_PARAMS('context.emit.payload_template must be an object');
        }
    }

    const fetchers = context.data_fetchers;
    if (fetchers === undefined) return;
    if (!Array.isArray(fetchers)) throw jsonrpc.INVALID_PARAMS('context.data_fetchers must be an array');

    const keys = new Set();
    for (const f of fetchers) {
        if (!f || typeof f !== 'object') throw jsonrpc.INVALID_PARAMS('each data_fetcher must be an object');
        if (!f.key || typeof f.key !== 'string') throw jsonrpc.INVALID_PARAMS('data_fetcher missing string "key"');
        if (keys.has(f.key)) throw jsonrpc.INVALID_PARAMS(`duplicate data_fetcher key: "${f.key}"`);
        keys.add(f.key);

        if (!f.method || typeof f.method !== 'string') throw jsonrpc.INVALID_PARAMS(`data_fetcher "${f.key}": "method" required`);
        const action = f.method.split('.').pop();
        if (!READ_SUFFIXES.has(action)) {
            throw jsonrpc.INVALID_PARAMS(`data_fetcher "${f.key}": method "${f.method}" is not read-only (action "${action}" ∉ ${[...READ_SUFFIXES].join('/')})`);
        }
        if (f.on_error !== undefined && !['abort', 'skip', 'fallback'].includes(f.on_error)) {
            throw jsonrpc.INVALID_PARAMS(`data_fetcher "${f.key}": on_error must be abort|skip|fallback`);
        }
        if (f.guard !== undefined && (typeof f.guard !== 'object' || f.guard === null || Array.isArray(f.guard))) {
            throw jsonrpc.INVALID_PARAMS(`data_fetcher "${f.key}": guard must be a JsonLogic object`);
        }
    }
    for (const f of fetchers) {
        for (const dep of (f.depends_on || [])) {
            if (!keys.has(dep)) throw jsonrpc.INVALID_PARAMS(`data_fetcher "${f.key}": depends_on references unknown key "${dep}"`);
        }
    }
    detectCycle(fetchers);
}

// ── 运行时装配（事件到达 → Context Payload）──────────────────────────────────

function createAssembler({ relay, identity } = {}) {
    /**
     * @param agent   Agent 档案（含 .context）
     * @param event   解析后的事件对象（stream.parseEvent 的产物）
     * @param stream  事件流 key（= Context Payload 的 event.type）
     * @returns {Promise<{skip:true}|{payload:object}>}
     *          skip=true 表示触发 guard 不满足，调用方应跳过投递。
     */
    async function assemble(agent, event, stream) {
        const ctx = agent.context;
        const bag = {
            event: event || {},
            sentinel: { id: agent.id, name: agent.name, authorityRole: agent.authorityRole },
            fetch: {},
        };

        // ① 触发 guard：不满足则整体跳过（不唤醒该 Agent）
        if (ctx.guard && !jsonlogic.evaluateCondition(ctx.guard, bag)) {
            return { skip: true };
        }

        // ② data_fetchers —— 按 depends_on 分层，层内并行，层间串行
        const fetchers = Array.isArray(ctx.data_fetchers) ? ctx.data_fetchers : [];

        // §1.2 per-Sentinel identity: a Sentinel whose authorityRole is a system.* bot
        // uid runs its fetches under its OWN token (least-privilege + attributable).
        // Resolve it ONCE; a missing/expired token aborts assembly (settle → retry/DLQ)
        // rather than silently falling back to the broad nexus permit. A descriptive
        // (non-system.*) authorityRole keeps the legacy shared-relay path.
        let scopedToken = null;
        if (fetchers.length && identity && identity.isBotUid(agent.authorityRole)) {
            scopedToken = await identity.getToken(agent.authorityRole);
        }

        const done = new Set();
        let remaining = fetchers.slice();
        while (remaining.length) {
            const ready = remaining.filter(f => (f.depends_on || []).every(d => done.has(d)));
            if (!ready.length) {
                // 校验阶段已挡住环；此处是运行期保险
                throw jsonrpc.INTERNAL_ERROR('context.data_fetchers: unresolved dependency / cycle at runtime');
            }
            await Promise.all(ready.map(async (f) => {   // SAFE: bounded admin-authored fetcher DAG (validateContext caps shape/cycles), not user-scaled
                // fetcher 级 guard：不满足则该 key 置 null（模板插值渲染为空）
                if (f.guard && !jsonlogic.evaluateCondition(f.guard, bag)) {
                    bag.fetch[f.key] = null;
                    done.add(f.key);
                    return;
                }
                const params = interpolate(f.params || {}, bag);
                try {
                    if (!relay) throw jsonrpc.INTERNAL_ERROR('relay not configured');
                    const result = await withTimeout(
                        scopedToken
                            ? relay.callAs(scopedToken, f.method, params)     // §1.2 — as the Sentinel's own bot
                            : relay.call(f.method, params),                   // legacy — shared nexus identity
                        fetcherTimeoutMs(), f.method);
                    const extracted = f.result_path ? getPath(result, f.result_path) : result;
                    bag.fetch[f.key] = extracted === undefined ? null : extracted;
                } catch (err) {
                    const policy = f.on_error || 'abort';
                    if (policy === 'skip') {
                        bag.fetch[f.key] = null;
                    } else if (policy === 'fallback') {
                        bag.fetch[f.key] = f.fallback === undefined ? null : f.fallback;
                    } else {
                        logger.error('context.fetch.abort', { key: f.key, method: f.method, message: err.message });
                        throw err;
                    }
                    logger.warn('context.fetch.degraded', { key: f.key, method: f.method, policy, message: err.message });
                }
                done.add(f.key);
            }));
            remaining = remaining.filter(f => !done.has(f.key));
        }

        // ③ 渲染 system prompt
        const system_prompt = ctx.system_prompt_template
            ? interpolate(ctx.system_prompt_template, bag)
            : '';

        // ④ 组装 Context Payload（context.md §6）
        return {
            payload: {
                event: { type: stream, payload: event || {} },
                context: {
                    system_prompt,
                    data: bag.fetch,
                    sentinel: bag.sentinel,
                },
            },
        };
    }

    /**
     * Render the declarative `context.emit` from an assembled Context Payload.
     * Pure (no I/O) — the caller does the actual event.emit. Namespaces available to
     * emit_when / payload_template: {{event.*}} (raw triggering event), {{fetch.*}}
     * (data_fetcher results), {{output.*}} (autorun decision object —
     * { decision, confidence, reason, escalate, fields? }; null if no autorun),
     * {{sentinel.*}}. Returns { stream, type, actor, payload } or null (no emit block,
     * or emit_when evaluated false → skip).
     * @param agent      Sentinel profile (with .context.emit)
     * @param assembled  the Context Payload returned by assemble()
     */
    function buildEmit(agent, assembled) {
        const em = agent.context && agent.context.emit;
        if (!em) return null;
        const ctx = (assembled && assembled.context) || {};
        const bag = {
            event:    (assembled && assembled.event && assembled.event.payload) || {},
            fetch:    ctx.data || {},
            output:   ctx.output !== undefined ? ctx.output : null,
            sentinel: ctx.sentinel || { id: agent.id, name: agent.name },
        };
        if (em.emit_when && !jsonlogic.evaluateCondition(em.emit_when, bag)) return null;
        const payload = em.payload_template ? interpolate(em.payload_template, bag) : {};
        // actor (provenance) attributes the decision to THIS Sentinel; Router's
        // trustEventActor path stamps it onto the envelope. source stays system.nexus.
        // parent_event_id: the exact causal edge — this emit reacts to THAT envelope.
        // assembled.event = { type: stream, payload: parsedEntry } (assemble ④), so the
        // triggering envelope's event_id lives under .payload. Trusted on the
        // event.emit path only, same rule as actor.
        const parentEventId = (assembled && assembled.event && assembled.event.payload
            && assembled.event.payload.event_id) || undefined;
        return { stream: em.stream, type: em.type, actor: `sentinel:${agent.id}`, parent_event_id: parentEventId, payload };
    }

    return { assemble, buildEmit };
}

module.exports = { validateContext, createAssembler, interpolate, READ_SUFFIXES };
