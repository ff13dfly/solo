/**
 * 92 · ingress 外部 webhook 全链路真触发(把 33 与 91 之间缺的那条接缝补上)。
 *
 * 此前覆盖:
 *   33-ingress  只验到 "外部 webhook → ingress → EVENT:WEBHOOK 流"(止于落流)。
 *   91-trigger  只验 "合成 EVENT:PAYMENT → matcher → workflow 执行"(起于落流,且非真 webhook)。
 * 两半各自绿,但没人把它们接成一条 —— 没有任何 e2e 把 workflow 的 event_subscription
 * 挂到 EVENT:WEBHOOK:* 上、再用真 ingress webhook 入口一路打到 workflow 执行。本suite补这条:
 *
 *   外部 webhook(ingress.ingest + Authorization: ApiKey)
 *     → ingress 校验 key + 去重 + 经 Router event.emit(actor=webhook:{source})
 *     → EVENT:WEBHOOK:{NAME} 流(envelope.payload = { request_id, data })
 *     → orchestrator matcher 自动匹配订阅该流的 ACTIVE workflow(payload 成为 $input)
 *     → worker 入队 → runner(system.orchestrator bot,H6 footprint 通过)→ 真跑 step
 *     → 断言副作用:webhook.data.paymentId 指向的 payment 被 settle 成 SETTLED。
 *
 * full profile(需 ingress bot + matcher/worker ON + bot token + 注册表含 EVENT:WEBHOOK:*,harness 已配)。
 *
 * 时序关键(同 91):matcher 每 ≤5s(blockMs)重新发现 ACTIVE workflow 的订阅流,对新流用
 *   xGroupCreate('$', MKSTREAM) 建组——只收建组之后的新消息。必须先注入 workflow + 等建组,
 *   再发 webhook,否则 webhook 早于消费组、被漏掉。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

gate('92 · ingress external webhook → full chain → workflow execution', () => {
    let redis, sourceId, apiKey, stream, paymentId;
    const sname = `e2ewh${process.pid}`;
    const reqId = `wh-${process.pid}-1`;
    const WF_ID = `wf-e2e-webhook-${process.pid}`;
    const WF_KEY = `ORCHESTRATOR:WORKFLOW:${WF_ID}`;
    const WF_INDEX = 'ORCHESTRATOR:WORKFLOW_INDEX';   // matcher 用 SMEMBERS 读它发现 workflow

    beforeAll(async () => {
        redis = await redisLib.connect();

        // ① 建外部来源 → 一次性 apiKey + 下游流名 EVENT:WEBHOOK:{NAME_UPPER}
        const s = V.assertResult(await rpc('ingress.source.create', { name: sname, dedupTtlSec: 120 }, ADMIN_TOKEN), 'source.create');
        sourceId = s.id; apiKey = s.apiKey; stream = s.stream;

        // ② 预置一笔 payment(RECEIVED);webhook 触发的 workflow 的活儿就是把它 settle 掉
        const p = V.assertResult(await rpc('collection.payment.record', { amount: 55, currency: 'CNY', orderId: `wh-${process.pid}` }, ADMIN_TOKEN), 'record');
        paymentId = p.id;

        // ③ 注入订阅 EVENT:WEBHOOK:{NAME} 的 ACTIVE workflow;step 从 webhook payload 取 paymentId
        //    （matcher 把 envelope.payload = { request_id, data } 作为 $input,故用 $input.data.paymentId）
        await redis.json.set(WF_KEY, '$', {
            id: WF_ID, category: 'webhook-test', priority: 50,
            name: 'E2E webhook-driven settle', desc: 'EVENT:WEBHOOK → settle($input.data.paymentId)',
            tags: [], examples: [], negative: [], keywords: [], required_inputs: [], optional_inputs: [], synonyms: {}, resolvers: {},
            allowed_triggers: ['event'],
            event_subscriptions: [{ stream }],
            steps: [{ id: 'settle', service: 'collection', method: 'collection.payment.settle', params: { id: '$input.data.paymentId' } }],
            status: 'ACTIVE', submittedBy: 'ai-agent', approvals: [], createdAt: Date.now(), updatedAt: Date.now(),
        });
        await redis.sAdd(WF_INDEX, WF_ID);

        // ④ 等 matcher 重新发现该流 + 建消费组(blockMs=5000,留足余量)
        await sleep(8000);
    }, 30_000);

    afterAll(async () => {
        if (sourceId) await rpc('ingress.source.delete', { id: sourceId }, ADMIN_TOKEN).catch(() => {});
        await redis.del(`INGRESS:NAME:${sname}`);
        // 不删 EVENT:WEBHOOK:{NAME} 流:matcher 已对它建了活的消费组并在持续 XREADGROUP,
        // 删流会让它下个 loop 报 NOGROUP(污染 ERROR:QUEUE)。留着空流无害(同 91 留 EVENT:PAYMENT),
        // 由 harness teardown 的 SHUTDOWN NOSAVE 统一回收。先撤掉 workflow,matcher 自然不再为它派发。
        await redis.del(WF_KEY); await redis.sRem(WF_INDEX, WF_ID);
        if (paymentId) { await redis.del(`COLLECTION:PAYMENT:${paymentId}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', paymentId); }
        for (const k of await redisLib.scanAll(redis, 'ORCHESTRATOR:RUN:*')) {
            const run = await redis.json.get(k).catch(() => null);
            if (run && run.workflowId === WF_ID) { await redis.del(k); await redis.sRem('ORCHESTRATOR:RUN_INDEX', run.id); }
        }
        await redis.quit();
    });

    test('真外部 webhook → ingress → EVENT:WEBHOOK → matcher → workflow 把 payment settle 成 SETTLED', async () => {
        expect(await redis.sIsMember(WF_INDEX, WF_ID)).toBeTruthy();

        // 触发前:payment 仍是 RECEIVED(全程没人直接 settle)
        const pre = await V.readKey(redis, `COLLECTION:PAYMENT:${paymentId}`);
        expect(pre.state).toBe('RECEIVED');

        // ⑤ 真发一条外部 webhook(Authorization: ApiKey),data 携带 paymentId
        const before = await redis.xLen(stream).catch(() => 0);
        const res = V.assertResult(await rpc('ingress.ingest',
            { request_id: reqId, data: { paymentId, note: 'settle me' } },
            null, { authHeader: `ApiKey ${apiKey}` }), 'ingest');
        expect(res.ok).toBe(true);
        expect(await redis.xLen(stream)).toBe(before + 1);   // webhook 真落了 EVENT:WEBHOOK 一条

        // ⑥ 轮询:等 matcher→worker→runner 跑完,把 payment settle(最长 ~25s)
        let settled = false;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const cur = await V.readKey(redis, `COLLECTION:PAYMENT:${paymentId}`);
            if (cur && cur.state === 'SETTLED') { settled = true; break; }
        }
        expect(settled).toBe(true);   // ← 全链路打通:一条外部 webhook 一路驱动到 workflow 执行

        // 留痕:存在一条引用本 workflow 的 run 文档
        let runFound = false;
        for (const k of await redisLib.scanAll(redis, 'ORCHESTRATOR:RUN:*')) {
            const run = await redis.json.get(k).catch(() => null);
            if (run && run.workflowId === WF_ID) { runFound = true; break; }
        }
        expect(runFound).toBe(true);
    }, 45_000);

    test('去重护栏:同 request_id 重投 → ingress 丢弃、流不增(不会二次触发 workflow)', async () => {
        const before = await redis.xLen(stream);
        await rpc('ingress.ingest', { request_id: reqId, data: { paymentId } }, null, { authHeader: `ApiKey ${apiKey}` });
        await sleep(300);
        expect(await redis.xLen(stream)).toBe(before);   // 去重 → 不落新流 → 不会再触发一次 run
    }, 20_000);
});
