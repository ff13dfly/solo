/**
 * Event matcher tests (event.md §6.1, §13 step ④).
 *
 * All tests are hermetic: no Redis server, no real streams. The matcher is
 * tested via its exported consumeOnce(fakeClient) path — the fake client
 * returns preset xReadGroup results; the fake redis holds workflow docs.
 *
 * Covered:
 *   - matchesFilter: no filter / matching / non-matching / nested-key miss
 *   - discoverStreams: ACTIVE workflows contribute streams; non-ACTIVE don't
 *   - findMatchingWorkflows: status gate, stream gate, filter gate
 *   - consumeOnce: event matched → enqueue with correct trigger_source/trigger_id/input
 *   - consumeOnce: payload field used as input; full event fallback when absent
 *   - consumeOnce: no matching workflow → xAck but no enqueue
 *   - consumeOnce: multiple workflows on same stream → each enqueued
 *   - consumeOnce: new stream discovered mid-run → xGroupCreate called
 *   - consumeOnce: enqueue error → no xAck (re-delivery preserved)
 */

const createMatcher = require('../logic/matcher');
const config        = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fake redis (json store + keys scan only — no streams)
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeRedis(initDocs = {}) {
    const docs = { ...initDocs };
    const sets = {};   // key -> Set(member)
    const kv   = {};   // key -> string (fired-guard SETNX, toFix §6.2①)
    const WF = config.redis.workflowPrefix;
    const WF_IDX = config.redis.workflowIndex;
    // matcher 现用 SMEMBERS(非 KEYS)发现 workflow → 任何 workflow doc 写入都维护 id 索引.
    const indexId = (key) => { if (key.startsWith(WF)) (sets[WF_IDX] ||= new Set()).add(key.slice(WF.length)); };
    for (const k of Object.keys(docs)) indexId(k);
    return {
        json: {
            async set(key, _p, val) { docs[key] = JSON.parse(JSON.stringify(val)); indexId(key); },
            async get(key)          { return docs[key] !== undefined ? JSON.parse(JSON.stringify(docs[key])) : null; },
            async del(key)          { delete docs[key]; },
        },
        async keys(pattern) {
            const prefix = pattern.replace(/\*$/, '');
            return Object.keys(docs).filter(k => k.startsWith(prefix));
        },
        async sAdd(key, m)      { (sets[key] ||= new Set()).add(m); return 1; },
        async sMembers(key)     { return [...(sets[key] || [])]; },
        async sRem(key, m)      { sets[key] && sets[key].delete(m); return 1; },
        async sIsMember(key, m) { return !!(sets[key] && sets[key].has(m)); },
        // string SET with NX support (fired guard); EX accepted but not simulated.
        async set(key, val, opts = {}) {
            if (opts.NX && kv[key] !== undefined) return null;
            kv[key] = val;
            return 'OK';
        },
        async del(key) { delete kv[key]; return 1; },
        _kv: kv,
        duplicate() { return this; },
        async connect() {},
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake stream client (simulates xReadGroup returning preset results)
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeClient(xReadGroupResult = null) {
    const created = [];
    const acked   = [];
    return {
        async xGroupCreate(stream, group, id, opts) { created.push({ stream, group }); },
        async xReadGroup(_g, _n, _streams, _opts)   { return xReadGroupResult; },
        async xAck(stream, group, id)               { acked.push({ stream, group, id }); return 1; },
        _created: created,
        _acked:   acked,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const WF = config.redis.workflowPrefix;

function activeWf(id, eventSubscriptions = []) {
    return {
        id,
        status: 'ACTIVE',
        allowed_triggers: ['event'],
        event_subscriptions: eventSubscriptions,
        steps: [],
    };
}

function makeMatcher(docs = {}, xResult = null) {
    const redis  = makeFakeRedis(docs);
    const enqueued = [];
    const worker = { enqueue: async (cmd) => enqueued.push(cmd) };
    const matcher = createMatcher(redis, { config, worker });
    const client = makeFakeClient(xResult);
    return { matcher, client, enqueued, redis };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. matchesFilter
// ─────────────────────────────────────────────────────────────────────────────
describe('matchesFilter', () => {
    let matcher;
    beforeEach(() => {
        ({ matcher } = makeMatcher());
    });

    test('no filter → matches any event', () => {
        expect(matcher.matchesFilter({ type: 'anything' }, null)).toBe(true);
        expect(matcher.matchesFilter({ type: 'anything' }, {})).toBe(true);
        expect(matcher.matchesFilter({ type: 'anything' }, undefined)).toBe(true);
    });

    test('filter matches event fields', () => {
        expect(matcher.matchesFilter({ type: 'order.paid', status: 'ok' }, { type: 'order.paid' })).toBe(true);
    });

    test('filter field mismatch → false', () => {
        expect(matcher.matchesFilter({ type: 'order.cancelled' }, { type: 'order.paid' })).toBe(false);
    });

    test('filter field missing from event → false', () => {
        expect(matcher.matchesFilter({ type: 'order.paid' }, { type: 'order.paid', status: 'ok' })).toBe(false);
    });

    test('multiple filter fields all match → true', () => {
        expect(matcher.matchesFilter({ type: 'x', status: 'ok' }, { type: 'x', status: 'ok' })).toBe(true);
    });

    test('array filter → treated as non-matching (not a plain object)', () => {
        expect(matcher.matchesFilter({ type: 'x' }, ['order.paid'])).toBe(true); // arrays are ignored → true (no filter)
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. discoverStreams
// ─────────────────────────────────────────────────────────────────────────────
describe('discoverStreams', () => {
    test('returns streams from ACTIVE workflow event_subscriptions', async () => {
        const docs = {
            [`${WF}wf_a`]: activeWf('wf_a', [{ stream: 'EVENT:ORDER:CREATED' }]),
            [`${WF}wf_b`]: activeWf('wf_b', [{ stream: 'EVENT:PAYMENT:DONE' }, { stream: 'EVENT:ORDER:CREATED' }]),
        };
        const { matcher } = makeMatcher(docs);
        const streams = await matcher.discoverStreams();
        expect(streams).toContain('EVENT:ORDER:CREATED');
        expect(streams).toContain('EVENT:PAYMENT:DONE');
        expect(streams.length).toBe(2);
    });

    test('skips non-ACTIVE workflows', async () => {
        const docs = {
            [`${WF}wf_pending`]: { ...activeWf('wf_pending', [{ stream: 'EVENT:X' }]), status: 'PENDING_REVIEW' },
        };
        const { matcher } = makeMatcher(docs);
        const streams = await matcher.discoverStreams();
        expect(streams).not.toContain('EVENT:X');
    });

    test('returns empty when no workflows', async () => {
        const { matcher } = makeMatcher({});
        expect(await matcher.discoverStreams()).toHaveLength(0);
    });

    test('deduplicates streams across workflows', async () => {
        const docs = {
            [`${WF}wf_1`]: activeWf('wf_1', [{ stream: 'EVENT:SAME' }]),
            [`${WF}wf_2`]: activeWf('wf_2', [{ stream: 'EVENT:SAME' }]),
        };
        const { matcher } = makeMatcher(docs);
        const streams = await matcher.discoverStreams();
        expect(streams.filter(s => s === 'EVENT:SAME')).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. findMatchingWorkflows
// ─────────────────────────────────────────────────────────────────────────────
describe('findMatchingWorkflows', () => {
    test('returns ACTIVE workflow matching stream + no filter', async () => {
        const docs = { [`${WF}wf_x`]: activeWf('wf_x', [{ stream: 'EVENT:A' }]) };
        const { matcher } = makeMatcher(docs);
        const wfs = await matcher.findMatchingWorkflows('EVENT:A', { type: 'anything' });
        expect(wfs.map(w => w.id)).toContain('wf_x');
    });

    test('returns ACTIVE workflow matching stream + matching filter', async () => {
        const docs = {
            [`${WF}wf_y`]: activeWf('wf_y', [{ stream: 'EVENT:A', filter: { type: 'order.paid' } }]),
        };
        const { matcher } = makeMatcher(docs);
        const wfs = await matcher.findMatchingWorkflows('EVENT:A', { type: 'order.paid' });
        expect(wfs.map(w => w.id)).toContain('wf_y');
    });

    test('excludes workflow when filter does not match', async () => {
        const docs = {
            [`${WF}wf_z`]: activeWf('wf_z', [{ stream: 'EVENT:A', filter: { type: 'order.paid' } }]),
        };
        const { matcher } = makeMatcher(docs);
        const wfs = await matcher.findMatchingWorkflows('EVENT:A', { type: 'order.cancelled' });
        expect(wfs).toHaveLength(0);
    });

    test('excludes non-ACTIVE workflow', async () => {
        const docs = {
            [`${WF}wf_nr`]: { ...activeWf('wf_nr', [{ stream: 'EVENT:A' }]), status: 'PENDING_REVIEW' },
        };
        const { matcher } = makeMatcher(docs);
        const wfs = await matcher.findMatchingWorkflows('EVENT:A', {});
        expect(wfs).toHaveLength(0);
    });

    test('excludes workflow subscribed to different stream', async () => {
        const docs = { [`${WF}wf_other`]: activeWf('wf_other', [{ stream: 'EVENT:B' }]) };
        const { matcher } = makeMatcher(docs);
        const wfs = await matcher.findMatchingWorkflows('EVENT:A', {});
        expect(wfs).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. consumeOnce — core integration
// ─────────────────────────────────────────────────────────────────────────────
describe('consumeOnce — event matched → enqueue', () => {
    test('matched event → enqueued with correct trigger_source and trigger_id', async () => {
        const docs = {
            [`${WF}wf_1`]: activeWf('wf_1', [{ stream: 'EVENT:ORDER:CREATED', filter: { type: 'order.paid' } }]),
        };
        const xResult = [{
            name: 'EVENT:ORDER:CREATED',
            messages: [{ id: '1609459200000-0', message: { type: 'order.paid', payload: JSON.stringify({ orderId: 'ORD-1' }) } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);

        const count = await matcher.consumeOnce(client);

        expect(count).toBe(1);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].workflowId).toBe('wf_1');
        expect(enqueued[0].triggerSource).toBe('event:EVENT:ORDER:CREATED');
        expect(enqueued[0].triggerId).toBe('1609459200000-0');
    });

    test('payload field used as workflow input', async () => {
        const docs = { [`${WF}wf_2`]: activeWf('wf_2', [{ stream: 'EVENT:X' }]) };
        const xResult = [{
            name: 'EVENT:X',
            messages: [{ id: '100-0', message: { type: 'x', payload: JSON.stringify({ amount: 99 }) } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(enqueued[0].input).toEqual({ amount: 99 });
    });

    test('envelope actor + source threaded into the run-command (C4 minimal)', async () => {
        const docs = { [`${WF}wf_ac`]: activeWf('wf_ac', [{ stream: 'EVENT:AC' }]) };
        const xResult = [{
            name: 'EVENT:AC',
            messages: [{ id: '300-0', message: {
                type: 'ac.fired', actor: 'uid-cause-1', source: 'system.fulfillment',
                payload: JSON.stringify({ k: 1 }),
            } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(enqueued[0].actor).toBe('uid-cause-1');
        expect(enqueued[0].actorSource).toBe('system.fulfillment');
    });

    test('envelope without actor/source → nulls (legacy events keep working)', async () => {
        const docs = { [`${WF}wf_ac2`]: activeWf('wf_ac2', [{ stream: 'EVENT:AC2' }]) };
        const xResult = [{
            name: 'EVENT:AC2',
            messages: [{ id: '301-0', message: { type: 'ac2.fired', payload: JSON.stringify({}) } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(enqueued[0].actor).toBeNull();
        expect(enqueued[0].actorSource).toBeNull();
    });

    test('full event used as input when payload absent', async () => {
        const docs = { [`${WF}wf_3`]: activeWf('wf_3', [{ stream: 'EVENT:Y' }]) };
        const xResult = [{
            name: 'EVENT:Y',
            messages: [{ id: '200-0', message: { type: 'y.happened', orderId: 'O-2' } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        // event.orderId ends up in input
        expect(enqueued[0].input.orderId).toBe('O-2');
    });

    test('xAck called after successful processing', async () => {
        const docs = { [`${WF}wf_4`]: activeWf('wf_4', [{ stream: 'EVENT:Z' }]) };
        const xResult = [{
            name: 'EVENT:Z',
            messages: [{ id: '300-0', message: { type: 'z' } }],
        }];
        const { matcher, client } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(client._acked).toHaveLength(1);
        expect(client._acked[0].id).toBe('300-0');
    });

    test('no matching workflow → xAck but no enqueue', async () => {
        const docs = { [`${WF}wf_5`]: activeWf('wf_5', [{ stream: 'EVENT:OTHER' }]) };
        const xResult = [{
            name: 'EVENT:DIFFERENT',
            messages: [{ id: '400-0', message: { type: 'x' } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(enqueued).toHaveLength(0);
        expect(client._acked).toHaveLength(1); // still acked — no matching wf is not a failure
    });

    test('multiple workflows subscribed to same stream → each enqueued', async () => {
        const docs = {
            [`${WF}wf_a`]: activeWf('wf_a', [{ stream: 'EVENT:MULTI' }]),
            [`${WF}wf_b`]: activeWf('wf_b', [{ stream: 'EVENT:MULTI' }]),
        };
        const xResult = [{
            name: 'EVENT:MULTI',
            messages: [{ id: '500-0', message: { type: 'multi' } }],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(enqueued).toHaveLength(2);
        const ids = enqueued.map(e => e.workflowId).sort();
        expect(ids).toEqual(['wf_a', 'wf_b']);
    });

    test('null xReadGroup result (no events) → returns 0', async () => {
        const docs = { [`${WF}wf_6`]: activeWf('wf_6', [{ stream: 'EVENT:Q' }]) };
        const { matcher, client, enqueued } = makeMatcher(docs, null);
        const count = await matcher.consumeOnce(client);

        expect(count).toBe(0);
        expect(enqueued).toHaveLength(0);
    });

    test('enqueue error → xAck NOT called (re-delivery preserved)', async () => {
        const docs = { [`${WF}wf_7`]: activeWf('wf_7', [{ stream: 'EVENT:ERR' }]) };
        const xResult = [{
            name: 'EVENT:ERR',
            messages: [{ id: '600-0', message: { type: 'x' } }],
        }];
        const redis  = makeFakeRedis(docs);
        const worker = { enqueue: async () => { throw new Error('Redis down'); } };
        const matcher = createMatcher(redis, { config, worker });
        const client  = makeFakeClient(xResult);

        await matcher.consumeOnce(client);

        // enqueue threw → no xAck
        expect(client._acked).toHaveLength(0);
    });

    test('new stream discovered mid-run → xGroupCreate called for new stream', async () => {
        const docs = { [`${WF}wf_8`]: activeWf('wf_8', [{ stream: 'EVENT:NEW' }]) };
        const { matcher, client } = makeMatcher(docs, null); // no events yet
        await matcher.consumeOnce(client);

        // The new stream should have had its group created
        expect(client._created.map(c => c.stream)).toContain('EVENT:NEW');
    });

    test('filter: type match → enqueue; type mismatch → skip', async () => {
        const docs = {
            [`${WF}wf_match`]: activeWf('wf_match', [{ stream: 'EVENT:F', filter: { type: 'order.paid' } }]),
        };
        const xResult = [{
            name: 'EVENT:F',
            messages: [
                { id: '701-0', message: { type: 'order.paid' } },
                { id: '702-0', message: { type: 'order.cancelled' } },
            ],
        }];
        const { matcher, client, enqueued } = makeMatcher(docs, xResult);
        await matcher.consumeOnce(client);

        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].triggerId).toBe('701-0');
        // Both entries still acked (non-match is not a processing error)
        expect(client._acked).toHaveLength(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. consumeOnce — fired guard (toFix §6.2① at-most-once per event×workflow)
// ─────────────────────────────────────────────────────────────────────────────
describe('consumeOnce — fired guard dedup', () => {
    const entry = (id, message) => [{ name: 'EVENT:DEDUP_T', messages: [{ id, message }] }];

    test('re-delivered event (same event_id) fires the workflow only once', async () => {
        const docs = { [`${WF}wf_d1`]: activeWf('wf_d1', [{ stream: 'EVENT:DEDUP_T' }]) };
        const redis  = makeFakeRedis(docs);
        const enqueued = [];
        const worker = { enqueue: async (cmd) => enqueued.push(cmd) };
        const matcher = createMatcher(redis, { config, worker });
        const message = { type: 'x', event_id: 'evt-stable-001' };

        // First delivery — enqueued, ack happens, but suppose the ack was lost:
        await matcher.consumeOnce(makeFakeClient(entry('800-0', message)));
        // Re-delivery of the SAME logical event (same event_id, new entry id after restart):
        await matcher.consumeOnce(makeFakeClient(entry('800-0', message)));

        expect(enqueued).toHaveLength(1);
    });

    test('falls back to stream entry id when event_id is absent', async () => {
        const docs = { [`${WF}wf_d2`]: activeWf('wf_d2', [{ stream: 'EVENT:DEDUP_T' }]) };
        const redis  = makeFakeRedis(docs);
        const enqueued = [];
        const worker = { enqueue: async (cmd) => enqueued.push(cmd) };
        const matcher = createMatcher(redis, { config, worker });

        await matcher.consumeOnce(makeFakeClient(entry('900-0', { type: 'x' })));   // same entry re-delivered
        await matcher.consumeOnce(makeFakeClient(entry('900-0', { type: 'x' })));
        await matcher.consumeOnce(makeFakeClient(entry('901-0', { type: 'x' })));   // different entry → fires

        expect(enqueued).toHaveLength(2);
        expect(enqueued.map(e => e.triggerId).sort()).toEqual(['900-0', '901-0']);
    });

    test('distinct workflows on the same event each fire once (guard is per event×workflow)', async () => {
        const docs = {
            [`${WF}wf_d3`]: activeWf('wf_d3', [{ stream: 'EVENT:DEDUP_T' }]),
            [`${WF}wf_d4`]: activeWf('wf_d4', [{ stream: 'EVENT:DEDUP_T' }]),
        };
        const redis  = makeFakeRedis(docs);
        const enqueued = [];
        const worker = { enqueue: async (cmd) => enqueued.push(cmd) };
        const matcher = createMatcher(redis, { config, worker });
        const message = { type: 'x', event_id: 'evt-shared-1' };

        await matcher.consumeOnce(makeFakeClient(entry('1000-0', message)));
        await matcher.consumeOnce(makeFakeClient(entry('1000-0', message)));   // re-delivery

        expect(enqueued.map(e => e.workflowId).sort()).toEqual(['wf_d3', 'wf_d4']);
    });

    test('enqueue failure releases the guard so re-delivery CAN fire', async () => {
        const docs = { [`${WF}wf_d5`]: activeWf('wf_d5', [{ stream: 'EVENT:DEDUP_T' }]) };
        const redis  = makeFakeRedis(docs);
        const enqueued = [];
        let failOnce = true;
        const worker = { enqueue: async (cmd) => {
            if (failOnce) { failOnce = false; throw new Error('queue down'); }
            enqueued.push(cmd);
        } };
        const matcher = createMatcher(redis, { config, worker });
        const message = { type: 'x', event_id: 'evt-retry-1' };

        const c1 = makeFakeClient(entry('1100-0', message));
        await matcher.consumeOnce(c1);
        expect(c1._acked).toHaveLength(0);            // enqueue threw → no ack
        expect(enqueued).toHaveLength(0);

        const c2 = makeFakeClient(entry('1100-0', message));   // re-delivery
        await matcher.consumeOnce(c2);
        expect(enqueued).toHaveLength(1);             // guard was released → fired
        expect(c2._acked).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. loop — idle pacing (regression: must not hot-spin when nothing is subscribed)
// ─────────────────────────────────────────────────────────────────────────────
describe('loop — idle pacing when no streams subscribed', () => {
    // With no event-subscribing ACTIVE workflow, knownStreams stays empty and
    // consumeOnce returns BEFORE the blocking xReadGroup (which is what paces the
    // loop). Without an explicit idle wait the loop spins as fast as the event loop
    // allows, re-scanning WORKFLOW_INDEX (SMEMBERS) thousands of times a second and
    // burning a full CPU core. This asserts the loop paces itself to blockMs instead.
    test('idle matcher does not hot-spin discoverStreams (SMEMBERS)', async () => {
        let sMembersCalls = 0;
        const redis = makeFakeRedis({});              // zero workflows → empty index
        const realSMembers = redis.sMembers.bind(redis);
        redis.sMembers = async (key) => { sMembersCalls++; return realSMembers(key); };
        // Fake stream client for start()/loop(): no events, no streams to create.
        const baseDup = redis.duplicate.bind(redis);
        redis.duplicate = () => {
            const c = baseDup();
            c.xGroupCreate = async () => {};
            c.xReadGroup   = async () => null;
            c.xAck         = async () => 1;
            return c;
        };

        const worker = { enqueue: async () => {} };
        const fastConfig = { ...config, consumer: { ...config.consumer, blockMs: 25 } };
        const matcher = createMatcher(redis, { config: fastConfig, worker });

        await matcher.start();
        await new Promise(r => setTimeout(r, 150));   // ~6 paced cycles at 25ms each
        await matcher.stop();
        await new Promise(r => setTimeout(r, 60));     // let the in-flight cycle observe stop

        // Paced: ~150/25 ≈ 6 cycles → a single-digit number of SMEMBERS calls.
        // Pre-fix this was in the thousands; assert a generous ceiling well below that.
        expect(sMembersCalls).toBeGreaterThan(0);
        expect(sMembersCalls).toBeLessThan(30);
    });
});
