/**
 * Schedule CRUD — event.md §6.2 / §11.2 (nexus management area).
 *
 * A schedule entry defines WHEN and WHAT to fire:
 *   - fire_at:       absolute timestamp (ms) for the next trigger
 *   - recurrence_ms: repeat interval in ms (null = one-shot)
 *   - action.kind:   'run_command' → push to orchestrator run-queue
 *                    'emit_event'  → relay.call('event.emit', ...)
 *
 * Storage:
 *   NEXUS:SCHEDULE              zset   score=fire_at, member=schedule_id
 *   NEXUS:SCHEDULE:DEF:{id}     JSON   full definition
 */
const jsonrpc = require('../handlers/jsonrpc');

const VALID_KINDS = ['run_command', 'emit_event', 'call_method'];
const RPC_METHOD_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/;
const FORBIDDEN_SCHEDULE_METHOD_RE = /^(?:setting|administrator|admin)\.|^user\.(?:permit|bot|role)\.|^user\.account\.(?:destroy|remove)|\.token\.(?:set|clear|issue)$/;

function validateAction(action) {
    if (!action || typeof action !== 'object') throw jsonrpc.INVALID_PARAMS('action must be an object');
    if (!VALID_KINDS.includes(action.kind)) throw jsonrpc.INVALID_PARAMS(`action.kind must be one of: ${VALID_KINDS.join(', ')}`);
    if (action.kind === 'run_command' && !action.workflow_id)
        throw jsonrpc.INVALID_PARAMS('action.workflow_id required for run_command');
    if (action.kind === 'emit_event' && (!action.stream || !action.type))
        throw jsonrpc.INVALID_PARAMS('action.stream + action.type required for emit_event');
    if (action.kind === 'call_method') {
        if (!action.method || typeof action.method !== 'string' || !RPC_METHOD_RE.test(action.method)) {
            throw jsonrpc.INVALID_PARAMS('action.method must be a valid 2-4 segment lowercase dot-separated RPC method name');
        }
        if (FORBIDDEN_SCHEDULE_METHOD_RE.test(action.method)) {
            throw jsonrpc.FORBIDDEN(`action.method '${action.method}' is forbidden in scheduled actions`);
        }
        if (action.params !== undefined && (action.params === null || typeof action.params !== 'object' || Array.isArray(action.params))) {
            throw jsonrpc.INVALID_PARAMS('action.params must be a plain object when provided');
        }
    }
}

function assertBotScheduleScope(callerCtx, scheduleId, existingOwner, action) {
    if (!callerCtx || callerCtx.isAdmin) return;
    const u = callerCtx.user;
    if (!u || typeof u !== 'string' || !u.startsWith('system.') || callerCtx.owner) {
        throw jsonrpc.UNAUTHORIZED();
    }
    const svc = u.slice('system.'.length);
    if (scheduleId && ! (scheduleId.startsWith(`${svc}:`) || scheduleId.startsWith(`${svc}.`) || scheduleId.startsWith(`${svc}-`))) {
        throw jsonrpc.FORBIDDEN(`Service bot '${u}' must prefix schedule_id with '${svc}:' / '${svc}.' / '${svc}-'`);
    }
    if (existingOwner !== undefined && existingOwner !== u) {
        throw jsonrpc.FORBIDDEN(`Service bot '${u}' can only access or mutate its own schedules`);
    }
    if (action && action.kind === 'call_method' && typeof action.method === 'string' && !action.method.startsWith(`${svc}.`)) {
        throw jsonrpc.FORBIDDEN(`Service bot '${u}' can only schedule call_method within '${svc}.*'`);
    }
}

module.exports = (redis, { config }) => {
    const R = config.redis;

    function defKey(id) { return `${R.scheduleDefPrefix}${id}`; }

    async function create({ schedule_id, fire_at, recurrence_ms = null, action, enabled = true, owner = null }, callerCtx = null) {
        if (!schedule_id || typeof schedule_id !== 'string')
            throw jsonrpc.MISSING_PARAM('schedule_id');
        // schedule_id 是 Redis 键后缀:限定标识符字符集,挡掉控制字符/孤立代理/超长/glob 等
        // (否则怪字符进 RedisJSON 会抛 INTERNAL_ERROR 且泄漏底层解析消息).
        if (!/^[\w.:\-]{1,128}$/.test(schedule_id))
            throw jsonrpc.INVALID_PARAMS('schedule_id must be 1-128 chars of [A-Za-z0-9_.:-]');
        if (!fire_at || typeof fire_at !== 'number')
            throw jsonrpc.INVALID_PARAMS('fire_at must be a ms timestamp');
        validateAction(action);
        const effectiveOwner = (callerCtx && !callerCtx.isAdmin && callerCtx.user) ? callerCtx.user : (owner || null);
        assertBotScheduleScope(callerCtx, schedule_id, effectiveOwner, action);

        // Prevent overwrite of existing schedule
        const existing = await redis.json.get(defKey(schedule_id));
        if (existing) throw jsonrpc.INVALID_PARAMS(`Schedule '${schedule_id}' already exists`);

        const def = {
            schedule_id,
            fire_at,
            recurrence_ms: (typeof recurrence_ms === 'number' && recurrence_ms > 0) ? recurrence_ms : null,
            action,
            enabled: enabled !== false,
            owner: effectiveOwner,
            created_at: Date.now(),
            last_fired_at: null,
        };

        await redis.json.set(defKey(schedule_id), '$', def);
        await redis.zAdd(R.scheduleZset, { score: fire_at, value: schedule_id });
        return def;
    }

    async function get(id, callerCtx = null) {
        if (!id) throw jsonrpc.MISSING_PARAM('schedule_id');
        const def = await redis.json.get(defKey(id));
        if (!def) throw jsonrpc.NOT_FOUND('Schedule');
        assertBotScheduleScope(callerCtx, id, def.owner, def.action);
        return def;
    }

    async function list(callerCtx = null) {
        // create()/update()/del() already maintain R.scheduleZset (score=fire_at) for the
        // scheduler's own due-lookup — reuse it as the id index instead of a blocking KEYS
        // scan. Bonus: ZRANGE already returns ids in fire_at-ascending order, so the JS
        // sort this used to need is gone too.
        const ids = await redis.zRange(R.scheduleZset, 0, -1); // SAFE: small (schedule definitions, not executions)
        if (!ids.length) return [];
        const raws = await redis.json.mGet(ids.map(defKey), '$');
        const items = raws.map((r) => (r ? r[0] : null)).filter(Boolean);
        if (callerCtx && !callerCtx.isAdmin) {
            return items.filter((d) => d && d.owner === callerCtx.user);
        }
        return items;
    }

    async function update(id, changes = {}, callerCtx = null) {
        if (!id) throw jsonrpc.MISSING_PARAM('schedule_id');
        const existing = await redis.json.get(defKey(id));
        if (!existing) throw jsonrpc.NOT_FOUND('Schedule');
        assertBotScheduleScope(callerCtx, id, existing.owner, changes.action !== undefined ? changes.action : existing.action);

        if (changes.action !== undefined) validateAction(changes.action);
        if (changes.recurrence_ms !== undefined && changes.recurrence_ms !== null && typeof changes.recurrence_ms !== 'number')
            throw jsonrpc.INVALID_PARAMS('recurrence_ms must be a number or null');

        const updated = {
            ...existing,
            ...changes,
            schedule_id: id, // immutable
            created_at: existing.created_at, // immutable
            ...(callerCtx && !callerCtx.isAdmin ? { owner: existing.owner } : {}),
        };
        await redis.json.set(defKey(id), '$', updated);

        // Sync zset score if fire_at changed
        const newFireAt = changes.fire_at !== undefined ? changes.fire_at : existing.fire_at;
        await redis.zAdd(R.scheduleZset, { score: newFireAt, value: id });

        return updated;
    }

    async function del(id, callerCtx = null) {
        if (!id) throw jsonrpc.MISSING_PARAM('schedule_id');
        const existing = await redis.json.get(defKey(id));
        if (!existing) throw jsonrpc.NOT_FOUND('Schedule');
        assertBotScheduleScope(callerCtx, id, existing.owner, existing.action);
        await redis.zRem(R.scheduleZset, id);
        await redis.json.del(defKey(id));
        return { ok: true };
    }

    return { create, get, list, update, delete: del };
};
