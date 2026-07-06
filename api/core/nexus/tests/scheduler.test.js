/**
 * Nexus scheduler + schedule CRUD tests (event.md §6.2).
 *
 * All hermetic: no real Redis, no real relay. The scheduler's tick() is
 * called directly; the schedule module is tested via its CRUD methods.
 *
 * Scheduler covered:
 *   - due entry → executeAction (run_command lPush / emit_event relay.call)
 *   - future entry (score > now) → re-added to zset, not fired
 *   - disabled entry → skipped (not re-added)
 *   - one-shot (recurrence_ms null) → not re-added, last_fired_at updated
 *   - recurring (recurrence_ms N) → re-added at firedAt+N, last_fired_at updated
 *   - emit_event relay failure → fire NOT counted, tick doesn't throw; recurring still reschedules
 *   - missing DEF (orphaned zset entry) → skipped without crash
 *   - trigger_id = {schedule_id}:{fire_at}; trigger_source = cron:{schedule_id}
 *   - runId generated for run_command
 *   - returns count of fired entries
 *
 * Schedule CRUD covered:
 *   - create: validates fields, stores DEF + zset
 *   - create: rejects duplicate schedule_id
 *   - get: retrieves DEF; NOT_FOUND on missing
 *   - list: returns all defs sorted by fire_at
 *   - update: merges changes, syncs zset score
 *   - delete: removes DEF + zset entry
 */

const createScheduler = require('../logic/scheduler');
const createSchedule  = require('../logic/schedule');
const config          = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// Fake Redis
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeRedis() {
    const docs  = {};          // json store
    const lists = {};          // list store (for lPush)
    const zset  = new Map();   // scheduleZset: value → score

    return {
        json: {
            async set(key, _p, val) { docs[key] = JSON.parse(JSON.stringify(val)); },
            async get(key)          { return docs[key] !== undefined ? JSON.parse(JSON.stringify(docs[key])) : null; },
            async del(key)          { delete docs[key]; },
        },
        async keys(pattern) {
            const prefix = pattern.replace(/\*$/, '');
            return Object.keys(docs).filter(k => k.startsWith(prefix));
        },
        // zset operations (used by scheduler + schedule CRUD)
        async zAdd(key, { score, value }) {
            // key ignored — single zset for simplicity in tests
            zset.set(value, score);
            return 1;
        },
        async zRem(key, value) {
            return zset.delete(value) ? 1 : 0;
        },
        // node-redis v5 split the two forms: zPopMin(key) → single {value,score}
        // (or undefined), zPopMinCount(key, count) → array. The scheduler uses the
        // count form; mirror both faithfully so the mock matches the real client.
        async zPopMinCount(key, count = 1) {
            const entries = [...zset.entries()].sort(([, a], [, b]) => a - b);
            const popped = entries.slice(0, count);
            popped.forEach(([v]) => zset.delete(v));
            return popped.map(([value, score]) => ({ value, score }));
        },
        async zPopMin(key) {
            const entries = [...zset.entries()].sort(([, a], [, b]) => a - b);
            if (entries.length === 0) return undefined;
            const [value, score] = entries[0];
            zset.delete(value);
            return { value, score };
        },
        // list operations (run_command lPush target)
        async lPush(key, val) {
            (lists[key] ||= []).unshift(val);
            return lists[key].length;
        },
        _list(key)  { return lists[key] || []; },
        _zset()     { return zset; },
        _docs()     { return docs; },
    };
}

const R = config.redis;
const NOW = 1_700_000_000_000; // fixed "now" for deterministic tests

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeDef(id, overrides = {}) {
    return {
        schedule_id:   id,
        fire_at:       NOW - 1000,  // due 1 second ago by default
        recurrence_ms: null,
        action:        { kind: 'run_command', workflow_id: 'wf_test', input: {} },
        enabled:       true,
        owner:         null,
        created_at:    NOW - 5000,
        last_fired_at: null,
        ...overrides,
    };
}

function seedScheduler(redis, def) {
    const key = `${R.scheduleDefPrefix}${def.schedule_id}`;
    redis._docs()[key] = def;
    redis._zset().set(def.schedule_id, def.fire_at);
}

function makeRelay(overrides = {}) {
    const calls = [];
    return {
        async call(method, params) { calls.push({ method, params }); },
        _calls: calls,
        ...overrides,
    };
}

function makeScheduler(redis, relay = makeRelay()) {
    return createScheduler(redis, { config, relay });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Scheduler — tick()
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler.tick — run_command', () => {
    test('due entry → lPush to orchestrator queue with correct fields', async () => {
        const redis = makeFakeRedis();
        seedScheduler(redis, makeDef('sched_rc1', { fire_at: NOW - 500 }));
        const scheduler = makeScheduler(redis);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(1);
        const queue = redis._list(R.orchRunQueuePending);
        expect(queue).toHaveLength(1);
        const cmd = JSON.parse(queue[0]);
        expect(cmd.workflowId).toBe('wf_test');
        expect(cmd.triggerSource).toBe('cron:sched_rc1');
        expect(cmd.triggerId).toBe(`sched_rc1:${NOW - 500}`);
        expect(cmd.runId).toMatch(/^run_[0-9a-f]+$/);
        expect(cmd.attempts).toBe(0);
    });

    test('future entry (score > now) → re-added to zset, not fired', async () => {
        const redis = makeFakeRedis();
        const futureAt = NOW + 60_000;
        seedScheduler(redis, makeDef('sched_future', { fire_at: futureAt }));
        const scheduler = makeScheduler(redis);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(0);
        expect(redis._list(R.orchRunQueuePending)).toHaveLength(0);
        // Re-added to zset
        expect(redis._zset().get('sched_future')).toBe(futureAt);
    });

    test('disabled entry → skipped, not re-added to zset', async () => {
        const redis = makeFakeRedis();
        seedScheduler(redis, makeDef('sched_dis', { enabled: false }));
        const scheduler = makeScheduler(redis);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(0);
        expect(redis._zset().has('sched_dis')).toBe(false);
    });

    test('one-shot (recurrence_ms null) → not re-added, last_fired_at updated', async () => {
        const redis = makeFakeRedis();
        seedScheduler(redis, makeDef('sched_os', { recurrence_ms: null }));
        const scheduler = makeScheduler(redis);

        await scheduler.tick(NOW);

        // Not in zset anymore
        expect(redis._zset().has('sched_os')).toBe(false);
        // DEF updated
        const key = `${R.scheduleDefPrefix}sched_os`;
        expect(redis._docs()[key].last_fired_at).toBe(NOW);
    });

    test('recurring → re-added at firedAt + recurrence_ms', async () => {
        const redis = makeFakeRedis();
        const firedAt = NOW - 500;
        const recMs = 86_400_000; // 24h
        seedScheduler(redis, makeDef('sched_rec', { fire_at: firedAt, recurrence_ms: recMs }));
        const scheduler = makeScheduler(redis);

        await scheduler.tick(NOW);

        const nextFireAt = firedAt + recMs;
        expect(redis._zset().get('sched_rec')).toBe(nextFireAt);
        const def = redis._docs()[`${R.scheduleDefPrefix}sched_rec`];
        expect(def.fire_at).toBe(nextFireAt);
        expect(def.last_fired_at).toBe(NOW);
    });

    test('missing DEF → skipped without crash, returns 0', async () => {
        const redis = makeFakeRedis();
        // Only zset entry, no DEF document
        redis._zset().set('sched_orphan', NOW - 100);
        const scheduler = makeScheduler(redis);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(0);
    });

    test('empty zset → returns 0 without errors', async () => {
        const redis = makeFakeRedis();
        const scheduler = makeScheduler(redis);
        expect(await scheduler.tick(NOW)).toBe(0);
    });

    test('multiple due entries → all fired, returns count', async () => {
        const redis = makeFakeRedis();
        seedScheduler(redis, makeDef('sched_a', { fire_at: NOW - 3000 }));
        seedScheduler(redis, makeDef('sched_b', { fire_at: NOW - 2000 }));
        seedScheduler(redis, makeDef('sched_c', { fire_at: NOW - 1000 }));
        const scheduler = makeScheduler(redis);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(3);
        expect(redis._list(R.orchRunQueuePending)).toHaveLength(3);
    });
});

describe('scheduler.tick — emit_event', () => {
    test('emit_event → relay.call with correct args', async () => {
        const redis = makeFakeRedis();
        const relay = makeRelay();
        seedScheduler(redis, makeDef('sched_ev', {
            action: { kind: 'emit_event', stream: 'EVENT:FOO', type: 'foo.happened', payload: { x: 1 } },
        }));
        const scheduler = makeScheduler(redis, relay);

        await scheduler.tick(NOW);

        expect(relay._calls).toHaveLength(1);
        const call = relay._calls[0];
        expect(call.method).toBe('event.emit');
        expect(call.params.stream).toBe('EVENT:FOO');
        expect(call.params.type).toBe('foo.happened');
        // Provenance lives in the envelope `actor`, not smuggled into payload.
        expect(call.params.actor).toBe('cron:sched_ev');
        // payload stays purely the user-defined business data (no injected fields).
        expect(call.params.payload).toEqual({ x: 1 });
        expect(call.params.payload.trigger_source).toBeUndefined();
        expect(call.params.payload.trigger_id).toBeUndefined();
        // toFix §6.2② — stable per-slot event_id (Router EVENT:DEDUP dedup key):
        // derived from schedule_id + the slot's fire time, Router EVENT_ID_RE-safe charset.
        expect(call.params.event_id).toBe(`sch-sched_ev-${NOW - 1000}`);
        expect(call.params.event_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });

    test('emit_event re-fired at the same slot re-sends the SAME event_id (dedup-able)', async () => {
        const redis = makeFakeRedis();
        const relay = makeRelay();
        seedScheduler(redis, makeDef('sched_same', {
            action: { kind: 'emit_event', stream: 'EVENT:FOO', type: 'foo.happened', payload: {} },
        }));
        const scheduler = makeScheduler(redis, relay);
        await scheduler.tick(NOW);

        const redis2 = makeFakeRedis();
        seedScheduler(redis2, makeDef('sched_same', {
            action: { kind: 'emit_event', stream: 'EVENT:FOO', type: 'foo.happened', payload: {} },
        }));
        const scheduler2 = makeScheduler(redis2, relay);
        await scheduler2.tick(NOW);   // same slot replayed (e.g. crash before ack)

        expect(relay._calls).toHaveLength(2);
        expect(relay._calls[0].params.event_id).toBe(relay._calls[1].params.event_id);
    });

    test('emit_event relay failure → tick does not throw; fire NOT counted; one-shot dropped', async () => {
        const redis = makeFakeRedis();
        const relay = makeRelay({
            async call() { throw new Error('Router unavailable'); },
        });
        seedScheduler(redis, makeDef('sched_ev_fail', {
            action: { kind: 'emit_event', stream: 'EVENT:X', type: 'x' },
        }));
        const scheduler = makeScheduler(redis, relay);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(0);                                   // the fire failed — not counted
        expect(redis._zset().has('sched_ev_fail')).toBe(false);  // one-shot: not re-added
    });

    test('emit_event failure on a RECURRING schedule → still reschedules the next occurrence (survives)', async () => {
        const redis = makeFakeRedis();
        const relay = makeRelay({
            async call() { throw new Error('registry blocked'); },
        });
        const firedAt = NOW - 500;
        const recMs = 60_000;
        seedScheduler(redis, makeDef('sched_ev_rec', {
            fire_at: firedAt, recurrence_ms: recMs,
            action: { kind: 'emit_event', stream: 'EVENT:X', type: 'x' },
        }));
        const scheduler = makeScheduler(redis, relay);

        const fired = await scheduler.tick(NOW);

        expect(fired).toBe(0);                                            // this fire failed
        expect(redis._zset().get('sched_ev_rec')).toBe(firedAt + recMs);  // but next is enqueued — schedule survives
        expect(redis._docs()[`${R.scheduleDefPrefix}sched_ev_rec`].last_fired_at).toBe(NOW);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Schedule CRUD
// ─────────────────────────────────────────────────────────────────────────────
describe('schedule CRUD', () => {
    let redis, schedule;
    beforeEach(() => {
        redis    = makeFakeRedis();
        schedule = createSchedule(redis, { config });
    });

    const baseDef = {
        schedule_id:   'daily-sweep',
        fire_at:       NOW + 3600_000,
        recurrence_ms: 86_400_000,
        action:        { kind: 'run_command', workflow_id: 'wf_sweep' },
        enabled:       true,
        owner:         'uid_admin',
    };

    test('create: stores DEF + zset entry', async () => {
        const def = await schedule.create(baseDef);
        expect(def.schedule_id).toBe('daily-sweep');
        expect(def.recurrence_ms).toBe(86_400_000);
        expect(def.last_fired_at).toBeNull();

        // DEF stored
        expect(redis._docs()[`${R.scheduleDefPrefix}daily-sweep`]).toBeTruthy();
        // zset entry
        expect(redis._zset().get('daily-sweep')).toBe(NOW + 3600_000);
    });

    test('create: rejects duplicate schedule_id', async () => {
        await schedule.create(baseDef);
        await expect(schedule.create(baseDef)).rejects.toMatchObject({ code: -32602 });
    });

    test('create: rejects missing schedule_id', async () => {
        await expect(schedule.create({ ...baseDef, schedule_id: '' })).rejects.toMatchObject({ code: -32602 });
    });

    test('create: rejects invalid fire_at', async () => {
        await expect(schedule.create({ ...baseDef, fire_at: 'tomorrow' })).rejects.toMatchObject({ code: -32602 });
    });

    test('create: rejects unknown action.kind', async () => {
        await expect(schedule.create({ ...baseDef, action: { kind: 'magic' } })).rejects.toMatchObject({ code: -32602 });
    });

    test('create: rejects emit_event without stream/type', async () => {
        await expect(schedule.create({
            ...baseDef, action: { kind: 'emit_event', stream: 'EVENT:X' }, // missing type
        })).rejects.toMatchObject({ code: -32602 });
    });

    test('get: retrieves DEF', async () => {
        await schedule.create(baseDef);
        const got = await schedule.get('daily-sweep');
        expect(got.schedule_id).toBe('daily-sweep');
    });

    test('get: NOT_FOUND for unknown id', async () => {
        await expect(schedule.get('no-such')).rejects.toMatchObject({ code: -32002 });
    });

    test('list: returns all defs sorted by fire_at', async () => {
        await schedule.create({ ...baseDef, schedule_id: 'far',  fire_at: NOW + 7_200_000 });
        await schedule.create({ ...baseDef, schedule_id: 'near', fire_at: NOW + 1_000 });
        const items = await schedule.list();
        expect(items[0].schedule_id).toBe('near');
        expect(items[1].schedule_id).toBe('far');
    });

    test('update: merges changes + re-syncs zset', async () => {
        await schedule.create(baseDef);
        const newFireAt = NOW + 9_000_000;
        const updated = await schedule.update('daily-sweep', { fire_at: newFireAt, enabled: false });
        expect(updated.fire_at).toBe(newFireAt);
        expect(updated.enabled).toBe(false);
        expect(updated.schedule_id).toBe('daily-sweep'); // immutable
        expect(redis._zset().get('daily-sweep')).toBe(newFireAt);
    });

    test('update: NOT_FOUND for unknown id', async () => {
        await expect(schedule.update('ghost', { enabled: false })).rejects.toMatchObject({ code: -32002 });
    });

    test('delete: removes DEF + zset entry', async () => {
        await schedule.create(baseDef);
        const result = await schedule.delete('daily-sweep');
        expect(result.ok).toBe(true);
        expect(redis._docs()[`${R.scheduleDefPrefix}daily-sweep`]).toBeUndefined();
        expect(redis._zset().has('daily-sweep')).toBe(false);
    });

    test('delete: NOT_FOUND for unknown id', async () => {
        await expect(schedule.delete('ghost')).rejects.toMatchObject({ code: -32002 });
    });
});

describe('scheduler.tick — runtime pause', () => {
    test('paused → fires nothing, returns 0, entry stays in zset', async () => {
        const redis = makeFakeRedis();
        seedScheduler(redis, makeDef('sched_paused', { fire_at: NOW - 500 }));
        const scheduler = createScheduler(redis, { config, relay: makeRelay(), control: { isPaused: async () => true } });
        expect(await scheduler.tick(NOW)).toBe(0);
        expect(redis._list(R.orchRunQueuePending)).toHaveLength(0);
        expect(redis._zset().has('sched_paused')).toBe(true);
    });
});
