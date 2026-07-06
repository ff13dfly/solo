/**
 * 90 · 事件链(§7.5 单文件 + 多 test() 闭包串).
 *
 * 整链:collection 收款 → market 发货 → notification 通知.
 *   ① collection.payment.record → COLLECTION:PAYMENT RECEIVED  (+ EVENT:PAYMENT:RECEIVED)
 *   ② collection.payment.settle → SETTLED                       (+ EVENT:PAYMENT:SETTLED)
 *   ③ market.shipment.create    → MARKET:SHIPMENT CREATED       (+ EVENT:SHIPMENT:CREATED)
 *   ④ market.shipment.ship      → SHIPPED(trackingNo)          (+ EVENT:SHIPMENT:SHIPPED)
 *   ⑤ notification.send         → NOTIFICATION:MSG + INBOX
 *
 * 本套**只在 full profile 跑**(E2E_PROFILE=full;需 redis-stack + 整栈 + bot token).
 * 这里走 **direct 编排**(以 admin 直接按序调各 hop,断言每跳的实体落库 + 事件流增量)——
 * 验证 choreography 各环 + _event 发流都对.
 *
 * 【剩余 P5 集成】matcher 驱动的"真事件触发 workflow"那条,复用
 *   deploy/mock/inject-workflows.js(注入 PENDING_REVIEW/ACTIVE workflow + 事件注册表覆盖)
 *   + simulate.js 触发;在此基础上把 ① 换成"注入事件 → 等 matcher 拉起 workflow"即可.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('90 · event chain (collection → market → notification)', () => {
    let redis;
    let paymentId, shipmentId;
    const orderId = `chain-${process.pid}`;
    const cleanup = { payments: [], shipments: [] };

    // 流的基线 XLEN(断言"有新事件"用增量,§8.4).
    async function xlen(stream) { try { return await redis.xLen(stream); } catch { return 0; } }

    beforeAll(async () => { redis = await redisLib.connect(); });
    afterAll(async () => {
        for (const id of cleanup.payments) { await redis.del(`COLLECTION:PAYMENT:${id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', id); }
        for (const id of cleanup.shipments) { await redis.del(`MARKET:SHIPMENT:${id}`); await redis.sRem('MARKET:SHIPMENT:INDEX', id); }
        await redis.quit();
    });

    test('① record payment → RECEIVED', async () => {
        const base = await xlen('EVENT:PAYMENT:RECEIVED');
        const p = V.assertResult(await rpc('collection.payment.record', { amount: 99, currency: 'CNY', orderId, source: 'stripe' }, ADMIN_TOKEN), 'record');
        paymentId = p.id; cleanup.payments.push(p.id);
        await V.assertRecord(redis, `COLLECTION:PAYMENT:${p.id}`, { state: 'RECEIVED', amount: 99 }, { indexKey: 'COLLECTION:PAYMENT:INDEX' });
        expect(await xlen('EVENT:PAYMENT:RECEIVED')).toBeGreaterThan(base);   // _event 发流(需事件注册表含 collection)
    });

    test('② settle payment → SETTLED', async () => {
        const base = await xlen('EVENT:PAYMENT:SETTLED');
        const p = V.assertResult(await rpc('collection.payment.settle', { id: paymentId }, ADMIN_TOKEN), 'settle');
        expect(p.state).toBe('SETTLED');
        await V.assertRecord(redis, `COLLECTION:PAYMENT:${paymentId}`, { state: 'SETTLED' });
        expect(await xlen('EVENT:PAYMENT:SETTLED')).toBeGreaterThan(base);
    });

    test('③ create shipment → CREATED', async () => {
        const base = await xlen('EVENT:SHIPMENT:CREATED');
        const s = V.assertResult(await rpc('market.shipment.create', { orderId, paymentId, address: 'e2e-addr' }, ADMIN_TOKEN), 'shipment.create');
        shipmentId = s.id; cleanup.shipments.push(s.id);
        await V.assertRecord(redis, `MARKET:SHIPMENT:${s.id}`, { state: 'CREATED', orderId }, { indexKey: 'MARKET:SHIPMENT:INDEX' });
        expect(await xlen('EVENT:SHIPMENT:CREATED')).toBeGreaterThan(base);
    });

    test('④ ship → SHIPPED (trackingNo)', async () => {
        const base = await xlen('EVENT:SHIPMENT:SHIPPED');
        const s = V.assertResult(await rpc('market.shipment.ship', { id: shipmentId }, ADMIN_TOKEN), 'shipment.ship');
        expect(s.state).toBe('SHIPPED');
        expect(s.trackingNo).toBeTruthy();
        await V.assertRecord(redis, `MARKET:SHIPMENT:${shipmentId}`, { state: 'SHIPPED' });
        expect(await xlen('EVENT:SHIPMENT:SHIPPED')).toBeGreaterThan(base);
    });

    test('⑤ notify shipped + 全链 ERROR:QUEUE 空', async () => {
        const sent = V.assertResult(await rpc('notification.send', { targetId: 'e2e-ops', type: 'shipment.shipped', payload: { orderId, shipmentId }, ref: orderId }, ADMIN_TOKEN), 'notification.send');
        expect(sent).toBeTruthy();
        await V.assertNoErrors(redis, ['collection', 'market', 'notification']);
    });
});
