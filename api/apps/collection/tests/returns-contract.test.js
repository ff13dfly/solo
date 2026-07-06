/**
 * returns-contract.test.js — proves collection.payment.* ACTUAL handler output satisfies
 * the declared return contract (introspection `returns_schema`). Hermetic: real logic +
 * real Entity Factory over an injected Map-backed fake Redis (the sample/item.test.js
 * pattern). No stack, no live Redis.
 *
 * Why this service: collection.payment.get is the concrete fulfillment meta_fields.source
 * target (e2e/suites/54-fulfillment-loop). The fulfillment profile linter resolves
 * source.pick against this method's returns_schema, so that schema MUST match reality.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-collection-contract-${process.pid}`);

const createPaymentLogic = require('../logic/payment');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — only the Entity-Factory (string path) commands, per sample/item.test.js.
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

describe('collection.payment.* — actual return satisfies declared returns_schema', () => {
    let payment;
    beforeEach(() => { payment = createPaymentLogic(makeFakeRedis(), { config }); });

    test('record → matches contract; business state is RECEIVED', async () => {
        const rec = await payment.record({ source: 'web', orderId: 'ord-1', amount: 100, currency: 'USD' });
        expect(checkReturn(method('collection.payment.record'), rec)).toEqual([]);
        expect(rec.state).toBe('RECEIVED');
        expect(typeof rec.amount).toBe('number');
    });

    test('get → matches contract; the pick path "amount" (used by fulfillment) is a number', async () => {
        const rec = await payment.record({ orderId: 'ord-2', amount: 50, currency: 'USD' });
        const got = await payment.get({ id: rec.id });
        expect(checkReturn(method('collection.payment.get'), got)).toEqual([]);
        // The fulfillment e2e caches got.amount → instance.meta.paidAmount → condition. Prove it resolves.
        expect(typeof got.amount).toBe('number');
        expect(got.state).toBe('RECEIVED');
    });

    test('settle → matches contract; state advances to SETTLED with a numeric settledAt', async () => {
        const rec = await payment.record({ orderId: 'ord-3', amount: 75 });
        const settled = await payment.settle({ id: rec.id });
        expect(checkReturn(method('collection.payment.settle'), settled)).toEqual([]);
        expect(settled.state).toBe('SETTLED');
        expect(typeof settled.settledAt).toBe('number');
    });

    test('list → matches {items, total} contract', async () => {
        await payment.record({ orderId: 'ord-4', amount: 10 });
        await payment.record({ orderId: 'ord-5', amount: 20 });
        const res = await payment.list({});
        expect(checkReturn(method('collection.payment.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
        // each item is a full payment → must also satisfy the payment shape used downstream
        for (const item of res.items) {
            expect(checkReturn(method('collection.payment.get'), item)).toEqual([]);
        }
    });

    test('list with state filter → still matches {items, total}; empty result is valid', async () => {
        await payment.record({ orderId: 'ord-6', amount: 30 });
        const settledList = await payment.list({ state: 'SETTLED' });
        expect(checkReturn(method('collection.payment.list'), settledList)).toEqual([]);
        expect(settledList.items).toEqual([]);       // nothing settled yet
        expect(settledList.total).toBe(0);
    });

    test('record with idempotency_key → replay returns the SAME cached object, still on contract (no _event re-fire path)', async () => {
        const first = await payment.record({ orderId: 'ord-7', amount: 40, idempotency_key: 'idem-1' });
        const replay = await payment.record({ orderId: 'ord-7', amount: 40, idempotency_key: 'idem-1' });
        // The replay path (logic/payment.js: cached JSON.parse) returns the business object WITHOUT _event.
        expect(checkReturn(method('collection.payment.record'), replay)).toEqual([]);
        expect(replay.id).toBe(first.id);            // no second payment created
        expect(replay._event).toBeUndefined();       // replay does not re-emit
    });

    test('settle is idempotent → second settle hits the early-return path and still matches contract', async () => {
        const rec = await payment.record({ orderId: 'ord-8', amount: 55 });
        const settled1 = await payment.settle({ id: rec.id });
        const settled2 = await payment.settle({ id: rec.id });   // early-return: returns stored `current`
        expect(checkReturn(method('collection.payment.settle'), settled2)).toEqual([]);
        expect(settled2.state).toBe('SETTLED');
        expect(typeof settled2.settledAt).toBe('number');
        expect(settled2._event).toBeUndefined();     // idempotent settle does NOT re-emit
    });

    test('declared updatedAt key is actually present on record/get/settle results', async () => {
        const rec = await payment.record({ orderId: 'ord-9', amount: 60 });
        const got = await payment.get({ id: rec.id });
        const settled = await payment.settle({ id: rec.id });
        for (const obj of [rec, got, settled]) {
            expect(typeof obj.updatedAt).toBe('number');
        }
    });
});
