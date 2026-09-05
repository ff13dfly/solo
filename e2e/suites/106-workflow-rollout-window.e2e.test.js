/**
 * 106 · 事件触发型 workflow 的**上线 / 改版窗口**不再吃掉事件.
 *
 * 反馈: docs/feedback/done/event-triggered-workflow-lifecycle-drops-events.md
 * 现象(steward 线上实测): 把一条事件触发型 workflow 上线或改一版, 必须依次穿过两个窗口,
 * 两个窗口里的真实触发都被静默吃掉 ——
 *
 *   ① 无 ACTIVE 订阅者(审批中 / 删了重建)  → 匹配为空 → **ack 丢弃**, 连 run 都没建过
 *   ② ACTIVE 但在冷却期                    → 入队 → 冷却拒 → **DEADLETTER**, 且捞不回来
 *
 * 本套用真栈把四条修复各钉一次:
 *   1. 窗口① 事件被 PARK 而不是丢弃; 审批之后自动释放并真的跑起来(副作用可见)
 *   2. 窗口② 冷却拒绝落 DEFERRED_COOLING + RETRY zset, 而不是 DEADLETTER
 *   3. run.revive 能把一条 DEADLETTER 重新驱动起来(此前 requeue 只收 STALLED)
 *   4. event.replay 能捞回消费组建组之前就到达的事件('$' 起点跳过的那些)
 *
 * 只在 full profile 跑(需 matcher/worker ON + bot token).
 * 时序: matcher 每 ≤5s(blockMs)重新发现订阅流并对新流从 '$' 建消费组 —— 先注入 workflow、
 * 等建组, 再发事件, 否则事件早于消费组、根本不会被投递(那是用例 4 故意制造的情形).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WF_PREFIX  = 'ORCHESTRATOR:WORKFLOW:';
const WF_INDEX   = 'ORCHESTRATOR:WORKFLOW_INDEX';
const RUN_INDEX  = 'ORCHESTRATOR:RUN_INDEX';
const PARK_KEY   = 'ORCHESTRATOR:EVENTQ:PARKED';
const RETRY_KEY  = 'ORCHESTRATOR:RUNQ:RETRY';
const DLQ_KEY    = 'ORCHESTRATOR:RUNQ:DEADLETTER';
const DISCOVER_MS = 8000;   // > blockMs(5s), 留足一个发现周期

gate('106 · rollout / revision window no longer eats events', () => {
    let redis;
    const TAG = `${process.pid}`;
    const created = { workflows: [], streams: [] };

    // 每个用例一条**专属流**: 全局流(EVENT:PAYMENT:* 之类)会被别的套件/别的 workflow 看见.
    const streamFor = (name) => `EVENT:E2E:ROLLOUT:${name.toUpperCase()}:${TAG}`;

    function workflowDoc(id, stream, over = {}) {
        const now = Date.now();
        return {
            id, category: 'event-test', priority: 50,
            name: `E2E rollout ${id}`, desc: 'rollout-window suite',
            tags: [], examples: [], negative: [], keywords: [],
            required_inputs: [], optional_inputs: [], synonyms: {}, resolvers: {},
            allowed_triggers: ['event'],
            event_subscriptions: [{ stream }],
            // 副作用可断言且幂等: 记一笔 payment, 之后用它证明 run 真的执行过.
            steps: [{
                id: 'record', service: 'collection', method: 'collection.payment.record',
                params: { amount: 11, currency: 'CNY', orderId: '$input.orderId' },
            }],
            status: 'ACTIVE', submittedBy: 'ai-agent', approvals: [],
            createdAt: now, updatedAt: now,
            ...over,
        };
    }

    async function putWorkflow(doc) {
        await redis.json.set(`${WF_PREFIX}${doc.id}`, '$', doc);
        await redis.sAdd(WF_INDEX, doc.id);          // 直接注入也要维护 index(matcher 走 SMEMBERS)
        if (!created.workflows.includes(doc.id)) created.workflows.push(doc.id);
        return doc;
    }

    // 直接 xAdd 标准信封: 本套测的是 matcher 之后的形状, 不是 emit 面的鉴权.
    async function emit(stream, payload) {
        if (!created.streams.includes(stream)) created.streams.push(stream);
        return redis.xAdd(stream, '*', {
            event_id: `evt-${TAG}-${Math.random().toString(16).slice(2, 10)}`,
            type: 'e2e.rollout',
            source: 'e2e', actor: 'uid-e2e',
            emitted_at: String(Date.now()), depth: '0',
            payload: JSON.stringify(payload),
        });
    }

    async function runsFor(workflowId) {
        const out = [];
        for (const k of await redisLib.scanAll(redis, 'ORCHESTRATOR:RUN:*')) {
            if (k.endsWith(':GRANT')) continue;
            const run = await redis.json.get(k).catch(() => null);
            if (run && run.workflowId === workflowId) out.push(run);
        }
        return out;
    }

    // 轮询到 fn() 返回真值; 超时返回 null(由调用方给出更具体的断言失败信息).
    async function until(fn, { tries = 40, everyMs = 500 } = {}) {
        for (let i = 0; i < tries; i++) {
            const v = await fn();
            if (v) return v;
            await sleep(everyMs);
        }
        return null;
    }

    async function parkedFor(stream) {
        const raws = await redis.lRange(PARK_KEY, 0, -1).catch(() => []);
        return raws.map((r) => { try { return JSON.parse(r); } catch { return null; } })
                   .filter((r) => r && r.stream === stream);
    }

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        for (const id of created.workflows) {
            await redis.del(`${WF_PREFIX}${id}`).catch(() => {});
            await redis.sRem(WF_INDEX, id).catch(() => {});
        }
        // matcher 的订阅快照每 ≤5s 才重建 —— 等一个发现周期排干, 免得删完之后旧快照
        // 还对本套的流 enqueue 一次, 污染下一套(91 的注释里踩过同款).
        await sleep(7000);
        for (const id of created.workflows) {
            for (const run of await runsFor(id)) {
                await redis.del(`ORCHESTRATOR:RUN:${run.id}`).catch(() => {});
                await redis.sRem(RUN_INDEX, run.id).catch(() => {});
            }
        }
        for (const s of created.streams) await redis.del(s).catch(() => {});
        // 本套 park 的条目若还剩(用例断言失败时), 别留给下一套.
        for (const s of created.streams) {
            for (const raw of await redis.lRange(PARK_KEY, 0, -1).catch(() => [])) {
                if (raw.includes(s)) await redis.lRem(PARK_KEY, 1, raw).catch(() => {});
            }
        }
        await redis.quit();
    }, 40_000);

    // ── 窗口① 审批中: park 而不是丢弃 ────────────────────────────────────────
    test('window ①: an event arriving while the workflow is under review is PARKED, then released on approval', async () => {
        const stream = streamFor('park');
        const wfId = `wf-e2e-park-${TAG}`;
        const orderId = `park-${TAG}`;

        // PENDING_REVIEW 的订阅者也会被 discoverStreams 发现 —— 这是关键:
        // 消费组必须在**审批之前**就建好, 否则 '$' 起点会直接跳过审批期间的事件.
        await putWorkflow(workflowDoc(wfId, stream, { status: 'PENDING_REVIEW' }));
        await sleep(DISCOVER_MS);

        await emit(stream, { orderId });

        const parked = await until(async () => {
            const p = await parkedFor(stream);
            return p.length ? p : null;
        });
        expect(parked).not.toBeNull();                       // 修复前: 这里是空的, 事件已被 ack 丢弃
        expect(parked[0].waitingFor).toContain(wfId);

        // 还没批 → 一条 run 都不该有
        expect(await runsFor(wfId)).toHaveLength(0);

        // 批准(注入 ACTIVE, 与 91 同款直接注入)
        const doc = await redis.json.get(`${WF_PREFIX}${wfId}`);
        await redis.json.set(`${WF_PREFIX}${wfId}`, '$', { ...doc, status: 'ACTIVE', updatedAt: Date.now() });

        // 释放 → 真的跑起来 → 副作用可见
        const runs = await until(async () => {
            const r = await runsFor(wfId);
            return r.length ? r : null;
        }, { tries: 40 });
        expect(runs).not.toBeNull();
        expect(runs[0].input).toMatchObject({ orderId });
        expect(runs[0].triggerSource).toBe(`event:${stream}`);

        // park 队列排空
        expect(await until(async () => (await parkedFor(stream)).length === 0 ? true : null)).toBe(true);

        // 终态: 步骤真执行了(payment 落库)
        const done = await until(async () => {
            const r = (await runsFor(wfId))[0];
            return r && ['DONE', 'FAILED'].includes(r.status) ? r : null;
        }, { tries: 60 });
        expect(done && done.status).toBe('DONE');
    }, 120_000);

    // ── 窗口② 冷却期: 延后而不是判死 ─────────────────────────────────────────
    test('window ②: a trigger inside the cooling period is DEFERRED (retry zset), never dead-lettered', async () => {
        const stream = streamFor('cooling');
        const wfId = `wf-e2e-cool-${TAG}`;
        const dlqBefore = await redis.lLen(DLQ_KEY).catch(() => 0);

        // ACTIVE, 但 effective_at 还在未来 —— 正是 approve 之后 24h 的那个窗口.
        const coolUntil = Date.now() + 45_000;
        await putWorkflow(workflowDoc(wfId, stream, { effective_at: coolUntil }));
        await sleep(DISCOVER_MS);

        await emit(stream, { orderId: `cool-${TAG}` });

        const deferred = await until(async () => {
            const r = (await runsFor(wfId))[0];
            return r && r.status === 'DEFERRED_COOLING' ? r : null;
        }, { tries: 40 });
        expect(deferred).not.toBeNull();                      // 修复前: 这里是 DEADLETTER
        expect(deferred.deferredUntil).toBe(coolUntil);

        // 命令躺在 RETRY zset 里等 effective_at, 而不是进 DLQ.
        const zcard = await redis.zCard(RETRY_KEY).catch(() => 0);
        expect(zcard).toBeGreaterThan(0);
        expect(await redis.lLen(DLQ_KEY).catch(() => 0)).toBe(dlqBefore);
    }, 120_000);

    // ── run.revive: 死信可以翻案 ─────────────────────────────────────────────
    test('run.revive re-drives a DEADLETTER run (requeue only ever accepted STALLED)', async () => {
        const stream = streamFor('revive');
        const wfId = `wf-e2e-revive-${TAG}`;
        const orderId = `revive-${TAG}`;
        await putWorkflow(workflowDoc(wfId, stream));         // ACTIVE, 无冷却

        // 造一条死信 run(等价于冷却窗口里被判死的那些): 直接注入终态文档.
        const runId = `run_e2e_rev_${TAG}`;
        await redis.json.set(`ORCHESTRATOR:RUN:${runId}`, '$', {
            id: runId, workflowId: wfId, input: { orderId },
            triggerSource: `event:${stream}`, triggerId: '1-1',
            actor: 'uid-e2e', actorSource: 'e2e', trace: null, parentEventId: null,
            attempts: 0, status: 'DEADLETTER',
            lastError: 'Workflow in cooling period until …', deadletteredAt: Date.now(),
        });
        await redis.sAdd(RUN_INDEX, runId);

        // 能看见(此前也能), 但此前无论如何都动不了它.
        const listed = V.assertResult(await rpc('orchestrator.run.list', { status: 'DEADLETTER' }, ADMIN_TOKEN), 'run.list');
        expect(listed.map((r) => r.id)).toContain(runId);

        // retry 明确拒绝, 并指向正确的动词.
        const retryRes = await rpc('orchestrator.run.retry', { id: runId }, ADMIN_TOKEN);
        expect(retryRes.error).toBeTruthy();
        expect(String(retryRes.error.message)).toMatch(/run\.revive/);

        const revived = V.assertResult(await rpc('orchestrator.run.revive', { id: runId }, ADMIN_TOKEN), 'run.revive');
        expect(revived).toMatchObject({ ok: true, runId, revives: 1 });

        const done = await until(async () => {
            const r = await redis.json.get(`ORCHESTRATOR:RUN:${runId}`).catch(() => null);
            return r && ['DONE', 'FAILED'].includes(r.status) ? r : null;
        }, { tries: 60 });
        expect(done && done.status).toBe('DONE');

        await redis.del(`ORCHESTRATOR:RUN:${runId}`).catch(() => {});
        await redis.sRem(RUN_INDEX, runId).catch(() => {});
    }, 120_000);

    // ── event.replay: 捞回建组之前就到的事件 ─────────────────────────────────
    test('event.replay recovers events that predate the consumer group (xGroupCreate uses $)', async () => {
        const stream = streamFor('replay');
        const wfId = `wf-e2e-replay-${TAG}`;
        const orderId = `replay-${TAG}`;

        // 先发事件 —— 此刻没有任何 workflow 订阅这条流, 消费组还不存在.
        // 这正是反馈 §2.1 实测表里 01:34 那一轮: 事件在流里, 却"无任何痕迹".
        await emit(stream, { orderId });

        await putWorkflow(workflowDoc(wfId, stream));
        await sleep(DISCOVER_MS);                            // 建组(从 '$'), 老事件不会被投递

        expect(await runsFor(wfId)).toHaveLength(0);         // 确认: 自动路径捞不到它

        const res = V.assertResult(await rpc('orchestrator.event.replay', { stream }, ADMIN_TOKEN), 'event.replay');
        expect(res).toMatchObject({ stream, scanned: 1, enqueued: 1, suppressed: 0, unmatched: 0 });

        const run = await until(async () => (await runsFor(wfId))[0] || null, { tries: 40 });
        expect(run).not.toBeNull();
        expect(run.input).toMatchObject({ orderId });

        // 再放一次: 幂等守卫拦住, 绝不重复触发副作用.
        const again = V.assertResult(await rpc('orchestrator.event.replay', { stream }, ADMIN_TOKEN), 'event.replay replay');
        expect(again).toMatchObject({ scanned: 1, enqueued: 0, suppressed: 1 });
    }, 120_000);
});
