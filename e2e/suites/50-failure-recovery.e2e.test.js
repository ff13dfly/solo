/**
 * 50 · 失败恢复(异步 worker 的重试 / 死信 / 人在环).
 *   ① notification 投递失败 → 进 RETRY(attempts≥1)
 *   ② notification 攒到死信 → deadletter.list 可见 → requeue 拉回
 *   ③ orchestrator 事件触发的 run 因 bot permit 不覆盖 → H6 暂停(PAUSED_AWAITING_HUMAN)→ grant → 离开暂停
 * 确定性失败杠杆(2026-06-11 更新):webhook 投递到本机关闭端口(127.0.0.1:9)→ 连接拒绝
 *   → 瞬时网络错 → 重试语义。旧杠杆"email 空 params"已失效——地址解析链(2026-06-10)
 *   会把无地址的 email 降级回 inbox(degraded,不算失败不重试),不再产生 RETRY/死信。
 *   workflow step 用 bot permit 没有的方法(storage.asset.upload)触发 H6.
 * full profile(需 worker + bot token + WEBHOOK_ALLOW_LOOPBACK=1,harness 已配).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, { timeout = 15000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(interval); }
    return null;
}

gate('50 · failure recovery (retry / dead-letter / human-in-loop)', () => {
    let redis;
    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => { await redis.quit(); });

    test('① notification 投递失败 → 进 RETRY(attempts≥1)', async () => {
        const target = `e2e-fail-tgt-${process.pid}`;
        // webhook 投递到关闭端口 → gateway POST 连接拒绝 → 瞬时错 → worker 退避重试
        V.assertResult(await rpc('notification.config.set', { targetId: target, rules: [{ type: '*', channel: 'webhook', params: { url: 'http://127.0.0.1:9/e2e-dead-endpoint' } }] }, ADMIN_TOKEN), 'config.set');
        const sent = V.assertResult(await rpc('notification.send', { targetId: target, type: 'e2e.fail', payload: { x: 1 } }, ADMIN_TOKEN), 'send');
        const msgId = sent.id || sent.messageId;
        expect(msgId).toBeTruthy();

        // worker 取走 → 投递失败 → zAdd NOTIFICATION:QUEUE:RETRY,member 里 attempts≥1
        const found = await poll(async () => {
            const members = await redis.zRange('NOTIFICATION:QUEUE:RETRY', 0, -1);
            for (const m of members) { try { const t = JSON.parse(m); if (t.messageId === msgId && t.attempts >= 1) return t; } catch {} }
            return null;
        });
        expect(found).toBeTruthy();
        expect(found.attempts).toBeGreaterThanOrEqual(1);

        // 清理:把它从 RETRY 移除 + 删 msg/config
        const members = await redis.zRange('NOTIFICATION:QUEUE:RETRY', 0, -1);
        for (const m of members) { try { if (JSON.parse(m).messageId === msgId) await redis.zRem('NOTIFICATION:QUEUE:RETRY', m); } catch {} }
        await redis.del(`NOTIFICATION:MSG:${msgId}`); await redis.del(`NOTIFICATION:CONFIG:${target}`); await redis.del(`NOTIFICATION:INBOX:${target}`);
    }, 40_000);

    test('② notification 死信 + requeue', async () => {
        // 先 send 出一条真实 msg(无 config → 不自动派发);否则 worker 因"msg 不存在"直接丢弃任务(worker.js:5-7).
        const target = `e2e-dl-tgt-${process.pid}`;
        const sent = V.assertResult(await rpc('notification.send', { targetId: target, type: 'e2e.dl', payload: {} }, ADMIN_TOKEN), 'send');
        const dlMsg = sent.id || sent.messageId;
        // 注入 attempts=4(差一步到 maxRetries=5)的任务 → worker 取走再失败一次 → 进 DEADLETTER
        // (webhook+关闭端口=瞬时失败;email 空 params 现在会降级回 inbox,不再适用)
        await redis.lPush('NOTIFICATION:QUEUE:PENDING', JSON.stringify({ messageId: dlMsg, channel: 'webhook', params: { url: 'http://127.0.0.1:9/e2e-dead-endpoint' }, attempts: 4 }));

        const inDead = await poll(async () => {
            const items = await redis.lRange('NOTIFICATION:QUEUE:DEADLETTER', 0, -1);
            return items.find((m) => { try { return JSON.parse(m).messageId === dlMsg; } catch { return false; } }) || null;
        });
        expect(inDead).toBeTruthy();   // 攒满重试 → 进死信

        const list = V.assertResult(await rpc('notification.deadletter.list', { page: 1, pageSize: 50 }, ADMIN_TOKEN), 'deadletter.list');
        expect(list.items.some((x) => x.messageId === dlMsg)).toBe(true);

        const rq = V.assertResult(await rpc('notification.deadletter.requeue', { messageId: dlMsg }, ADMIN_TOKEN), 'deadletter.requeue');
        expect(rq.requeued).toBeGreaterThanOrEqual(1);   // 拉回 PENDING(attempts 归零)

        // 清理:把可能在各队列里的该任务清掉
        await sleep(500);
        for (const k of ['NOTIFICATION:QUEUE:PENDING', 'NOTIFICATION:QUEUE:DEADLETTER']) {
            for (const m of await redis.lRange(k, 0, -1)) { try { if (JSON.parse(m).messageId === dlMsg) await redis.lRem(k, 0, m); } catch {} }
        }
        for (const m of await redis.zRange('NOTIFICATION:QUEUE:RETRY', 0, -1)) { try { if (JSON.parse(m).messageId === dlMsg) await redis.zRem('NOTIFICATION:QUEUE:RETRY', m); } catch {} }
        await redis.del(`NOTIFICATION:MSG:${dlMsg}`); await redis.zRem('NOTIFICATION:INDEX', dlMsg); await redis.del(`NOTIFICATION:INBOX:${target}`);
    }, 40_000);

    test('③ orchestrator H6 人在环:bot 不覆盖 → run 暂停 → grant → 离开暂停', async () => {
        // 注入 ACTIVE workflow,step 用 bot permit 没有的方法(storage.asset.upload)→ H6 footprint 预审失败.
        const wfId = `wf-e2e-h6-${process.pid}`;
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${wfId}`, '$', {
            id: wfId, category: 'e2e-fail', priority: 50, name: 'H6 pause test', desc: 'step exceeds bot permit',
            tags: [], examples: [], negative: [], keywords: [], required_inputs: [], optional_inputs: [], synonyms: {}, resolvers: {},
            allowed_triggers: ['event'],
            event_subscriptions: [{ stream: 'EVENT:E2E:H6' }],
            steps: [{ id: 's1', service: 'storage', method: 'storage.asset.upload', params: { file: 'eA==', filename: 'x', mimeType: 'text/plain' } }],
            status: 'ACTIVE', submittedBy: 'ai-agent', approvals: [], createdAt: Date.now(), updatedAt: Date.now(),
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', wfId);

        // 异步入队(admin)→ worker 跑(system.orchestrator bot)→ H6 缺 storage → NeedsGrant → 暂停
        const cmd = V.assertResult(await rpc('orchestrator.run.enqueue', { workflowId: wfId, input: {}, triggerSource: 'event' }, ADMIN_TOKEN), 'run.enqueue');
        const runId = cmd.runId;
        expect(runId).toBeTruthy();

        const paused = await poll(async () => {
            const run = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`).catch(() => null);
            return run && run.status === 'PAUSED_AWAITING_HUMAN' ? run : null;
        }, { timeout: 20000 });
        expect(paused).toBeTruthy();                                  // H6 暂停
        expect(paused.missingMethods).toContain('storage.asset.upload');

        // 人工 grant → 离开 PAUSED(RESUMING/或继续推进)
        V.assertResult(await rpc('orchestrator.run.grant', { id: runId, methods: ['storage.asset.upload'] }, ADMIN_TOKEN), 'run.grant');
        const left = await poll(async () => {
            const run = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`).catch(() => null);
            return run && run.status !== 'PAUSED_AWAITING_HUMAN' ? run : null;
        }, { timeout: 20000 });
        expect(left).toBeTruthy();                                    // grant 后离开暂停态(人在环闭环)

        // 清理
        await redis.del(`ORCHESTRATOR:WORKFLOW:${wfId}`); await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', wfId);
        await redis.del(`ORCHESTRATOR:RUN:${runId}`); await redis.del(`ORCHESTRATOR:RUN:${runId}:GRANT`); await redis.sRem('ORCHESTRATOR:RUN_INDEX', runId);
    }, 60_000);
});
