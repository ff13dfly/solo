/**
 * nexus event-bus read endpoints — streams discovery + recent entries (hermetic, mock Redis).
 * Backs the portal EVENT BUS → STREAM LOG tab.
 */
const createEvents = require('../logic/events');
const config = require('../config');

// Mock just the read surface events.js uses: scanIterator / xLen / xRevRange.
function mockRedis(streams) {
    return {
        async *scanIterator({ MATCH, TYPE }) {
            expect(MATCH).toBe('EVENT:*');
            expect(TYPE).toBe('stream');
            for (const key of Object.keys(streams)) yield key;
        },
        async xLen(key) { return (streams[key] || []).length; },
        async xRevRange(key, _start, _end, { COUNT } = {}) {
            const entries = [...(streams[key] || [])].reverse();
            return entries.slice(0, COUNT || entries.length);
        },
    };
}

const BUS = {
    'EVENT:FULFILLMENT:TRANSITIONED': [
        { id: '1700000001000-0', message: { type: 'instance.transitioned', source: 'fulfillment', payload: '{"from":"DRAFT","to":"DEPOSIT_PENDING"}' } },
        { id: '1700000002000-0', message: { type: 'instance.transitioned', source: 'fulfillment', payload: '{"from":"PACKING","to":"SHIPPED"}' } },
    ],
    'EVENT:WEBHOOK:MOCK-LISTENER': [
        { id: '1700000003000-0', message: { type: 'webhook.received', source: 'ingress', data: '{"_heartbeat":true}' } },
    ],
};

describe('nexus.event — bus read endpoints', () => {
    let events;
    beforeEach(() => { events = createEvents(mockRedis(BUS), { config }); });

    test('streams: lists EVENT:* streams with length + last-entry recency, newest first', async () => {
        const r = await events.streams();
        expect(r.truncated).toBe(false);
        expect(r.items).toHaveLength(2);
        // sorted by lastAt desc → webhook stream (t=...3000) first
        expect(r.items[0]).toMatchObject({ key: 'EVENT:WEBHOOK:MOCK-LISTENER', length: 1, lastId: '1700000003000-0', lastAt: 1700000003000 });
        expect(r.items[1]).toMatchObject({ key: 'EVENT:FULFILLMENT:TRANSITIONED', length: 2, lastAt: 1700000002000 });
    });

    test('recent: returns newest-first entries with JSON fields lifted', async () => {
        const r = await events.recent({ stream: 'EVENT:FULFILLMENT:TRANSITIONED', count: 10 });
        expect(r.stream).toBe('EVENT:FULFILLMENT:TRANSITIONED');
        expect(r.entries).toHaveLength(2);
        expect(r.entries[0].id).toBe('1700000002000-0');               // newest first
        expect(r.entries[0].at).toBe(1700000002000);                   // ms lifted from the id
        expect(r.entries[0].payload).toEqual({ from: 'PACKING', to: 'SHIPPED' }); // JSON lifted
        expect(r.entries[0].type).toBe('instance.transitioned');       // plain strings kept
    });

    test('recent: count is clamped and respected', async () => {
        const r = await events.recent({ stream: 'EVENT:FULFILLMENT:TRANSITIONED', count: 1 });
        expect(r.entries).toHaveLength(1);
        expect(r.entries[0].id).toBe('1700000002000-0');
    });

    test('recent: rejects non-EVENT keys and missing stream (read-only guard)', async () => {
        await expect(events.recent({ stream: 'USER:SESSION:abc' })).rejects.toMatchObject({ code: -32602 });
        await expect(events.recent({})).rejects.toMatchObject({ code: -32602 });
    });
});
