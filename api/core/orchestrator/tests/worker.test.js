/**
 * Async run-queue worker — event.md §5.
 *
 * Drives logic/worker.js directly with an in-memory fake redis (lists + zsets),
 * a fake relay (bot token), and a fake runner. No real Redis, no HTTP.
 *
 * Covered:
 *   - enqueue pushes a normalized run-command onto PENDING
 *   - processOne runs the workflow under the bot identity (callerUid, headers)
 *   - runner RETURNS (completed/failed) → ack, no requeue (no re-run of side effects)
 *   - runner THROWS transient (INTERNAL_ERROR) → retry zset with backoff
 *   - runner THROWS permanent (FORBIDDEN gate) → straight to deadletter, no retry
 *   - retries escalate to deadletter after maxRetries
 *   - promoteDueRetries moves due entries back to pending
 *   - no bot token → retryable (not deadletter)
 *   - actor-claim (C4 minimal): cmd actor/actorSource → runner actorClaim; nulls when absent
 *   - permanent rejection / exhausted retries also close the run ENTITY as DEADLETTER
 */
const createWorker = require('../logic/worker');
const config = require('../config');

const R = config.redis;
const W = config.worker;

function makeFakeRedis() {
    const lists = {};   // key -> array (index 0 = head, matches lPush/blPop semantics)
    const zsets = {};   // key -> Map(value -> score)
    const docs  = {};   // key -> JSON doc (workflow docs, for the cooling check)

    const api = {
        duplicate() { return api; },
        async connect() {},
        async lPush(key, val) { (lists[key] ||= []).unshift(val); return lists[key].length; },
        async lTrim(key, start, stop) {
            const a = lists[key] || [];
            const end = stop === -1 ? a.length : stop + 1;
            lists[key] = a.slice(start < 0 ? Math.max(0, a.length + start) : start, end);
            return 'OK';
        },
        async rPop(key) { const a = lists[key] || []; return a.length ? a.pop() : null; },
        async blPop(key /*, timeout */) {
            const a = lists[key] || [];
            // synchronous fake: return head if present, else null (no real blocking)
            return a.length ? { key, element: a.shift() } : null;
        },
        async zAdd(key, { score, value }) { (zsets[key] ||= new Map()).set(value, score); return 1; },
        async zRem(key, value) { const m = zsets[key]; if (m && m.has(value)) { m.delete(value); return 1; } return 0; },
        async zRangeByScore(key, min, max) {
            const m = zsets[key] || new Map();
            return [...m.entries()].filter(([, s]) => s >= min && s <= max).map(([v]) => v);
        },
        // JSON docs — the worker reads the workflow to tell "too early" (cooling) from
        // "permanently rejected". Absent by default, so the pre-existing permanent-rejection
        // tests keep exercising the fail-safe path (unreadable workflow ⇒ treat as permanent).
        json: {
            async get(key) { return docs[key] !== undefined ? JSON.parse(JSON.stringify(docs[key])) : null; },
            async set(key, _p, val) { docs[key] = JSON.parse(JSON.stringify(val)); },
        },
        // test helpers
        _list(key) { return lists[key] || []; },
        _zset(key) { return zsets[key] || new Map(); },
        _setWorkflow(id, doc) { docs[`${R.workflowPrefix}${id}`] = doc; },
    };
    return api;
}

const fakeRelay = { async getToken() { return 'bot-token-xyz'; } };

function makeWorker(redis, { runFn, relay = fakeRelay } = {}) {
    const runner = { run: runFn };
    return createWorker(redis, { relay, runner });
}

describe('worker.enqueue', () => {
    test('normalizes and pushes a run-command onto PENDING', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({ status: 'completed' }) });

        const cmd = await worker.enqueue({ workflowId: 'wf_1', triggerSource: 'event:EVENT:X', triggerId: 'e1' });

        expect(cmd.workflowId).toBe('wf_1');
        expect(cmd.attempts).toBe(0);
        expect(typeof cmd.enqueuedAt).toBe('number');
        const pending = redis._list(R.runQueuePending);
        expect(pending).toHaveLength(1);
        expect(JSON.parse(pending[0]).workflowId).toBe('wf_1');
    });

    test('requires workflowId', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({}) });
        await expect(worker.enqueue({})).rejects.toThrow(/workflowId/);
    });

    test('actor-claim fields survive normalization (C4 minimal thread)', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({}) });

        const cmd = await worker.enqueue({
            workflowId: 'wf_1', triggerSource: 'event:EVENT:X', triggerId: 'e1',
            actor: 'uid-cause-1', actorSource: 'system.fulfillment',
        });
        expect(cmd.actor).toBe('uid-cause-1');
        expect(cmd.actorSource).toBe('system.fulfillment');

        // absent → null (legacy enqueues unchanged)
        const bare = await worker.enqueue({ workflowId: 'wf_2', triggerSource: 'sync' });
        expect(bare.actor).toBeNull();
        expect(bare.actorSource).toBeNull();
    });
});

describe('worker.processOne — execution under bot identity', () => {
    test('passes bot uid + bearer headers to runner; success acks', async () => {
        const redis = makeFakeRedis();
        let seen;
        const worker = makeWorker(redis, {
            runFn: async (args, headers, callerUid) => { seen = { args, headers, callerUid }; return { status: 'completed' }; },
        });

        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_a', input: { x: 1 }, triggerSource: 'cron:nightly', triggerId: 't1' }));

        expect(seen.callerUid).toBe(W.botUid);
        expect(seen.headers.authorization).toBe('Bearer bot-token-xyz');
        expect(seen.args).toMatchObject({ workflowId: 'wf_a', input: { x: 1 }, triggerSource: 'cron:nightly', triggerId: 't1' });
        // acked: nothing left in any queue
        expect(redis._list(R.runQueuePending)).toHaveLength(0);
        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
    });

    test('cmd actor/actorSource reach runner as actorClaim; absent → null (C4 minimal)', async () => {
        const redis = makeFakeRedis();
        const seen = [];
        const worker = makeWorker(redis, {
            runFn: async (args) => { seen.push(args.actorClaim); return { status: 'completed' }; },
        });

        await worker.processOne(redis, JSON.stringify({
            workflowId: 'wf_ac', triggerSource: 'event:EVENT:X',
            actor: 'uid-cause-1', actorSource: 'system.fulfillment',
        }));
        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_ac2', triggerSource: 'event:EVENT:X' }));

        expect(seen[0]).toEqual({ actor: 'uid-cause-1', source: 'system.fulfillment' });
        expect(seen[1]).toBeNull();
    });

    test('runner returns failed status → ack, NOT requeued (no re-run of side effects)', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({ status: 'failed', failedStep: 's2' }) });

        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_b', triggerSource: 'event' }));

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
    });
});

describe('worker.processOne — error handling', () => {
    test('transient throw (INTERNAL_ERROR) → retry zset with backoff', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, {
            runFn: async () => { const e = new Error('permit service down'); e.code = -32603; throw e; },
        });

        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_c', triggerSource: 'event', attempts: 0 }));

        expect(redis._zset(R.runQueueRetry).size).toBe(1);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
        const [value, score] = [...redis._zset(R.runQueueRetry).entries()][0];
        expect(JSON.parse(value).attempts).toBe(1);
        expect(score).toBeGreaterThan(Date.now());
    });

    test('permanent throw (FORBIDDEN gate) → straight to deadletter, no retry', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, {
            runFn: async () => { const e = new Error('Trigger not allowed'); e.code = -32005; throw e; },
        });

        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_d', triggerSource: 'event', attempts: 0 }));

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        const dl = redis._list(R.runQueueDeadletter);
        expect(dl).toHaveLength(1);
        expect(JSON.parse(dl[0]).lastCode).toBe(-32005);
    });

    test('transient retries escalate to deadletter at maxRetries', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, {
            runFn: async () => { const e = new Error('still down'); e.code = -32603; throw e; },
        });

        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_e', triggerSource: 'event', attempts: W.maxRetries - 1 }));

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
    });

    test('no bot token → retryable (not deadletter)', async () => {
        const redis = makeFakeRedis();
        const badRelay = { async getToken() { throw new Error('NO_TOKEN'); } };
        const worker = makeWorker(redis, { runFn: async () => ({ status: 'completed' }), relay: badRelay });

        await worker.processOne(redis, JSON.stringify({ workflowId: 'wf_f', triggerSource: 'event', attempts: 0 }));

        expect(redis._zset(R.runQueueRetry).size).toBe(1);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
    });

    test('permanent rejection closes out the run entity as DEADLETTER (no RUNNING orphan)', async () => {
        const redis = makeFakeRedis();
        const deadlettered = [];
        const run = {
            create: async () => {}, getGrant: async () => null, done: async () => {},
            deadletter: async (id, d) => { deadlettered.push({ id, ...d }); },
        };
        const worker = createWorker(redis, {
            relay: fakeRelay,
            runner: { run: async () => { const e = new Error('require_actor_permit: actor lacks methods'); e.code = -32005; throw e; } },
            run,
        });

        await worker.processOne(redis, JSON.stringify({ runId: 'run_dead1', workflowId: 'wf_g', triggerSource: 'event', attempts: 0 }));

        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
        // The run doc is flipped too — otherwise it lingers RUNNING until the stall
        // scanner fires a false "worker died mid-run" ops alert.
        expect(deadlettered).toEqual([{ id: 'run_dead1', error: 'require_actor_permit: actor lacks methods' }]);
    });

    test('retries exhausted closes out the run entity as DEADLETTER too', async () => {
        const redis = makeFakeRedis();
        const deadlettered = [];
        const run = {
            create: async () => {}, getGrant: async () => null, done: async () => {},
            deadletter: async (id, d) => { deadlettered.push({ id, ...d }); },
        };
        const worker = createWorker(redis, {
            relay: fakeRelay,
            runner: { run: async () => { const e = new Error('still down'); e.code = -32603; throw e; } },
            run,
        });

        await worker.processOne(redis, JSON.stringify({ runId: 'run_dead2', workflowId: 'wf_h', triggerSource: 'event', attempts: W.maxRetries - 1 }));

        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
        expect(deadlettered).toEqual([{ id: 'run_dead2', error: 'still down' }]);
    });

    test('isRetryable: non-jsonrpc errors are transient, gate codes are not', () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({}) });
        expect(worker.isRetryable(new Error('boom'))).toBe(true);          // no code
        expect(worker.isRetryable({ code: -32603 })).toBe(true);           // INTERNAL_ERROR
        expect(worker.isRetryable({ code: -32005 })).toBe(false);          // FORBIDDEN
        expect(worker.isRetryable({ code: -32602 })).toBe(false);          // INVALID_PARAMS
    });
});

describe('worker.promoteDueRetries', () => {
    test('moves due retry entries back to pending; leaves future ones', async () => {
        const redis = makeFakeRedis();
        const worker = makeWorker(redis, { runFn: async () => ({}) });

        const due = JSON.stringify({ workflowId: 'wf_due', attempts: 1 });
        const future = JSON.stringify({ workflowId: 'wf_future', attempts: 1 });
        await redis.zAdd(R.runQueueRetry, { score: Date.now() - 1000, value: due });
        await redis.zAdd(R.runQueueRetry, { score: Date.now() + 60000, value: future });

        await worker.promoteDueRetries(redis);

        expect(redis._list(R.runQueuePending)).toContain(due);
        expect(redis._zset(R.runQueueRetry).size).toBe(1);   // future still parked
        expect([...redis._zset(R.runQueueRetry).keys()]).toContain(future);
    });
});

describe('worker.handleNeedsGrant — auto→human seam', () => {
    const { NeedsGrantError } = require('../logic/NeedsGrantError');

    test('on NeedsGrant: pauses the run, emits NEEDS_GRANT, AND notifies the ops inbox', async () => {
        const redis = makeFakeRedis();
        const calls = [];
        const relay = { async getToken() { return 't'; }, async call(method, params) { calls.push({ method, params }); } };
        const paused = [];
        const run = {
            create: async () => {}, getGrant: async () => null, done: async () => {},
            pause: async (id, d) => { paused.push({ id, ...d }); },
        };
        const worker = createWorker(redis, {
            relay,
            runner: { run: async () => { throw new NeedsGrantError(['gateway.email.send']); } },
            run,
        });

        await worker.processOne(redis, JSON.stringify({ runId: 'run_1', workflowId: 'wf1', triggerSource: 'event' }));

        // run persisted as paused-awaiting-human
        expect(paused).toEqual([{ id: 'run_1', missingMethods: ['gateway.email.send'] }]);
        // a human is pulled in via the ops inbox (not just polling)
        const notify = calls.find((c) => c.method === 'notification.send');
        expect(notify).toBeTruthy();
        expect(notify.params.targetId).toBe(config.opsInbox);
        expect(notify.params.type).toBe('ops.needs_grant');
        expect(notify.params.payload.runId).toBe('run_1');
        expect(notify.params.payload.missingMethods).toEqual(['gateway.email.send']);
        expect(notify.params.ref).toBe('needs_grant:run_1');
    });

    test('notify failure is fail-soft — the pause still happens', async () => {
        const redis = makeFakeRedis();
        const paused = [];
        const relay = { async getToken() { return 't'; }, async call() { throw new Error('router down'); } };
        const run = { create: async () => {}, getGrant: async () => null, done: async () => {}, pause: async (id, d) => paused.push({ id, ...d }) };
        const worker = createWorker(redis, { relay, runner: { run: async () => { throw new NeedsGrantError(['x.y.do']); } }, run });

        await expect(worker.processOne(redis, JSON.stringify({ runId: 'run_2', workflowId: 'wf2' }))).resolves.toBeUndefined();
        expect(paused).toEqual([{ id: 'run_2', missingMethods: ['x.y.do'] }]); // pause survived the notify failure
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cooling period — "too early" is not "rejected"
// docs/feedback/done/event-triggered-workflow-lifecycle-drops-events.md §一/§二
//
// A high-risk workflow goes ACTIVE with effective_at = now + 24h, and runner.js rejects
// with FORBIDDEN until then. FORBIDDEN is not retryable, so every genuine trigger inside
// that window used to be dead-lettered with attempts:0 — i.e. every event for a day after
// any rollout, silently. The criterion that separates the two kinds of "no": a rejection
// that names WHEN it stops applying is not permanent.
// ─────────────────────────────────────────────────────────────────────────────
describe('worker.handleThrown — cooling period defers instead of dead-lettering', () => {
    const coolingErr = () => { const e = new Error('Workflow in cooling period until 2026-09-06T02:02:19.498Z'); e.code = -32005; throw e; };

    function coolingWorker(redis, { effectiveAt, run = null } = {}) {
        redis._setWorkflow('wf_cw', { id: 'wf_cw', status: 'ACTIVE', effective_at: effectiveAt });
        return createWorker(redis, { relay: fakeRelay, runner: { run: coolingErr }, run });
    }

    test('defers to the RETRY zset at effective_at — not the deadletter queue', async () => {
        const redis = makeFakeRedis();
        const until = Date.now() + 60_000;
        const worker = coolingWorker(redis, { effectiveAt: until });

        await worker.processOne(redis, JSON.stringify({ runId: 'r1', workflowId: 'wf_cw', triggerSource: 'event:EVENT:D', triggerId: '1-1', attempts: 0 }));

        expect(redis._list(R.runQueueDeadletter)).toHaveLength(0);
        const zset = redis._zset(R.runQueueRetry);
        expect(zset.size).toBe(1);
        const [value, score] = [...zset.entries()][0];
        // Fires at effective_at (+ up to 1s of jitter so a burst does not wake in lockstep).
        expect(score).toBeGreaterThanOrEqual(until);
        expect(score).toBeLessThan(until + 1000);
        const cmd = JSON.parse(value);
        expect(cmd.coolingDefers).toBe(1);
        // The whole point: the exponential-backoff budget is untouched. Counting cooling
        // against maxRetries would burn all 5 attempts inside the window and dead-letter
        // the event anyway — the bug this fix exists to remove.
        expect(cmd.attempts).toBe(0);
        // trigger identity preserved → the eventual run dedups downstream exactly as it would have
        expect(cmd).toMatchObject({ runId: 'r1', triggerSource: 'event:EVENT:D', triggerId: '1-1' });
    });

    test('marks the run DEFERRED_COOLING so the stall scanner leaves it alone', async () => {
        const redis = makeFakeRedis();
        const deferred = [];
        const run = {
            create: async () => {}, getGrant: async () => null, done: async () => {},
            deadletter: async () => { throw new Error('should not deadletter'); },
            defer: async (id, d) => { deferred.push({ id, ...d }); },
        };
        const until = Date.now() + 60_000;
        const worker = coolingWorker(redis, { effectiveAt: until, run });

        await worker.processOne(redis, JSON.stringify({ runId: 'r2', workflowId: 'wf_cw', triggerSource: 'event', attempts: 0 }));

        // Left RUNNING it would be flipped STALLED in 10 minutes and page ops with a
        // false "worker died mid-run" story.
        expect(deferred).toHaveLength(1);
        expect(deferred[0]).toMatchObject({ id: 'r2', until });
    });

    test('cooling already over → normal permanent handling (no defer loop)', async () => {
        const redis = makeFakeRedis();
        const worker = coolingWorker(redis, { effectiveAt: Date.now() - 1000 });

        await worker.processOne(redis, JSON.stringify({ runId: 'r3', workflowId: 'wf_cw', triggerSource: 'event', attempts: 0 }));

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
    });

    test('a FORBIDDEN that is NOT cooling still dead-letters (footprint, DEPRECATED, …)', async () => {
        const redis = makeFakeRedis();
        redis._setWorkflow('wf_perm', { id: 'wf_perm', status: 'ACTIVE', effective_at: null });
        const worker = createWorker(redis, {
            relay: fakeRelay,
            runner: { run: async () => { const e = new Error('footprint violation'); e.code = -32005; throw e; } },
        });

        await worker.processOne(redis, JSON.stringify({ runId: 'r4', workflowId: 'wf_perm', triggerSource: 'event', attempts: 0 }));

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
    });

    test('defer cap reached → dead-letters (a workflow whose effective_at keeps moving)', async () => {
        const redis = makeFakeRedis();
        const worker = coolingWorker(redis, { effectiveAt: Date.now() + 60_000 });

        await worker.processOne(redis, JSON.stringify({
            runId: 'r5', workflowId: 'wf_cw', triggerSource: 'event', attempts: 0,
            coolingDefers: W.maxCoolingDefers,
        }));

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
    });

    test('unreadable workflow → fail SAFE (permanent), never an infinite defer', async () => {
        const redis = makeFakeRedis();
        redis.json.get = async () => { throw new Error('redis down'); };
        const worker = createWorker(redis, { relay: fakeRelay, runner: { run: coolingErr } });

        await worker.processOne(redis, JSON.stringify({ runId: 'r6', workflowId: 'wf_cw', triggerSource: 'event', attempts: 0 }));

        expect(redis._list(R.runQueueDeadletter)).toHaveLength(1);
    });

    test('promoteDueRetries brings a deferred command back once effective_at passes', async () => {
        const redis = makeFakeRedis();
        const worker = coolingWorker(redis, { effectiveAt: Date.now() - 5_000 });
        // Seed the zset directly with a due deferral (as the defer path would have written it).
        await redis.zAdd(R.runQueueRetry, {
            score: Date.now() - 1,
            value: JSON.stringify({ runId: 'r7', workflowId: 'wf_cw', triggerSource: 'event', attempts: 0, coolingDefers: 1 }),
        });

        await worker.promoteDueRetries(redis);

        expect(redis._zset(R.runQueueRetry).size).toBe(0);
        expect(redis._list(R.runQueuePending)).toHaveLength(1);
        expect(JSON.parse(redis._list(R.runQueuePending)[0]).runId).toBe('r7');
    });
});
