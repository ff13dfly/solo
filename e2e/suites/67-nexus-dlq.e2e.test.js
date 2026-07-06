/**
 * 67 · nexus 投递可靠性 —— ①死信(DLQ)+ 重试 + ②幂等(notification 去重).
 *
 * ① 注入"装配必失败"的 Agent(data_fetcher 调 nexus **无权限** 的 market.shipment.get
 *    → FORBIDDEN → on_error:abort → 装配失败)。消费者**成功才 ack**:失败留 PEL、按退避重试,
 *    超过 maxDeliveries(harness=2)→ 进 NEXUS:DLQ(不再静默丢)。断言 `nexus.dlq.list` 收到它,
 *    `nexus.dlq.retry` 能把它重投回源流并移除 DLQ 条目。
 * ② 同一 (targetId, ref) 调两次 `notification.send` → 第二次判重(`status:'duplicate'`),inbox 只 1 条。
 *    这让"至少一次重投"安全(重投不重复落 inbox)。
 *
 * 只在 full profile 跑。harness 配了小退避/低死信阈值(NEXUS_MAX_DELIVERIES=2,RETRY_BASE_MS=600,
 * CONSUMER_BLOCK_MS=1000),几秒内到 DLQ。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STREAM = 'EVENT:WORKFLOW:STATUS';
const TAG = `dlq-${process.pid}`;

gate('67 · nexus delivery reliability (DLQ + retry + idempotency)', () => {
    let redis;
    let agentId;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        if (agentId) {
            await redis.del(`NEXUS:SENTINEL:${agentId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', agentId);
            await redis.sRem(`NEXUS:SUB:${STREAM}`, agentId);
        }
        // 清掉本测产生的 DLQ 条目(按 tag 认领)
        try {
            const entries = await redis.xRange('NEXUS:DLQ', '-', '+');
            for (const e of entries) {
                let ev = {};
                try { ev = JSON.parse(e.message.event); } catch (_) { /* ignore */ }
                if (ev && ev.tag === TAG) await redis.xDel('NEXUS:DLQ', e.id);
            }
        } catch (_) { /* DLQ may not exist */ }
        // 幂等测的痕迹
        const dedupTarget = `e2e-dedup-${process.pid}`;
        const ids = await redis.zRange(`NOTIFICATION:INBOX:${dedupTarget}`, 0, -1);
        for (const id of ids) await redis.del(`NOTIFICATION:MSG:${id}`);
        await redis.del(`NOTIFICATION:INBOX:${dedupTarget}`);
        await redis.del(`NOTIFICATION:DEDUP:${dedupTarget}:r-${process.pid}`);
        await redis.quit();
    });

    // ── ① 失败不再静默丢 → 进 DLQ → 可重投 ───────────────────────────────────────

    test('undeliverable event → retried → parked to DLQ (not silently dropped)', async () => {
        // Agent 装配必失败:fetch 一个 nexus 服务账号无权限的方法(market.* 不在 system.nexus permit).
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-dlq-${process.pid}`,
            authorityRole: 'test:dlq',
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                data_fetchers: [
                    // market.shipment.get 是只读后缀(过得了配置闸),但 nexus 无 market permit → 运行时 FORBIDDEN.
                    { key: 's', method: 'market.shipment.get', params: { id: '{{event.x}}' } },
                ],
            },
        }, ADMIN_TOKEN), 'agent.create');
        agentId = a.id;

        await sleep(800);
        await redis.xAdd(STREAM, '*', { tag: TAG, x: 'nope', kind: 'e2e' });

        // 轮询 DLQ 等本事件落死信(退避 ~600ms × 2 次 + 1s block,留足 ~25s).
        let entry = null;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const r = await rpc('nexus.dlq.list', { pageSize: 200 }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            entry = items.find((it) => it.event && it.event.tag === TAG);
            if (entry) break;
        }
        expect(entry).toBeTruthy();
        expect(entry.sourceStream).toBe(STREAM);
        expect(entry.attempts).toBeGreaterThanOrEqual(2);   // 重试过,不是一次就丢
        expect(entry.event.x).toBe('nope');                 // 原始事件完整保留(可重投)

        // 重投:把它重新打回源流 + 移除该 DLQ 条目.
        const dlqId = entry.id;
        const re = V.assertResult(await rpc('nexus.dlq.retry', { id: dlqId }, ADMIN_TOKEN), 'dlq.retry');
        expect(re.retried).toBe(true);
        expect(re.sourceStream).toBe(STREAM);
        expect(re.newId).toBeTruthy();

        // 该具体 DLQ 条目已删除(重投后会以新 id 再次失败入 DLQ,但旧 id 必须没了).
        let stillThere = true;
        for (let i = 0; i < 10; i++) {
            const r = await rpc('nexus.dlq.list', { pageSize: 200 }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            stillThere = items.some((it) => it.id === dlqId);
            if (!stillThere) break;
            await sleep(300);
        }
        expect(stillThere).toBe(false);

        // 收尾:disable 该 Agent,别让重投后的事件一直制造 DLQ 噪音.
        await rpc('nexus.sentinel.disable', { id: agentId }, ADMIN_TOKEN);
    }, 60_000);

    // ── ② notification.send 幂等(同 ref 不重复落 inbox) ──────────────────────────

    test('same (targetId, ref) sent twice → deduped → exactly one inbox message', async () => {
        const targetId = `e2e-dedup-${process.pid}`;
        const ref = `r-${process.pid}`;

        const first = V.assertResult(await rpc('notification.send', {
            targetId, type: 'EVENT:E2E:DEDUP', payload: { n: 1 }, ref,
        }, ADMIN_TOKEN), 'send#1');
        expect(first.status).toBe('stored');

        const second = V.assertResult(await rpc('notification.send', {
            targetId, type: 'EVENT:E2E:DEDUP', payload: { n: 2 }, ref,
        }, ADMIN_TOKEN), 'send#2');
        expect(second.status).toBe('duplicate');
        expect(second.id).toBe(first.id);   // 返回的是首条 id

        // inbox 只有 1 条
        const box = V.assertResult(await rpc('notification.inbox.list', { targetId, unreadOnly: false }, ADMIN_TOKEN), 'inbox.list');
        expect(box.total).toBe(1);
        expect(box.items[0].payload.n).toBe(1);   // 第二次的 payload 没覆盖第一条
    }, 30_000);
});
