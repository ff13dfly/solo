/**
 * 91 · matcher 驱动的真事件触发(§9 P5 的最后一环).
 *
 * 与 90 的区别:90 是 **direct 编排**(测试以 admin 按序调各 hop)。91 是 **真事件驱动**:
 *   注入一个 ACTIVE workflow(订阅 EVENT:PAYMENT:RECEIVED,step=collection.payment.settle)
 *   → 发一个真事件(collection.payment.record 的 _event)
 *   → orchestrator **matcher 自动**匹配 + 在 system.orchestrator bot permit 下跑 workflow
 *   → 断言副作用(payment 自己变 SETTLED,我们没直接调 settle)。
 *
 * 这验证整条事件总线:_event 落流 → matcher 消费 → worker 入队 → runner H6 → 真执行.
 * 只在 full profile 跑(需 matcher/worker ON + bot token,harness full 已配).
 *
 * 时序关键:matcher 每 ≤5s(blockMs)重新发现 ACTIVE workflow 的订阅流,并对新流
 * 从 '$'(只读新消息)建消费组。必须先注入 + 等建组,再发事件,否则事件早于消费组、丢失。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

gate('91 · matcher-driven real-event trigger', () => {
    let redis;
    const WF_ID = `wf-e2e-autosettle-${process.pid}`;
    const WF_KEY = `ORCHESTRATOR:WORKFLOW:${WF_ID}`;
    const WF_INDEX = 'ORCHESTRATOR:WORKFLOW_INDEX';   // matcher 现用 SMEMBERS(非 KEYS)读它
    let paymentId;

    function workflowDoc(now) {
        return {
            id: WF_ID,
            category: 'event-test',
            priority: 50,
            name: 'E2E auto-settle (event test)',
            desc: 'EVENT:PAYMENT:RECEIVED → collection.payment.settle($input.paymentId)',
            tags: [], examples: [], negative: [], keywords: [],
            required_inputs: [], optional_inputs: [], synonyms: {}, resolvers: {},
            allowed_triggers: ['event'],
            event_subscriptions: [{ stream: 'EVENT:PAYMENT:RECEIVED' }],
            steps: [{ id: 'settle', service: 'collection', method: 'collection.payment.settle', params: { id: '$input.paymentId' } }],
            status: 'ACTIVE',
            submittedBy: 'ai-agent',
            approvals: [],
            createdAt: now, updatedAt: now,
        };
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        // 注入 ACTIVE workflow(RedisJSON doc;matcher 从 doc 读 event_subscriptions).
        await redis.json.set(WF_KEY, '$', workflowDoc(Date.now()));
        await redis.sAdd(WF_INDEX, WF_ID);   // 直接注入也要维护 index,否则 matcher(SMEMBERS)找不到
        // 等 matcher 重新发现该流并从 '$' 建消费组(blockMs=5000,留足余量).
        await sleep(8000);
    }, 20_000);

    afterAll(async () => {
        await redis.del(WF_KEY);
        await redis.sRem(WF_INDEX, WF_ID);
        // matcher 的订阅快照每 ≤5s(blockMs)才重建:删除后立刻结束本套,下一套若马上
        // record 支付,旧快照仍会对 EVENT:PAYMENT:RECEIVED(全局流!)enqueue 一次
        // settle —— 污染下一套的 WAL/状态断言(98/20 实测中过招)。等一个发现周期排干。
        await sleep(7000);
        if (paymentId) { await redis.del(`COLLECTION:PAYMENT:${paymentId}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', paymentId); }
        // 清掉本 workflow 产生的 run 文档 + run 索引.
        for (const k of await redisLib.scanAll(redis, 'ORCHESTRATOR:RUN:*')) {
            const run = await redis.json.get(k).catch(() => null);
            if (run && run.workflowId === WF_ID) { await redis.del(k); await redis.sRem('ORCHESTRATOR:RUN_INDEX', run.id); }
        }
        await redis.quit();
    }, 20_000);

    test('emit EVENT:PAYMENT:RECEIVED → matcher auto-runs workflow → payment becomes SETTLED', async () => {
        // 守护:matcher 现靠 index set(SMEMBERS)发现 workflow,不再 KEYS 全库扫.
        expect(await redis.sIsMember(WF_INDEX, WF_ID)).toBeTruthy();

        // 触发:record 一笔(emits EVENT:PAYMENT:RECEIVED,payload.paymentId = 新 id).
        const p = V.assertResult(await rpc('collection.payment.record', { amount: 77, currency: 'CNY', orderId: `auto-${process.pid}` }, ADMIN_TOKEN), 'record');
        paymentId = p.id;
        expect(p.state).toBe('RECEIVED');   // 我们只 record,从不直接 settle

        // 轮询:等 matcher→worker→runner 把它跑成 SETTLED(最长 ~25s).
        let settled = false;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const cur = await V.readKey(redis, `COLLECTION:PAYMENT:${paymentId}`);
            if (cur && cur.state === 'SETTLED') { settled = true; break; }
        }
        expect(settled).toBe(true);   // ← 没人直接调 settle,是 matcher 驱动的 workflow 干的

        // 留痕:存在一条引用本 workflow 的 run 文档.
        let runFound = false;
        for (const k of await redisLib.scanAll(redis, 'ORCHESTRATOR:RUN:*')) {
            const run = await redis.json.get(k).catch(() => null);
            if (run && run.workflowId === WF_ID) { runFound = true; break; }
        }
        expect(runFound).toBe(true);
    }, 40_000);
});
