/**
 * collection (收款) — hermetic unit tests (mock Redis).
 */
const createLogic = require('../logic');
const config = require('../config');

function createMockRedis() {
    const store = {}, sets = {};
    return {
        async set(key, val, opts) { if (opts && opts.NX && store[key] !== undefined) return null; store[key] = val; return 'OK'; },
        async get(key)       { return store[key] || null; },
        async sAdd(key, val) { if (!sets[key]) sets[key] = new Set(); sets[key].add(val); },
        async sMembers(key)  { return sets[key] ? [...sets[key]] : []; },
        async mGet(keys)     { return keys.map(k => store[k] || null); },
        async del(key)       { delete store[key]; },
        async sRem(key, val) { if (sets[key]) sets[key].delete(val); },
        async watch()        { return 'OK'; },
        async unwatch()      { return 'OK'; },
        multi() {
            const ops = [];
            const p = {
                set(k, v)  { ops.push(() => { store[k] = v; }); return p; },
                sAdd(k, v) { ops.push(() => { if (!sets[k]) sets[k] = new Set(); sets[k].add(v); }); return p; },
                sRem(k, v) { ops.push(() => { if (sets[k]) sets[k].delete(v); }); return p; },
                del(k)     { ops.push(() => { delete store[k]; }); return p; },
                async exec() { ops.forEach(o => o()); return []; }
            };
            return p;
        }
    };
}

let redis, logic;
beforeEach(() => { redis = createMockRedis(); logic = createLogic(redis, { config }); });

describe('collection.payment', () => {
    test('record — creates a RECEIVED payment and emits EVENT:PAYMENT:RECEIVED', async () => {
        const r = await logic.payment.record({ source: 'stripe', orderId: 'ord-1', amount: 100, currency: 'CNY' });
        expect(r.state).toBe('RECEIVED');
        expect(r.amount).toBe(100);
        expect(r._event[0].stream).toBe('EVENT:PAYMENT:RECEIVED');
        expect(r._event[0].payload.paymentId).toBe(r.id);
    });

    test('record — rejects a non-positive amount', async () => {
        await expect(logic.payment.record({ orderId: 'o', amount: 0 })).rejects.toMatchObject({ code: -32602 });
    });

    test('settle — SETTLED + event; second settle is idempotent (no re-emit)', async () => {
        const r = await logic.payment.record({ orderId: 'o', amount: 10 });
        const s = await logic.payment.settle({ id: r.id });
        expect(s.state).toBe('SETTLED');
        expect(s._event[0].stream).toBe('EVENT:PAYMENT:SETTLED');
        const again = await logic.payment.settle({ id: r.id });
        expect(again.state).toBe('SETTLED');
        expect(again._event).toBeUndefined();
    });

    test('idempotency_key — a replayed record does not double-create and does not re-emit', async () => {
        const key = 'idem-collection-1';
        const a = await logic.payment.record({ orderId: 'o', amount: 5, idempotency_key: key });
        const b = await logic.payment.record({ orderId: 'o', amount: 5, idempotency_key: key });
        expect(b.id).toBe(a.id);
        expect(b._event).toBeUndefined();
        expect((await logic.payment.list({})).total).toBe(1);
    });

    test('get / list', async () => {
        const r = await logic.payment.record({ orderId: 'o', amount: 7 });
        expect((await logic.payment.get({ id: r.id })).id).toBe(r.id);
        await expect(logic.payment.get({ id: 'absent' })).rejects.toMatchObject({ code: -32002 });
        expect((await logic.payment.list({})).total).toBeGreaterThanOrEqual(1);
    });
});
