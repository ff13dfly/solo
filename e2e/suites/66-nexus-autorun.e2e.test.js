/**
 * 66 · nexus autorun 闭环 —— context.md §11 "下游消费出口" 的端到端.
 *
 * 验证 event → nexus 装配(拉数据 + 渲染 prompt)→ **调 LLM** → 产出回投 inbox 全链路:
 *   nexus 作为 built-in agent runtime,对 context.autorun=true 的 Agent,装配后经 Router
 *   (system.nexus bot)调 `agent.chat`,把 LLM 产出挂到 context.output 一并投递。
 *
 * LLM 用 agent 服务的**离线 mock provider**(AI_PROVIDER=mock,harness 对 agent 注入):
 * autorun 现在调 **agent.decide**(结构化决策契约),mock.decide 把渲染好的 prompt 回显进
 * `reason`(`MOCK_DECIDE::<prompt>`),并给出 { decision, confidence:0.9, escalate:false }。
 * 因 prompt 由拉取到的 payment.amount 渲染而成,故"reason 里出现该金额" = 证明
 * event→fetch→render→decide→output 全通且确定性,且 output 是结构化决策而非自由文本。
 *
 * 只在 full profile 跑(需 nexus 消费者 + agent 服务 + system.nexus 的 agent.decide permit,
 * harness full 已配)。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STREAM = 'EVENT:WORKFLOW:STATUS';
const TAG = `auto-${process.pid}`;

gate('66 · nexus autorun (assemble → mock LLM → output in inbox)', () => {
    let redis;
    let agentId;
    let paymentId;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        if (agentId) {
            await redis.del(`NEXUS:SENTINEL:${agentId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', agentId);
            await redis.sRem(`NEXUS:SUB:${STREAM}`, agentId);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${agentId}`);
            const ids = await redis.zRange(`NOTIFICATION:INBOX:${agentId}`, 0, -1);
            for (const id of ids) await redis.del(`NOTIFICATION:MSG:${id}`);
            await redis.del(`NOTIFICATION:INBOX:${agentId}`);
        }
        if (paymentId) {
            await redis.del(`COLLECTION:PAYMENT:${paymentId}`);
            await redis.sRem('COLLECTION:PAYMENT:INDEX', paymentId);
        }
        await redis.quit();
    });

    test('agent.decide (mock provider) is reachable & deterministic', async () => {
        // 先单独确认 mock 决策契约通(经 Router,admin token):闭集内选第一项,reason 回显 instruction.
        const r = V.assertResult(await rpc('agent.decide', {
            instruction: 'ping-42', choices: ['review', 'approve'],
        }, ADMIN_TOKEN), 'agent.decide');
        expect(r.decision).toBe('review');           // mock 选 choices[0]
        expect(r.escalate).toBe(false);              // confidence 0.9 ≥ 0.6
        expect(r.reason).toContain('ping-42');       // instruction 回显进 reason
        expect(r.metadata.provider).toBe('mock');
    }, 30_000);

    test('event → assemble → mock LLM → output delivered to agent inbox', async () => {
        // 1. 待"审核"的付款(唯一金额,便于在产出里断言)
        const p = V.assertResult(await rpc('collection.payment.record', {
            amount: 7777, currency: 'CNY', orderId: `auto-${process.pid}`,
        }, ADMIN_TOKEN), 'payment.record');
        paymentId = p.id;

        // 2. autorun Agent:guard 锁 tag + 拉 payment + 渲染 prompt + autorun=true
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-autorun-${process.pid}`,
            authorityRole: 'test:autorun',
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                data_fetchers: [
                    { key: 'payment', method: 'collection.payment.get', params: { id: '{{event.paymentId}}' } },
                ],
                system_prompt_template: '请审核付款 {{event.paymentId}}，金额 {{fetch.payment.amount}} {{fetch.payment.currency}}，给出结论。',
                autorun: { choices: ['approve', 'review'] },
            },
        }, ADMIN_TOKEN), 'sentinel.create');
        agentId = a.id;

        await sleep(800);

        // 3. 注入事件
        await redis.xAdd(STREAM, '*', { tag: TAG, paymentId, kind: 'e2e' });

        // 4. 轮询 inbox 等"带结构化决策"的消息(装配 + agent.decide,留足 ~25s)
        let msg = null;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const r = await rpc('notification.inbox.list', { targetId: agentId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            msg = items.find((m) => m.payload && m.payload.context
                && m.payload.context.output && typeof m.payload.context.output === 'object');
            if (msg) break;
        }
        expect(msg).toBeTruthy();

        const ctx = msg.payload.context;
        // 闭环断言:产出是**结构化决策**(inverted gate:decision ∈ choices),且 reason 回显的
        // 渲染 prompt **包含拉取到的金额** → 证明 event → fetch(amount) → render → decide → output 全通.
        expect(['approve', 'review']).toContain(ctx.output.decision);  // 闭集内
        expect(typeof ctx.output.confidence).toBe('number');
        expect(ctx.output.escalate).toBe(false);                       // 高置信 ⇒ 不升级
        expect(ctx.output.reason).toContain('MOCK_DECIDE::');
        expect(ctx.output.reason).toContain('7777');
        expect(ctx.output.reason).toContain(paymentId);
        expect(ctx.model).toBeTruthy();           // mock 模型名回填
        // 装配数据仍在
        expect(ctx.data.payment.amount).toBe(7777);
    }, 60_000);
});
