/**
 * 64 · market.shipment.get / list 直测.
 *
 * 事件链 suite(90)已覆盖 create/ship 的发流与落库;本套补 **get / list** ——
 * 这两个查询方法此前无专属 e2e 覆盖。打通:
 *   ① market.shipment.create  → 建两条发货单(落库 MARKET:SHIPMENT:* + INDEX)
 *   ② market.shipment.get      → 按 id 取回,字段与建单一致;查不存在 id → null
 *   ③ market.shipment.list     → 全量列出能找到刚建的两条;total ≥ 行数
 *   ④ market.shipment.list({state}) → 按状态过滤:CREATED 命中、SHIPPED(此处无)不命中
 *
 * 本套**只在 full profile 跑**(E2E_PROFILE=full;需整栈 + market 夹具 + redis)。
 * 所有创建的实体 id 带 process.pid,afterAll 删 data key + sRem INDEX。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const SHIPMENT_KEY = (id) => `MARKET:SHIPMENT:${id}`;
const SHIPMENT_INDEX = 'MARKET:SHIPMENT:INDEX';

gate('64 · market.shipment.get / list', () => {
    let redis;
    // 两条独立订单,id 带 pid 保证不同进程并发不互踩(实体 id 由服务生成,这里以 orderId 区分).
    const orderA = `mkt64-A-${process.pid}`;
    const orderB = `mkt64-B-${process.pid}`;
    const created = {};            // orderId -> shipment object
    const cleanup = [];            // shipment ids to remove

    beforeAll(async () => {
        redis = await redisLib.connect();

        for (const [orderId, address] of [[orderA, 'addr-A'], [orderB, 'addr-B']]) {
            const s = V.assertResult(
                await rpc('market.shipment.create', { orderId, paymentId: `pay-${orderId}`, address }, ADMIN_TOKEN),
                `create ${orderId}`,
            );
            created[orderId] = s;
            cleanup.push(s.id);
        }
    }, 30_000);

    afterAll(async () => {
        for (const id of cleanup) {
            await redis.del(SHIPMENT_KEY(id));
            await redis.sRem(SHIPMENT_INDEX, id);
        }
        await redis.quit();
    });

    test('setup: 两条发货单落库(state=CREATED + 在 INDEX)', async () => {
        for (const orderId of [orderA, orderB]) {
            const s = created[orderId];
            expect(s.id).toBeTruthy();
            await V.assertRecord(redis, SHIPMENT_KEY(s.id), { state: 'CREATED', orderId }, { indexKey: SHIPMENT_INDEX });
        }
    });

    test('get: 按 id 取回,字段与建单一致', async () => {
        const src = created[orderA];
        const got = V.assertResult(await rpc('market.shipment.get', { id: src.id }, ADMIN_TOKEN), 'get A');
        expect(got.id).toBe(src.id);
        expect(got.orderId).toBe(orderA);
        expect(got.paymentId).toBe(`pay-${orderA}`);
        expect(got.address).toBe('addr-A');
        expect(got.state).toBe('CREATED');
        expect(got.trackingNo).toBeNull();        // 未发货
    }, 30_000);

    test('get: 不存在的 id → NOT_FOUND(-32002)', async () => {
        const res = await rpc('market.shipment.get', { id: `nope-${process.pid}` }, ADMIN_TOKEN);
        // entity.get 对缺失记录抛 NOT_FOUND;断言可达(非 METHOD_NOT_FOUND)且 code=-32002.
        V.assertRpcError(res, -32002, 'get missing id');
    }, 30_000);

    test('list: 全量能找到刚建的两条;total ≥ items 数', async () => {
        const out = V.assertResult(await rpc('market.shipment.list', { pageSize: 500 }, ADMIN_TOKEN), 'list all');
        expect(Array.isArray(out.items)).toBe(true);
        expect(typeof out.total).toBe('number');
        expect(out.total).toBeGreaterThanOrEqual(out.items.length);

        for (const orderId of [orderA, orderB]) {
            const id = created[orderId].id;
            const row = out.items.find((x) => x.id === id);
            expect(row).toBeTruthy();
            expect(row.orderId).toBe(orderId);
            expect(row.state).toBe('CREATED');
        }
    }, 30_000);

    test('list({state}): CREATED 命中本套两条,SHIPPED 不含本套', async () => {
        const ids = new Set(cleanup);

        const createdList = V.assertResult(await rpc('market.shipment.list', { state: 'CREATED', pageSize: 500 }, ADMIN_TOKEN), 'list CREATED');
        // 过滤后每行都应是 CREATED,且本套两条都在其中.
        expect(createdList.items.every((x) => x.state === 'CREATED')).toBe(true);
        for (const id of ids) expect(createdList.items.some((x) => x.id === id)).toBe(true);

        const shippedList = V.assertResult(await rpc('market.shipment.list', { state: 'SHIPPED', pageSize: 500 }, ADMIN_TOKEN), 'list SHIPPED');
        expect(shippedList.items.every((x) => x.state === 'SHIPPED')).toBe(true);
        // 本套从不发货 → 两条都不应出现在 SHIPPED 列表.
        for (const id of ids) expect(shippedList.items.some((x) => x.id === id)).toBe(false);
    }, 30_000);
});
