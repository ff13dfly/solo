/**
 * 65 · nexus 上下文装配（context.md v1）—— "获取哪些数据 / 做哪些输出"那条端到端.
 *
 * 验证 nexus 在事件到达后、投递前,按 Agent 档案的声明式 `context` 完成:
 *   ① guard          —— JsonLogic 判断是否唤醒(只对带本测 tag 的事件装配)
 *   ② data_fetchers  —— 经 system.nexus relay 拉 collection.payment.get(只读)
 *   ③ system_prompt  —— 用 {{event.*}}/{{fetch.*}} 插值渲染
 * 产出 Context Payload 投进 Agent inbox(notification),断言 data + 渲染后的 prompt.
 *
 * 另测**配置时授权闸**:把写方法(collection.payment.record)配成 fetcher → create 被拒(只读后缀).
 *
 * 只在 full profile 跑:nexus 消费者只在 full 开(lite 设 NEXUS_CONSUMER=false),
 * 且需 system.nexus relay token + permit(harness full 已配 notification.send/collection.payment.get).
 *
 * 时序:消费者在 boot 时对 EVENT:WORKFLOW:STATUS 从 '$' 建消费组(blockMs=5000).
 * 先 create agent(写 NEXUS:SUB 订阅集)→ 再 xAdd 事件 → 轮询 inbox.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// nexus 消费者固定消费此流(config.consumer.streams).Agent 订阅它,我们直接 xAdd 注入.
const STREAM = 'EVENT:WORKFLOW:STATUS';
const TAG = `ctx-${process.pid}`;

gate('65 · nexus context assembly (data_fetchers + guard + system_prompt)', () => {
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
            // inbox 清理:逐条删消息 + zset 索引
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

    // ── 配置时授权闸:写方法不能当 fetcher ──────────────────────────────────────

    test('create with a WRITE-method fetcher → rejected (read-only gate, -32602)', async () => {
        const res = await rpc('nexus.sentinel.create', {
            name: `e2e-ctx-bad-${process.pid}`,
            authorityRole: 'test:ctx',
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                data_fetchers: [
                    { key: 'p', method: 'collection.payment.record', params: {} },
                ],
            },
        }, ADMIN_TOKEN);
        expect(res.error).toBeTruthy();
        expect(res.error.code).toBe(-32602);
        expect(String(res.error.message)).toMatch(/read-only|record/i);
    }, 30_000);

    test('create with a cyclic data_fetcher DAG → rejected (-32602)', async () => {
        const res = await rpc('nexus.sentinel.create', {
            name: `e2e-ctx-cycle-${process.pid}`,
            authorityRole: 'test:ctx',
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                data_fetchers: [
                    { key: 'a', method: 'collection.payment.get', params: {}, depends_on: ['b'] },
                    { key: 'b', method: 'collection.payment.get', params: {}, depends_on: ['a'] },
                ],
            },
        }, ADMIN_TOKEN);
        expect(res.error).toBeTruthy();
        expect(res.error.code).toBe(-32602);
        expect(String(res.error.message)).toMatch(/cyclic|cycle/i);
    }, 30_000);

    // ── 端到端:事件 → 装配 → Context Payload 进 inbox ───────────────────────────

    test('event → nexus assembles (fetch + render) → enriched payload in agent inbox', async () => {
        // 1. 一笔待"审核"的付款,供 fetcher 拉取
        const p = V.assertResult(await rpc('collection.payment.record', {
            amount: 4242, currency: 'CNY', orderId: `ctx-${process.pid}`,
        }, ADMIN_TOKEN), 'payment.record');
        paymentId = p.id;

        // 2. 带 context 的 Agent:guard 锁本测 tag + fetcher 拉 payment + 渲染 prompt
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-ctx-agent-${process.pid}`,
            authorityRole: 'test:ctx',
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                data_fetchers: [
                    { key: 'payment', method: 'collection.payment.get', params: { id: '{{event.paymentId}}' } },
                ],
                system_prompt_template: '审核付款 {{event.paymentId}}：金额 {{fetch.payment.amount}} {{fetch.payment.currency}}',
            },
        }, ADMIN_TOKEN), 'agent.create');
        agentId = a.id;
        // 落库:档案带 context;订阅写入 SUB 集
        await V.assertRecord(redis, `NEXUS:SENTINEL:${agentId}`, { status: 'ACTIVE' });
        expect(await redis.sIsMember(`NEXUS:SUB:${STREAM}`, agentId)).toBeTruthy();

        await sleep(800); // 确保订阅集对消费者可见

        // 3. 注入一个真事件(nexus 消费者会拉到)
        await redis.xAdd(STREAM, '*', { tag: TAG, paymentId, kind: 'e2e' });

        // 4. 轮询 inbox 等装配后的消息(消费 blockMs=5000 + 装配,留足 ~25s)
        let msg = null;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const r = await rpc('notification.inbox.list', { targetId: agentId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            msg = items.find((m) => m.payload && m.payload.context && m.payload.context.data && m.payload.context.data.payment);
            if (msg) break;
        }
        expect(msg).toBeTruthy();

        // ② data_fetcher 真拉到了 payment(经 system.nexus relay 调 collection.payment.get)
        expect(msg.payload.context.data.payment.amount).toBe(4242);
        expect(msg.payload.context.data.payment.currency).toBe('CNY');
        // ③ system_prompt 用 event + fetch 双命名空间渲染
        expect(msg.payload.context.system_prompt).toContain(paymentId);
        expect(msg.payload.context.system_prompt).toContain('4242');
        // Context Payload 结构(context.md §6):event.type = 流 key,event.payload 原始事件
        expect(msg.payload.event.type).toBe(STREAM);
        expect(msg.payload.event.payload.tag).toBe(TAG);
        // sentinel 命名空间也在
        expect(msg.payload.context.sentinel.id).toBe(agentId);
    }, 60_000);
});
