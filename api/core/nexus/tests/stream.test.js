/**
 * nexus stream consumer — dynamic stream discovery (hermetic, mock Redis).
 *
 * Proves §2.1: the consumed stream set is the union of the default lifecycle streams
 * and every ACTIVE agent's declared eventSubscriptions (disabled agents excluded),
 * so an agent can subscribe to ANY event stream without a nexus restart.
 */
const createStream = require('../logic/stream');
const config = require('../config');

function mockRedis(agents) {
    return {
        async sMembers(key) {
            return key === config.redis.sentinelSet ? Object.keys(agents) : [];
        },
        async mGet(keys) {
            return keys.map((k) => {
                const id = k.slice(config.redis.sentinelPrefix.length);
                return agents[id] ? JSON.stringify(agents[id]) : null;
            });
        },
    };
}

describe('nexus stream.discoverStreams', () => {
    test('returns only the default lifecycle streams when there are no agents', async () => {
        const s = createStream(mockRedis({}), config, {});
        const streams = await s.discoverStreams();
        expect(streams.sort()).toEqual([...config.consumer.streams].sort());
    });

    test('unions ACTIVE agents subscriptions with the defaults; excludes disabled agents', async () => {
        const s = createStream(mockRedis({
            a1: { id: 'a1', status: 'ACTIVE',   eventSubscriptions: ['EVENT:PAYMENT:SETTLED', 'EVENT:WORKFLOW:STATUS'] },
            a2: { id: 'a2', status: 'DISABLED', eventSubscriptions: ['EVENT:SECRET:X'] },
            a3: { id: 'a3', status: 'ACTIVE',   eventSubscriptions: ['EVENT:SHIPMENT:SHIPPED'] },
            a4: { id: 'a4', status: 'ACTIVE' }, // no eventSubscriptions field
        }), config, {});
        const streams = await s.discoverStreams();

        expect(streams).toEqual(expect.arrayContaining([
            'EVENT:WORKFLOW:STATUS', 'EVENT:WORKFLOW:RESULT',   // defaults
            'EVENT:PAYMENT:SETTLED', 'EVENT:SHIPMENT:SHIPPED',  // from ACTIVE agents
        ]));
        expect(streams).not.toContain('EVENT:SECRET:X');        // disabled agent excluded
        // de-duplicated: a default an agent also subscribes to appears once
        expect(streams.filter((x) => x === 'EVENT:WORKFLOW:STATUS')).toHaveLength(1);
    });
});

describe('nexus stream — DLQ parking is bounded (docs/feedback/event-bus-xadd-unbounded-dead-config.md §二.4)', () => {
    // notification (DLQ_MAXLEN) and orchestrator (RUNQ_DLQ_MAXLEN) list-DLQs are capped;
    // the stream-flavored NEXUS:DLQ was the one without a lid. Drive one entry past
    // maxDeliveries through consumeOnce and assert the parking xAdd carries MAXLEN ~.
    test('moveToDLQ passes TRIM MAXLEN ~ (default 1000) so NEXUS:DLQ cannot grow unbounded', async () => {
        const R = config.redis;
        const stream = 'EVENT:X:FAIL';
        const kv = {
            [R.sentinelPrefix + 'a1']: JSON.stringify({ id: 'a1', status: 'ACTIVE', reachability: 'polling' }),
            // seeded one short of maxDeliveries → this round's failure parks the entry
            [R.retryPrefix + stream + ':1-0']: JSON.stringify({ count: config.consumer.maxDeliveries - 1, nextAt: 0 }),
        };
        const dlqAdds = [];
        const redis = {
            async sMembers(key) { return key === R.sentinelSet ? ['a1'] : []; },
            async mGet() { return [JSON.stringify({ id: 'a1', status: 'ACTIVE', eventSubscriptions: [stream] })]; },
            async get(k) { return kv[k] || null; },
            async set() { return 'OK'; },
            async del(k) { delete kv[k]; return 1; },
            async xAdd(s, _star, fields, opts) { dlqAdds.push({ stream: s, fields, opts }); return '9-0'; },
        };
        let served = false;
        const client = {
            async xGroupCreate() { return 'OK'; },
            async xReadGroup() {
                if (served) return null;   // only the '>' read serves the entry
                served = true;
                return [{ name: stream, messages: [{ id: '1-0', message: { type: 'x.failed', payload: '{}' } }] }];
            },
            async xAck() { return 1; },
        };
        const s = createStream(redis, config, {
            sentinelLogic: { subscribersOf: async () => ['a1'] },
            relay: null,   // delivery fails ('relay not configured') → settle counts the failure
        });

        const processed = await s.consumeOnce(client);
        expect(processed).toBe(0);                                   // parked, not counted as processed
        expect(dlqAdds).toHaveLength(1);
        expect(dlqAdds[0].stream).toBe(R.dlqStream);
        expect(dlqAdds[0].fields).toMatchObject({ sourceStream: stream, sourceId: '1-0' });
        expect(dlqAdds[0].opts).toEqual({ TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 1000 } });
        expect(kv[R.retryPrefix + stream + ':1-0']).toBeUndefined(); // retry counter cleaned up
    });
});

describe('nexus stream.consumeOnce — idle pacing (no streams)', () => {
    // In normal config nexus always has default lifecycle streams to block on, so the
    // empty-set branch is unreachable. But if the defaults were ever configured away (or
    // every subscription removed), consumeOnce must NOT return instantly — that would let
    // the consumer loop hot-spin discoverStreams (SMEMBERS) thousands of times a second
    // and burn a CPU core (the bug that bit the orchestrator matcher). Assert it waits.
    test('no subscribed streams → waits ~blockMs instead of returning instantly', async () => {
        const fastConfig = { ...config, consumer: { ...config.consumer, streams: [], blockMs: 40 } };
        const s = createStream(mockRedis({}), fastConfig, {});  // no defaults, no agents → empty set
        const t0 = Date.now();
        const processed = await s.consumeOnce({});              // client unused on the empty path
        const elapsed = Date.now() - t0;

        expect(processed).toBe(0);
        expect(elapsed).toBeGreaterThanOrEqual(35);             // it paced (blockMs=40), did not spin
    });
});
