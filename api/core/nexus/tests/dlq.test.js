/**
 * Hermetic unit test for nexus DLQ logic (list / retry). Fake redis — no stack.
 */
const createDlq = require('../logic/dlq');

const config = { redis: { dlqStream: 'NEXUS:DLQ' } };

function fakeRedis(entries) {
    // entries: [{ id, message: {field:val} }]
    const added = [];
    const deleted = [];
    return {
        added, deleted,
        async xRange(key, start, end) {
            if (start === '-' && end === '+') return entries;
            // single-id lookup (retry): start === end === id
            return entries.filter((e) => e.id === start);
        },
        async xAdd(stream, _star, fields) { added.push({ stream, fields }); return '999-0'; },
        async xDel(_key, id) { deleted.push(id); return 1; },
    };
}

describe('nexus dlq.list', () => {
    test('shapes entries, parses event JSON, newest-first, paginates', async () => {
        const entries = [
            { id: '1-0', message: { sourceStream: 'EVENT:A', sourceId: '100-0', attempts: '3', failedAt: '1700000000000', event: JSON.stringify({ tag: 'x', n: '1' }) } },
            { id: '2-0', message: { sourceStream: 'EVENT:A', sourceId: '101-0', attempts: '5', failedAt: '1700000000001', event: JSON.stringify({ tag: 'y' }) } },
        ];
        const dlq = createDlq(fakeRedis(entries), config);
        const r = await dlq.list({ page: 1, pageSize: 10 });
        expect(r.total).toBe(2);
        // newest-first → id 2-0 leads
        expect(r.items[0].id).toBe('2-0');
        expect(r.items[0].attempts).toBe(5);
        expect(r.items[1].event).toEqual({ tag: 'x', n: '1' });   // event JSON parsed
        // pagination
        const p2 = await dlq.list({ page: 2, pageSize: 1 });
        expect(p2.items).toHaveLength(1);
        expect(p2.items[0].id).toBe('1-0');
    });

    test('tolerates an unparseable event field (keeps raw string)', async () => {
        const entries = [{ id: '1-0', message: { sourceStream: 'EVENT:A', event: 'not-json', attempts: '1', failedAt: '0' } }];
        const dlq = createDlq(fakeRedis(entries), config);
        const r = await dlq.list();
        expect(r.items[0].event).toBe('not-json');
    });
});

describe('nexus dlq.retry', () => {
    test('re-XADDs the original event onto its source stream and drops the DLQ entry', async () => {
        const entries = [{ id: '7-0', message: { sourceStream: 'EVENT:WORKFLOW:STATUS', sourceId: '50-0', attempts: '2', failedAt: '0', event: JSON.stringify({ tag: 'z', x: 'nope' }) } }];
        const redis = fakeRedis(entries);
        const dlq = createDlq(redis, config);
        const r = await dlq.retry({ id: '7-0' });
        expect(r.retried).toBe(true);
        expect(r.sourceStream).toBe('EVENT:WORKFLOW:STATUS');
        // original fields re-emitted onto the source stream
        expect(redis.added).toEqual([{ stream: 'EVENT:WORKFLOW:STATUS', fields: { tag: 'z', x: 'nope' } }]);
        // DLQ entry removed
        expect(redis.deleted).toEqual(['7-0']);
    });

    test('missing id throws; unknown id throws NOT_FOUND', async () => {
        const dlq = createDlq(fakeRedis([]), config);
        await expect(dlq.retry({})).rejects.toMatchObject({ code: -32602 });
        await expect(dlq.retry({ id: 'nope' })).rejects.toMatchObject({ code: -32002 });
    });
});
