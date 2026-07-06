/**
 * aml-cleanup.test.js — hermetic guard for the 101 suite's teardown.
 *
 * The danger with cleanup is OVER-deletion: a too-broad pattern (or a wrong key template)
 * that nukes a sibling suite's keys, a shared index member, or a framework config key.
 * These tests seed BOTH "mine" (the suite's scope) and "bystander" keys (another pid, the
 * shared EVENT_REGISTRY, foreign members inside shared sets/indexes), run cleanup, and assert
 * EVERY mine-key is gone and EVERY bystander survives. No real Redis, no stack.
 */
const { cleanupAmlPipeline } = require('./aml-cleanup');

// Faithful-enough fake: string / RedisJSON / set / zset stores. del() removes a key from
// whichever store holds it. Only the surface cleanup actually calls is implemented.
function makeFakeRedis() {
    const kv = new Map();      // strings
    const jsonKv = new Map();  // RedisJSON docs
    const sets = new Map();    // key -> Set<string>
    const zsets = new Map();   // key -> string[]  (membership only; order irrelevant here)
    const ensureSet = (k) => sets.get(k) || sets.set(k, new Set()).get(k);
    return {
        // ── test-only seed / inspect helpers ──
        _has: (k) => kv.has(k) || jsonKv.has(k) || sets.has(k) || zsets.has(k),
        _str: (k) => (kv.has(k) ? kv.get(k) : null),
        _members: (k) => [...(sets.get(k) || [])].sort(),
        seedStr: (k, v) => kv.set(k, v),
        seedJson: (k, v) => jsonKv.set(k, v),
        seedSet: (k, members) => sets.set(k, new Set(members)),
        seedZset: (k, members) => zsets.set(k, [...members]),
        // ── redis surface used by cleanupAmlPipeline ──
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async del(k) {
            let n = 0;
            if (kv.delete(k)) n = 1;
            if (jsonKv.delete(k)) n = 1;
            if (sets.delete(k)) n = 1;
            if (zsets.delete(k)) n = 1;
            return n;
        },
        async sAdd(k, m) { ensureSet(k).add(m); return 1; },
        async sRem(k, m) { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
        async sMembers(k) { return [...(sets.get(k) || [])]; },
        async zRange(k) { return [...(zsets.get(k) || [])]; },
        json: {
            async get(k) { return jsonKv.has(k) ? jsonKv.get(k) : null; },
            async set(k, _path, v) { jsonKv.set(k, v); return 'OK'; },
        },
    };
}

const TRANSITIONED = 'EVENT:FULFILLMENT:TRANSITIONED';

// Seed a full "mine" (pid 999) + "bystander" keyspace. Returns { redis, scope, mine, bystanders }.
function seedWorld({ prevWhitelist = 'PREV_WL' } = {}) {
    const r = makeFakeRedis();

    const mine = [
        'ORCHESTRATOR:WORKFLOW:wf-101-intake-999',
        'ORCHESTRATOR:WORKFLOW:wf-101-aml-999',
        'ORCHESTRATOR:RUN:run-mine-1',
        'ORCHESTRATOR:RUN:run-mine-2',
        'FULFILLMENT:PROFILE:aml-pipeline-999',
        'FULFILLMENT:INSTANCE:FL-999-a', 'FULFILLMENT:INSTANCE:FL-999-b',
        'MARKET:ORDER:ord-999-a', 'MARKET:ORDER:ord-999-b',
        'NEXUS:SENTINEL:snt-999-a', 'NEXUS:SENTINEL:snt-999-b',
        'NEXUS:SENTINEL:ONLINE:snt-999-a', 'NEXUS:SENTINEL:ONLINE:snt-999-b',
        'NOTIFICATION:INBOX:snt-999-a', 'NOTIFICATION:MSG:m-a1',
        'INGRESS:NAME:aml-pipe-999',
        'INGRESS:DEDUP:aml-pipe-999:aml-999-clear',
        'INGRESS:DEDUP:aml-pipe-999:aml-999-hold',
        'INGRESS:DEDUP:aml-pipe-999:aml-999-escalate',
        'EVENT:E2E:AML:999',
        'EVENT:WEBHOOK:AML-PIPE-999',
    ];
    // bystanders: another pid (888), a shared framework key, and a foreign dedup of a
    // DIFFERENT source whose name shares the 'aml-pipe-' stem (would die under a loose glob).
    const bystanders = [
        'SYSTEM:CONFIG:EVENT_REGISTRY',
        'SYSTEM:CONFIG:TASK_WHITELIST',          // restored, must end up == prevWhitelist (still present)
        'ORCHESTRATOR:WORKFLOW:wf-101-intake-888',
        'ORCHESTRATOR:RUN:run-foreign-1',
        'FULFILLMENT:PROFILE:aml-pipeline-888',
        'FULFILLMENT:INSTANCE:FL-888-a',
        'MARKET:ORDER:ord-888-a',
        'NEXUS:SENTINEL:snt-888-a',
        'NEXUS:SENTINEL:ONLINE:snt-888-a',
        'NOTIFICATION:INBOX:snt-888-a', 'NOTIFICATION:MSG:m-foreign',
        'INGRESS:NAME:aml-pipe-888',
        'INGRESS:DEDUP:aml-pipe-888:aml-888-clear',
        'EVENT:E2E:AML:888',
        'EVENT:WEBHOOK:AML-PIPE-888',
    ];

    // string-ish keys
    for (const k of [...mine, ...bystanders]) {
        if (k.startsWith('ORCHESTRATOR:WORKFLOW:') || k.startsWith('ORCHESTRATOR:RUN:')) continue; // json below
        if (k === 'NOTIFICATION:INBOX:snt-999-a' || k === 'NOTIFICATION:INBOX:snt-888-a') continue; // zset below
        r.seedStr(k, '1');
    }
    r.seedStr('SYSTEM:CONFIG:TASK_WHITELIST', 'MY_OVERRIDE');   // beforeAll's override (will be restored)

    // json docs (workflows + runs)
    r.seedJson('ORCHESTRATOR:WORKFLOW:wf-101-intake-999', { id: 'wf-101-intake-999' });
    r.seedJson('ORCHESTRATOR:WORKFLOW:wf-101-aml-999', { id: 'wf-101-aml-999' });
    r.seedJson('ORCHESTRATOR:WORKFLOW:wf-101-intake-888', { id: 'wf-101-intake-888' });
    r.seedJson('ORCHESTRATOR:RUN:run-mine-1', { workflowId: 'wf-101-intake-999', status: 'DONE' });
    r.seedJson('ORCHESTRATOR:RUN:run-mine-2', { workflowId: 'wf-101-aml-999', status: 'DONE' });
    r.seedJson('ORCHESTRATOR:RUN:run-foreign-1', { workflowId: 'wf-101-intake-888', status: 'DONE' });

    // inbox zsets
    r.seedZset('NOTIFICATION:INBOX:snt-999-a', ['m-a1']);
    r.seedZset('NOTIFICATION:INBOX:snt-888-a', ['m-foreign']);

    // shared indexes / sets carry BOTH mine and foreign members
    r.seedSet('ORCHESTRATOR:WORKFLOW_INDEX', ['wf-101-intake-999', 'wf-101-aml-999', 'wf-101-intake-888']);
    r.seedSet('ORCHESTRATOR:RUN_INDEX', ['run-mine-1', 'run-mine-2', 'run-foreign-1']);
    r.seedSet('FULFILLMENT:PROFILE:INDEX', ['aml-pipeline-999', 'aml-pipeline-888']);
    r.seedSet('FULFILLMENT:INSTANCE:INDEX', ['FL-999-a', 'FL-999-b', 'FL-888-a']);
    r.seedSet('MARKET:ORDER:INDEX', ['ord-999-a', 'ord-999-b', 'ord-888-a']);
    r.seedSet('NEXUS:SENTINEL:SET', ['snt-999-a', 'snt-999-b', 'snt-888-a']);
    r.seedSet(`NEXUS:SUB:${TRANSITIONED}`, ['snt-999-a', 'snt-999-b', 'snt-888-a']);

    const scope = {
        wlKey: 'SYSTEM:CONFIG:TASK_WHITELIST',
        prevWhitelist,
        transitionedStream: TRANSITIONED,
        workflows: ['wf-101-intake-999', 'wf-101-aml-999'],
        profileId: 'aml-pipeline-999',
        amlStream: 'EVENT:E2E:AML:999',
        webhookStream: 'EVENT:WEBHOOK:AML-PIPE-999',
        sourceName: 'aml-pipe-999',
        requestIds: ['aml-999-clear', 'aml-999-hold', 'aml-999-escalate'],
        lanes: [
            { instanceId: 'FL-999-a', orderId: 'ord-999-a', sentinelId: 'snt-999-a' },
            { instanceId: 'FL-999-b', orderId: 'ord-999-b', sentinelId: 'snt-999-b' },
        ],
    };
    return { r, scope, mine, bystanders };
}

describe('cleanupAmlPipeline — deletes exactly the suite scope, never a bystander', () => {
    test('every mine-key is removed; every bystander survives', async () => {
        const { r, scope, mine, bystanders } = seedWorld();
        await cleanupAmlPipeline(r, scope);

        for (const k of mine) expect(r._has(k)).toBe(false);            // all mine gone
        for (const k of bystanders) expect(r._has(k)).toBe(true);      // all bystanders intact
    });

    test('shared indexes/sets are pruned of MY members only — foreign members stay', async () => {
        const { r, scope } = seedWorld();
        await cleanupAmlPipeline(r, scope);

        expect(r._members('ORCHESTRATOR:WORKFLOW_INDEX')).toEqual(['wf-101-intake-888']);
        expect(r._members('ORCHESTRATOR:RUN_INDEX')).toEqual(['run-foreign-1']);
        expect(r._members('FULFILLMENT:PROFILE:INDEX')).toEqual(['aml-pipeline-888']);
        expect(r._members('FULFILLMENT:INSTANCE:INDEX')).toEqual(['FL-888-a']);
        expect(r._members('MARKET:ORDER:INDEX')).toEqual(['ord-888-a']);
        expect(r._members('NEXUS:SENTINEL:SET')).toEqual(['snt-888-a']);
        expect(r._members(`NEXUS:SUB:${TRANSITIONED}`)).toEqual(['snt-888-a']);
    });

    test('the foreign run (different workflowId) is NOT deleted by the run filter', async () => {
        const { r, scope } = seedWorld();
        await cleanupAmlPipeline(r, scope);

        expect(r._has('ORCHESTRATOR:RUN:run-foreign-1')).toBe(true);
        expect(r._has('ORCHESTRATOR:RUN:run-mine-1')).toBe(false);
        expect(r._has('ORCHESTRATOR:RUN:run-mine-2')).toBe(false);
    });

    test('a sibling suite sharing the "aml-pipe-" name stem keeps its dedup + streams', async () => {
        const { r, scope } = seedWorld();
        await cleanupAmlPipeline(r, scope);

        expect(r._has('INGRESS:DEDUP:aml-pipe-888:aml-888-clear')).toBe(true);
        expect(r._has('INGRESS:NAME:aml-pipe-888')).toBe(true);
        expect(r._has('EVENT:E2E:AML:888')).toBe(true);
        expect(r._has('EVENT:WEBHOOK:AML-PIPE-888')).toBe(true);
        // and all three of MY exact dedup keys are gone
        for (const rid of ['clear', 'hold', 'escalate']) {
            expect(r._has(`INGRESS:DEDUP:aml-pipe-999:aml-999-${rid}`)).toBe(false);
        }
    });

    test('task whitelist is RESTORED to the saved value (not left as our override, not deleted)', async () => {
        const { r, scope } = seedWorld({ prevWhitelist: 'PREV_WL' });
        const out = await cleanupAmlPipeline(r, scope);
        expect(out.whitelist).toBe('restored');
        expect(r._str('SYSTEM:CONFIG:TASK_WHITELIST')).toBe('PREV_WL');
    });

    test('when there was NO prior whitelist, the key is deleted (our override is not left behind)', async () => {
        const { r, scope } = seedWorld({ prevWhitelist: null });
        const out = await cleanupAmlPipeline(r, scope);
        expect(out.whitelist).toBe('cleared');
        expect(r._has('SYSTEM:CONFIG:TASK_WHITELIST')).toBe(false);
    });

    test('a partial beforeAll (lanes with no ids) does not throw and still restores whitelist', async () => {
        const { r } = seedWorld();
        const partial = {
            wlKey: 'SYSTEM:CONFIG:TASK_WHITELIST', prevWhitelist: 'PREV_WL',
            transitionedStream: TRANSITIONED, workflows: [], profileId: 'aml-pipeline-999',
            amlStream: 'EVENT:E2E:AML:999', webhookStream: undefined,
            sourceName: 'aml-pipe-999', requestIds: [],
            lanes: [{}, { instanceId: 'FL-999-a' }],   // ids missing/partial
        };
        await expect(cleanupAmlPipeline(r, partial)).resolves.toBeTruthy();
        expect(r._str('SYSTEM:CONFIG:TASK_WHITELIST')).toBe('PREV_WL');
    });
});
