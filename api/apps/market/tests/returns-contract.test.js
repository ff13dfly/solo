/**
 * returns-contract.test.js — proves market.shipment.* ACTUAL handler output satisfies
 * the declared return contract (introspection `returns_schema`). Hermetic: real logic +
 * real Entity Factory over an injected Map-backed fake Redis (the sample/item.test.js
 * pattern). No stack, no live Redis.
 *
 * market sits downstream of collection in the event choreography: a workflow subscribing
 * to EVENT:PAYMENT:SETTLED calls market.shipment.create, then market.shipment.ship. An
 * orchestration/AI binder resolves source.pick against these methods' returns_schema, so
 * those schemas MUST match reality.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-market-contract-${process.pid}`);

const createLogic = require('../logic');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — Entity-Factory (string path) commands + the create() idempotency dedup
// get/set (with EX/NX opts). Copied from collection's makeFakeRedis, extended with the
// `EX` opt no-op (string create uses NX; dedup uses EX — both are just ignored here).
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

describe('market.shipment.* — actual return satisfies declared returns_schema', () => {
    let shipment;
    beforeEach(() => { shipment = createLogic(makeFakeRedis(), { config }).shipment; });

    test('create → matches contract; business state is CREATED, nullable fks present-but-null', async () => {
        const s = await shipment.create({ orderId: 'ord-1', paymentId: 'pay-1', address: '1 Main St' });
        expect(checkReturn(method('market.shipment.create'), s)).toEqual([]);
        expect(s.state).toBe('CREATED');
        expect(s.status).toBe('ACTIVE');
        expect(s.trackingNo).toBeNull();   // null until shipped — typed but NOT required
        expect(s.shippedAt).toBeNull();
    });

    test('create with NO optional params → orderId/paymentId/address are null, still on contract', async () => {
        const s = await shipment.create({});
        expect(checkReturn(method('market.shipment.create'), s)).toEqual([]);
        // these are coerced `|| null` by the logic — proves declaring them required would be wrong
        expect(s.orderId).toBeNull();
        expect(s.paymentId).toBeNull();
        expect(s.address).toBeNull();
    });

    test('get → matches contract; reads back the stored shipment', async () => {
        const created = await shipment.create({ orderId: 'ord-2', paymentId: 'pay-2' });
        const got = await shipment.get({ id: created.id });
        expect(checkReturn(method('market.shipment.get'), got)).toEqual([]);
        expect(got.state).toBe('CREATED');
        expect(got.id).toBe(created.id);
    });

    test('ship → matches contract; state advances to SHIPPED with a string trackingNo + numeric shippedAt', async () => {
        const created = await shipment.create({ orderId: 'ord-3' });
        const shipped = await shipment.ship({ id: created.id });
        expect(checkReturn(method('market.shipment.ship'), shipped)).toEqual([]);
        expect(shipped.state).toBe('SHIPPED');
        expect(typeof shipped.trackingNo).toBe('string');
        expect(typeof shipped.shippedAt).toBe('number');
    });

    test('ship is idempotent → second ship hits the early-return path (returns stored current) and still matches contract', async () => {
        const created = await shipment.create({ orderId: 'ord-4' });
        const shipped1 = await shipment.ship({ id: created.id });
        const shipped2 = await shipment.ship({ id: created.id });   // early-return: current (already SHIPPED)
        expect(checkReturn(method('market.shipment.ship'), shipped2)).toEqual([]);
        expect(shipped2.state).toBe('SHIPPED');
        expect(shipped2.trackingNo).toBe(shipped1.trackingNo);   // no new tracking assigned
        expect(shipped2._event).toBeUndefined();                 // idempotent ship does NOT re-emit
    });

    test('create with idempotency_key → replay returns the SAME cached object, still on contract (no _event re-fire)', async () => {
        const first = await shipment.create({ orderId: 'ord-5', idempotency_key: 'idem-1' });
        const replay = await shipment.create({ orderId: 'ord-5', idempotency_key: 'idem-1' });
        // replay path (logic/shipment.js: cached JSON.parse) returns the business object WITHOUT _event.
        expect(checkReturn(method('market.shipment.create'), replay)).toEqual([]);
        expect(replay.id).toBe(first.id);          // no second shipment created
        expect(replay._event).toBeUndefined();     // replay does not re-emit
    });

    test('list → matches {items, total} contract; each item also satisfies the shipment shape', async () => {
        await shipment.create({ orderId: 'ord-6' });
        await shipment.create({ orderId: 'ord-7' });
        const res = await shipment.list({});
        expect(checkReturn(method('market.shipment.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
        for (const item of res.items) {
            expect(checkReturn(method('market.shipment.get'), item)).toEqual([]);
        }
    });

    test('list with state filter → still matches {items, total}; empty result is valid', async () => {
        await shipment.create({ orderId: 'ord-8' });
        const shippedList = await shipment.list({ state: 'SHIPPED' });
        expect(checkReturn(method('market.shipment.list'), shippedList)).toEqual([]);
        expect(shippedList.items).toEqual([]);   // nothing shipped yet
        expect(shippedList.total).toBe(0);
    });

    test('declared createdAt/updatedAt keys are actually present numbers on create/get/ship results', async () => {
        const created = await shipment.create({ orderId: 'ord-9' });
        const got = await shipment.get({ id: created.id });
        const shipped = await shipment.ship({ id: created.id });
        for (const obj of [created, got, shipped]) {
            expect(typeof obj.createdAt).toBe('number');
            expect(typeof obj.updatedAt).toBe('number');
        }
    });
});

describe('market.order.* — actual return satisfies declared returns_schema', () => {
    let order;
    beforeEach(() => { order = createLogic(makeFakeRedis(), { config }).order; });

    test('create → PLACED; nullable fields present-but-null; on contract', async () => {
        const o = await order.create({ orderRef: 'ext-1', amount: 5000, currency: 'CNY' });
        expect(checkReturn(method('market.order.create'), o)).toEqual([]);
        expect(o.state).toBe('PLACED');
        expect(o.status).toBe('ACTIVE');
        expect(o.paidAt).toBeNull();
        expect(o.confirmedAt).toBeNull();
        expect(o.heldAt).toBeNull();
    });

    test('pay → PLACED→PAID, paidAt stamped, on contract', async () => {
        const o = await order.create({ amount: 100 });
        const paid = await order.pay({ id: o.id });
        expect(checkReturn(method('market.order.pay'), paid)).toEqual([]);
        expect(paid.state).toBe('PAID');
        expect(typeof paid.paidAt).toBe('number');
    });

    test('pay is idempotent → replay returns current PAID, no backward move, still on contract', async () => {
        const o = await order.create({ amount: 100 });
        const p1 = await order.pay({ id: o.id });
        const p2 = await order.pay({ id: o.id });
        expect(checkReturn(method('market.order.pay'), p2)).toEqual([]);
        expect(p2.state).toBe('PAID');
        expect(p2.paidAt).toBe(p1.paidAt);
    });

    test('confirm → PAID→CONFIRMED (AML cleared), on contract', async () => {
        const o = await order.create({ amount: 100 });
        await order.pay({ id: o.id });
        const c = await order.confirm({ id: o.id });
        expect(checkReturn(method('market.order.confirm'), c)).toEqual([]);
        expect(c.state).toBe('CONFIRMED');
        expect(typeof c.confirmedAt).toBe('number');
    });

    test('hold → PAID→HELD (AML flagged), holdReason set, on contract', async () => {
        const o = await order.create({ amount: 100 });
        await order.pay({ id: o.id });
        const h = await order.hold({ id: o.id });
        expect(checkReturn(method('market.order.hold'), h)).toEqual([]);
        expect(h.state).toBe('HELD');
        expect(typeof h.heldAt).toBe('number');
        expect(h.holdReason).toBe('AML hold');
    });

    test('confirm/hold reject from a non-PAID state (illegal advance is loud, not silent)', async () => {
        const o = await order.create({ amount: 100 });   // PLACED, never paid
        await expect(order.confirm({ id: o.id })).rejects.toMatchObject({ code: expect.any(Number) });
        await expect(order.hold({ id: o.id })).rejects.toMatchObject({ code: expect.any(Number) });
    });

    test('get / list → match {items,total}; each item satisfies the order shape', async () => {
        const o = await order.create({ amount: 100 });
        const got = await order.get({ id: o.id });
        expect(checkReturn(method('market.order.get'), got)).toEqual([]);
        const res = await order.list({});
        expect(checkReturn(method('market.order.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        for (const item of res.items) {
            expect(checkReturn(method('market.order.get'), item)).toEqual([]);
        }
    });
});
