/**
 * Router event handler tests (event.md §4, §13 step ⑥).
 *
 * Tests the three exported functions:
 *   extractEvents  — pull _event from result, sanitize response
 *   checkRegistry  — pure registry lookup
 *   processEvents  — registry gate → stamp → xAdd
 *
 * All hermetic: no real Redis, no network.
 */
const { extractEvents, processEvents, checkRegistry } = require('../handlers/events');

// ── Fake Redis ─────────────────────────────────────────────────────────────────
function makeRedis(registryJson = null) {
    const streams = {};
    return {
        isOpen: true,
        async get(key) { return registryJson; },
        async xAdd(stream, id, fields) {
            (streams[stream] ||= []).push(fields);
            return '1-0';
        },
        _streams: streams,
    };
}

// ── Registry for tests ─────────────────────────────────────────────────────────
const REGISTRY = {
    'orchestrator': {
        'EVENT:WORKFLOW:STATUS': ['*'],
        'EVENT:WORKFLOW:RESULT': ['workflow.completed', 'workflow.failed'],
    },
    'system.orchestrator': {
        'EVENT:WORKFLOW:NEEDS_GRANT': ['workflow.needs_grant'],
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. extractEvents
// ─────────────────────────────────────────────────────────────────────────────
describe('extractEvents', () => {
    test('extracts _event array and removes it from result', () => {
        const response = {
            jsonrpc: '2.0', id: 1,
            result: {
                data: 'ok',
                _event: [{ stream: 'EVENT:X', type: 'x', payload: {} }],
            },
        };
        const events = extractEvents(response);
        expect(events).toHaveLength(1);
        expect(events[0].stream).toBe('EVENT:X');
        // _event removed from result (not sent to client)
        expect(response.result._event).toBeUndefined();
        expect(response.result.data).toBe('ok');
    });

    test('returns null when _event absent', () => {
        expect(extractEvents({ result: { data: 'ok' } })).toBeNull();
    });

    test('returns null when result missing', () => {
        expect(extractEvents({ jsonrpc: '2.0', error: {} })).toBeNull();
    });

    test('returns null when _event is not an array', () => {
        const response = { result: { _event: 'not-an-array' } };
        expect(extractEvents(response)).toBeNull();
    });

    test('handles multiple events', () => {
        const response = {
            result: {
                _event: [
                    { stream: 'EVENT:A', type: 'a.done' },
                    { stream: 'EVENT:B', type: 'b.done' },
                ],
            },
        };
        const events = extractEvents(response);
        expect(events).toHaveLength(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. checkRegistry
// ─────────────────────────────────────────────────────────────────────────────
describe('checkRegistry', () => {
    test('source not in registry → false', () => {
        expect(checkRegistry(REGISTRY, 'unknown', 'EVENT:WORKFLOW:STATUS', 'x')).toBe(false);
    });

    test('stream not in source rules → false', () => {
        expect(checkRegistry(REGISTRY, 'orchestrator', 'EVENT:UNKNOWN', 'x')).toBe(false);
    });

    test('wildcard type → true for any type', () => {
        expect(checkRegistry(REGISTRY, 'orchestrator', 'EVENT:WORKFLOW:STATUS', 'anything')).toBe(true);
    });

    test('exact type match → true', () => {
        expect(checkRegistry(REGISTRY, 'orchestrator', 'EVENT:WORKFLOW:RESULT', 'workflow.completed')).toBe(true);
    });

    test('type not in allowed list → false', () => {
        expect(checkRegistry(REGISTRY, 'orchestrator', 'EVENT:WORKFLOW:RESULT', 'workflow.unknown')).toBe(false);
    });

    test('bot source with specific stream+type → true', () => {
        expect(checkRegistry(REGISTRY, 'system.orchestrator', 'EVENT:WORKFLOW:NEEDS_GRANT', 'workflow.needs_grant')).toBe(true);
    });

    test('bot source with wrong type → false', () => {
        expect(checkRegistry(REGISTRY, 'system.orchestrator', 'EVENT:WORKFLOW:NEEDS_GRANT', 'other')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. processEvents
// ─────────────────────────────────────────────────────────────────────────────
describe('processEvents', () => {
    // Inject registry so tests don't hit Redis for the registry
    const registryJson = JSON.stringify(REGISTRY);

    test('valid event → xAdd called with stamped envelope', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', type: 'workflow.status.changed', payload: { id: 'wf_1' } }],
            { source: 'orchestrator', actor: 'uid_user', redisClient: redis }
        );

        const written = redis._streams['EVENT:WORKFLOW:STATUS'];
        expect(written).toHaveLength(1);
        const env = written[0];
        expect(env.type).toBe('workflow.status.changed');
        expect(env.source).toBe('orchestrator');
        expect(env.actor).toBe('uid_user');
        expect(typeof env.trace_id).toBe('string');
        expect(typeof env.event_id).toBe('string');
        expect(typeof env.emitted_at).toBe('string');
        expect(JSON.parse(env.payload).id).toBe('wf_1');
    });

    test('registry blocked → no xAdd', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:RESULT', type: 'workflow.unknown', payload: {} }],
            { source: 'orchestrator', actor: 'uid_user', redisClient: redis }
        );
        expect(redis._streams['EVENT:WORKFLOW:RESULT']).toBeUndefined();
    });

    test('unknown source → no xAdd', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', type: 'anything', payload: {} }],
            { source: 'rogue-service', actor: 'uid_attacker', redisClient: redis }
        );
        expect(redis._streams['EVENT:WORKFLOW:STATUS']).toBeUndefined();
    });

    test('missing stream field → skipped', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ type: 'x.done', payload: {} }], // no stream
            { source: 'orchestrator', actor: 'uid', redisClient: redis }
        );
        expect(Object.keys(redis._streams)).toHaveLength(0);
    });

    test('missing type field → skipped', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', payload: {} }], // no type
            { source: 'orchestrator', actor: 'uid', redisClient: redis }
        );
        expect(Object.keys(redis._streams)).toHaveLength(0);
    });

    test('payload string → passed through as-is', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', type: 'x', payload: 'raw-string' }],
            { source: 'orchestrator', actor: 'uid', redisClient: redis }
        );
        expect(redis._streams['EVENT:WORKFLOW:STATUS'][0].payload).toBe('raw-string');
    });

    test('no payload → defaults to {}', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', type: 'x' }],
            { source: 'orchestrator', actor: 'uid', redisClient: redis }
        );
        expect(redis._streams['EVENT:WORKFLOW:STATUS'][0].payload).toBe('{}');
    });

    test('multiple events: some blocked, some valid → only valid written', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [
                { stream: 'EVENT:WORKFLOW:STATUS', type: 'valid', payload: {} },   // ✓ wildcard
                { stream: 'EVENT:WORKFLOW:RESULT', type: 'blocked', payload: {} }, // ✗ not in list
                { stream: 'EVENT:WORKFLOW:RESULT', type: 'workflow.completed', payload: {} }, // ✓
            ],
            { source: 'orchestrator', actor: 'uid', redisClient: redis }
        );
        expect(redis._streams['EVENT:WORKFLOW:STATUS']).toHaveLength(1);
        expect(redis._streams['EVENT:WORKFLOW:RESULT']).toHaveLength(1);
    });

    test('empty events array → no xAdd', async () => {
        const redis = makeRedis(registryJson);
        await processEvents([], { source: 'orchestrator', actor: 'uid', redisClient: redis });
        expect(Object.keys(redis._streams)).toHaveLength(0);
    });

    test('redis not open → no xAdd, no crash', async () => {
        const redis = { isOpen: false, async get() { return null; }, xAdd: jest.fn() };
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', type: 'x', payload: {} }],
            { source: 'orchestrator', actor: 'uid', redisClient: redis }
        );
        expect(redis.xAdd).not.toHaveBeenCalled();
    });

    test('actor defaults to "anonymous" when not provided', async () => {
        const redis = makeRedis(registryJson);
        await processEvents(
            [{ stream: 'EVENT:WORKFLOW:STATUS', type: 'x', payload: {} }],
            { source: 'orchestrator', redisClient: redis } // no actor
        );
        expect(redis._streams['EVENT:WORKFLOW:STATUS'][0].actor).toBe('anonymous');
    });
});
