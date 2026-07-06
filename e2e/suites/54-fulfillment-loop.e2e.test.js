/**
 * 54 · fulfillment closed loop — fulfillment ↔ collection ↔ market.
 *
 * Proves the full履约 loop the prior gaps blocked:
 *   - profile.create with a CLIENT-SUPPLIED id returns a usable key (the id/key bug fix)
 *   - transition → _tasks dispatched by the Router to REAL downstream services
 *     (collection.payment.record / market.shipment.create) — not phantom sale/erp
 *   - a transition CONDITION fed by data pulled from a real API
 *     (collection.payment.get → cached into instance.meta via instance.update)
 *   - idempotency: replaying a write _task with the same key does not double-create
 *
 * collection(8055) + market(8056) are dev-only fixtures, so this is full-profile gated.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const { WL_KEY, TASK_WHITELIST_SUPERSET } = require('../lib/whitelist');
const P       = process.pid;
const PKEY    = (id) => `FULFILLMENT:PROFILE:${id}`;
const PINDEX  = 'FULFILLMENT:PROFILE:INDEX';
const IKEY    = (id) => `FULFILLMENT:INSTANCE:${id}`;
const IINDEX  = 'FULFILLMENT:INSTANCE:INDEX';
const PAYKEY  = (id) => `COLLECTION:PAYMENT:${id}`;
const PAYIDX  = 'COLLECTION:PAYMENT:INDEX';
const SHPKEY  = (id) => `MARKET:SHIPMENT:${id}`;
const SHPIDX  = 'MARKET:SHIPMENT:INDEX';

// 90s headroom (inside the bumped 150s test timeouts): the loop's side-effects arrive via the
// Router's non-awaited _task dispatch → downstream RPC, which lags under full-run load. The old
// 6s flaked; even 30s wasn't enough on a busy box (it timed out at ~30s) — 90s matches the other
// long-chain suites (101/102/…). The _task DOES complete, it just needs time when the box is busy.
async function poll(fn, predicate, { tries = 180, delay = 500 } = {}) {
    for (let i = 0; i < tries; i++) {
        const v = await fn();
        if (predicate(v)) return v;
        await new Promise((r) => setTimeout(r, delay));
    }
    return null;
}

gate('54 · fulfillment closed loop (collection + market)', () => {
    let redis, uid, token, prevWhitelist;
    const name      = `e2e-fulfil54-${P}`;
    const profileId = `loop-${P}`;
    const sourceId  = `ord-${P}`;
    let instanceId, paymentId, shipmentId;

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { fulfillment: ['*'], collection: ['*'], market: ['*'] }));

        // Allow fulfillment to dispatch _tasks to collection/market. The Router reads
        // this Redis key (falling back to its config otherwise) — seed a SUPERSET so
        // the framework defaults are preserved.
        prevWhitelist = await redis.get(WL_KEY);
        // Shared superset (seeded at harness boot) — value never flips → no §5.6③ cache race.
        await redis.set(WL_KEY, JSON.stringify(TASK_WHITELIST_SUPERSET));
    }, 30_000);

    afterAll(async () => {
        if (prevWhitelist) await redis.set(WL_KEY, prevWhitelist); else await redis.del(WL_KEY);
        if (profileId)  { await redis.del(PKEY(profileId)); await redis.sRem(PINDEX, profileId); }
        if (instanceId) { await redis.del(IKEY(instanceId)); await redis.sRem(IINDEX, instanceId); }
        if (paymentId)  { await redis.del(PAYKEY(paymentId)); await redis.sRem(PAYIDX, paymentId); }
        if (shipmentId) { await redis.del(SHPKEY(shipmentId)); await redis.sRem(SHPIDX, shipmentId); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('profile.create with a client id returns a usable key (id/key bug fix)', async () => {
        const created = V.assertResult(await rpc('fulfillment.profile.create', {
            id: profileId,
            name: `e2e loop ${P}`,
            transitions: [
                {
                    event: 'submit', from: 'DRAFT', to: 'AWAITING_PAYMENT', condition: null,
                    actions: [{
                        type: 'task', method: 'collection.payment.record',
                        params: { source: 'fulfillment', orderId: { var: 'instance.sourceId' }, amount: 100, currency: 'CNY' },
                    }],
                },
                {
                    event: 'pay_confirmed', from: 'AWAITING_PAYMENT', to: 'READY',
                    condition: { '>=': [{ var: 'instance.meta.paidAmount' }, { var: 'instance.meta.dueAmount' }] },
                    actions: [{
                        type: 'task', method: 'market.shipment.create',
                        params: { orderId: { var: 'instance.sourceId' }, paymentId: { var: 'instance.meta.paymentId' } },
                    }],
                },
            ],
        }, token), 'profile.create');
        expect(created.id).toBe(profileId);
        const got = V.assertResult(await rpc('fulfillment.profile.get', { id: profileId }, token), 'profile.get');
        expect(got.transitions).toHaveLength(2);
    }, 30_000);

    test('transition(submit) → _task REALLY records a payment in collection', async () => {
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId, profileId, meta: { dueAmount: 100 } }, token), 'instance.create');
        instanceId = inst.id;
        expect(inst.state).toBe('DRAFT');

        const moved = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'submit' }, token), 'transition submit');
        expect(moved.state).toBe('AWAITING_PAYMENT');
        // NOTE: the Router strips _tasks from the CLIENT response after dispatching them
        // server-side, so we verify the SIDE EFFECT (a real payment) rather than _tasks.

        // _task is dispatched async by the Router → poll collection for the real payment
        const list = await poll(
            async () => V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, token), 'payment.list'),
            (r) => r && r.items.some((p) => p.orderId === sourceId),
        );
        expect(list).toBeTruthy();
        const payment = list.items.find((p) => p.orderId === sourceId);
        paymentId = payment.id;
        expect(payment.amount).toBe(100);
        expect(payment.state).toBe('RECEIVED');
    }, 120_000);

    test('condition fed by REAL API data (collection.payment.get → cache → transition → market)', async () => {
        // simulate the meta_fields.source flow: pull the real amount, cache it into meta
        const pay = V.assertResult(await rpc('collection.payment.get', { id: paymentId }, token), 'payment.get');
        V.assertResult(await rpc('fulfillment.instance.update', { id: instanceId, meta: { paidAmount: pay.amount, paymentId } }, token), 'instance.update');

        const moved = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'pay_confirmed' }, token), 'transition pay_confirmed');
        expect(moved.state).toBe('READY');

        const list = await poll(
            async () => V.assertResult(await rpc('market.shipment.list', { pageSize: 1000 }, token), 'shipment.list'),
            (r) => r && r.items.some((s) => s.orderId === sourceId),
        );
        expect(list).toBeTruthy();
        const shipment = list.items.find((s) => s.orderId === sourceId);
        shipmentId = shipment.id;
        expect(shipment.paymentId).toBe(paymentId);
    }, 120_000);

    test('condition NOT met is rejected; state unchanged', async () => {
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: `${sourceId}b`, profileId, meta: { dueAmount: 999999 } }, token), 'instance.create#2');
        const iid = inst.id;
        await rpc('fulfillment.instance.transition', { id: iid, event: 'submit' }, token);
        await rpc('fulfillment.instance.update', { id: iid, meta: { paidAmount: 1 } }, token);
        const denied = V.assertRpcError(await rpc('fulfillment.instance.transition', { id: iid, event: 'pay_confirmed' }, token), undefined, 'pay_confirmed must fail');
        expect(denied.code).not.toBe(-32601);
        expect((await V.readKey(redis, IKEY(iid))).state).toBe('AWAITING_PAYMENT');

        await redis.del(IKEY(iid)); await redis.sRem(IINDEX, iid);
        const l = V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, token), 'list#2');
        const extra = l.items.find((p) => p.orderId === `${sourceId}b`);
        if (extra) { await redis.del(PAYKEY(extra.id)); await redis.sRem(PAYIDX, extra.id); }
    }, 120_000);

    test('idempotency: replaying a record _task with the same key does not double-create', async () => {
        const key = `e2e-idem-${P}`;
        const first  = V.assertResult(await rpc('collection.payment.record', { source: 'fulfillment', orderId: `${sourceId}i`, amount: 50, idempotency_key: key }, token), 'record#1');
        const second = V.assertResult(await rpc('collection.payment.record', { source: 'fulfillment', orderId: `${sourceId}i`, amount: 50, idempotency_key: key }, token), 'record#2 replay');
        expect(second.id).toBe(first.id);
        const l = V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, token), 'list idem');
        expect(l.items.filter((p) => p.orderId === `${sourceId}i`)).toHaveLength(1);

        await redis.del(PAYKEY(first.id)); await redis.sRem(PAYIDX, first.id);
        await redis.del(`COLLECTION:DEDUP:${key}`);
    }, 30_000);

    test('complete the loop: settle payment + ship → no errors anywhere', async () => {
        const settled = V.assertResult(await rpc('collection.payment.settle', { id: paymentId }, token), 'settle');
        expect(settled.state).toBe('SETTLED');
        const shipped = V.assertResult(await rpc('market.shipment.ship', { id: shipmentId }, token), 'ship');
        expect(shipped.state).toBe('SHIPPED');
        expect(shipped.trackingNo).toBeTruthy();
        await V.assertNoErrors(redis, ['fulfillment', 'collection', 'market']);
    }, 30_000);
});
