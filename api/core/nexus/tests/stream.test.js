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
