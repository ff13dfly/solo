/**
 * market (发货) — hermetic unit tests (mock Redis).
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

describe('market.shipment', () => {
    test('create — CREATED + emits EVENT:SHIPMENT:CREATED', async () => {
        const s = await logic.shipment.create({ orderId: 'o', paymentId: 'p' });
        expect(s.state).toBe('CREATED');
        expect(s.paymentId).toBe('p');
        expect(s._event[0].stream).toBe('EVENT:SHIPMENT:CREATED');
    });

    test('ship — SHIPPED + trackingNo + event; second ship is idempotent (no re-emit)', async () => {
        const s = await logic.shipment.create({ orderId: 'o' });
        const shipped = await logic.shipment.ship({ id: s.id });
        expect(shipped.state).toBe('SHIPPED');
        expect(shipped.trackingNo).toMatch(/^TRK-/);
        expect(shipped._event[0].stream).toBe('EVENT:SHIPMENT:SHIPPED');
        const again = await logic.shipment.ship({ id: s.id });
        expect(again.state).toBe('SHIPPED');
        expect(again._event).toBeUndefined();
    });

    test('idempotency_key — a replayed create does not double-create and does not re-emit', async () => {
        const key = 'idem-market-1';
        const a = await logic.shipment.create({ orderId: 'o', idempotency_key: key });
        const b = await logic.shipment.create({ orderId: 'o', idempotency_key: key });
        expect(b.id).toBe(a.id);
        expect(b._event).toBeUndefined();
        expect((await logic.shipment.list({})).total).toBe(1);
    });

    test('get / list', async () => {
        const s = await logic.shipment.create({ orderId: 'o' });
        expect((await logic.shipment.get({ id: s.id })).id).toBe(s.id);
        await expect(logic.shipment.get({ id: 'absent' })).rejects.toMatchObject({ code: -32002 });
        expect((await logic.shipment.list({})).total).toBeGreaterThanOrEqual(1);
    });
});

describe('market.order', () => {
    test('create — PLACED + nullable timestamps null + no event piggyback', async () => {
        const o = await logic.order.create({ orderRef: 'ext', amount: 100, currency: 'CNY' });
        expect(o.state).toBe('PLACED');
        expect(o.amount).toBe(100);
        expect(o.paidAt).toBeNull();
        expect(o._event).toBeUndefined();   // order methods deliberately do NOT emit
    });

    test('AML cleared path — pay → PAID, confirm → CONFIRMED', async () => {
        const o = await logic.order.create({ amount: 100 });
        expect((await logic.order.pay({ id: o.id })).state).toBe('PAID');
        expect((await logic.order.confirm({ id: o.id })).state).toBe('CONFIRMED');
    });

    test('AML flagged path — pay → PAID, hold → HELD with reason', async () => {
        const o = await logic.order.create({ amount: 100 });
        await logic.order.pay({ id: o.id });
        const held = await logic.order.hold({ id: o.id, reason: 'sanctions hit' });
        expect(held.state).toBe('HELD');
        expect(held.holdReason).toBe('sanctions hit');
    });

    test('confirm from non-PAID rejects; pay never moves an advanced order backwards', async () => {
        const o = await logic.order.create({ amount: 100 });
        await expect(logic.order.confirm({ id: o.id })).rejects.toMatchObject({ code: expect.any(Number) });
        await logic.order.pay({ id: o.id });
        await logic.order.confirm({ id: o.id });               // PAID → CONFIRMED
        expect((await logic.order.pay({ id: o.id })).state).toBe('CONFIRMED');  // replay no-ops
    });

    test('get / list', async () => {
        const o = await logic.order.create({ amount: 100 });
        expect((await logic.order.get({ id: o.id })).id).toBe(o.id);
        await expect(logic.order.get({ id: 'absent' })).rejects.toMatchObject({ code: -32002 });
        expect((await logic.order.list({})).total).toBeGreaterThanOrEqual(1);
    });
});
