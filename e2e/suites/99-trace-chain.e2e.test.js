/**
 * 99 · trace 全链传递 + 深度预算刹车(toFix §二.事件链 "trace 不传递" 修复验证)
 *
 * 链路(与 97 同构,但断言的是【链路标识】而不是业务结果):
 *
 *   xAdd TRIGGER(信封式:trace_id=T0, event_id=E0, depth=1)
 *     → nexus Sentinel(walContext 携带 T0)→ autorun → context.emit
 *     → Router event.emit:DECISION 信封 trace_id=T0、depth=2、parent_event_id=E0
 *     → orchestrator matcher → run 记录 trace=T0、parentEventId=决策事件 id
 *     → workflow step: collection.payment.record(worker 把 T0 放进 X-Trace-* 头)
 *     → collection 实体写 → WAL 账本行 trace=T0(上一轮留的字段位,这次灌上了)
 *     → _event 夹带 EVENT:PAYMENT:RECEIVED 信封 trace_id=T0、depth=3
 *
 * 加一脚刹车测试:TRIGGER2 带 depth=16(= EVENT_MAX_DEPTH)→ Sentinel emit 时
 * Router 判 17>16 → 决策事件被拦(写 0 条)+ ERROR:QUEUE 记 EVENT_DEPTH_EXCEEDED
 * —— 自喂事件环的有界终止。
 *
 * 仅 full profile。要求 router/nexus/orchestrator/collection 跑【本轮新代码】。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.pid;
const TAG = `trace-${PID}`;
// 流名带套件号:97 同进程(runInBand 同 PID)用的是 EVENT:E2E:TRIGGER:{PID},
// 其 afterAll 会删流 —— 同名共用会在组合跑时互相拆台(偶发 NOGROUP/丢投递)。
const TRIGGER = `EVENT:E2E:TRIGGER99:${PID}`;
const DECISION = `EVENT:E2E:DECISION99:${PID}`;
const WF_ID = `wf-99-trace-${PID}`;
const ORDER_ID = `ord-99-${PID}`;
const T0 = `e2etrace${PID}a`;          // 链 id(满足 trace.js 的 [A-Za-z0-9_-]{4,64})
const E0 = `e2eevent${PID}a`;          // 触发事件 id(parent 边的断言锚点)
const T1 = `e2etrace${PID}loop`;       // 刹车测试的链 id

gate('99 · trace propagates the whole chain; depth budget breaks loops', () => {
    let redis;
    let sentinelId;
    let decisionEnv = null;   // DECISION 信封(test 2 取得,后续测试复用)

    beforeAll(async () => {
        redis = await redisLib.connect();

        // 1. 注入 workflow W(ACTIVE):订阅 DECISION,step 直接打 collection。
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${WF_ID}`, '$', {
            id: WF_ID, name: 'e2e-99 trace chain', category: 'e2e',
            desc: 'assert trace_id survives sentinel→emit→workflow→entity-WAL',
            tags: [], examples: [], negative: [], keywords: [],
            required_inputs: [], optional_inputs: [], synonyms: {},
            steps: [{
                id: 'pay', service: 'collection', method: 'collection.payment.record',
                params: { amount: 777, currency: 'CNY', orderId: '$input.orderId', source: 'e2e-99' },
            }],
            resolvers: {}, allowed_triggers: ['event'],
            event_subscriptions: [{ stream: DECISION, filter: { type: 'DECISION' } }],
            status: 'ACTIVE', submittedBy: 'e2e', approvals: [], priority: 50,
            createdAt: now, updatedAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', WF_ID);

        // matcher 在 DECISION 上建组('$')必须早于决策事件 emit(97 的竞态教训)。
        let grouped = false;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            const groups = await redis.xInfoGroups(DECISION).catch(() => []);
            if (groups.some((g) => g.name === 'orchestrator')) { grouped = true; break; }
        }
        if (!grouped) throw new Error('matcher 未在 DECISION 上建组(orchestrator matcher 未运行?)');

        // 2. Sentinel:订阅 TRIGGER,autorun 决策,emit 到 DECISION。
        sentinelId = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-99-tracer-${PID}`,
            authorityRole: 'e2e:99-tracer',
            eventSubscriptions: [TRIGGER],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                system_prompt_template:
                    '订单 {{event.orderId}} 已验证(金额 777 CNY)。请在 approve / reject 中二选一:是否批准收款?',
                autorun: { choices: ['approve', 'reject'] },
                emit: {
                    stream: DECISION, type: 'DECISION',
                    emit_when: { '==': [{ var: 'output.escalate' }, false] },
                    payload_template: {
                        decision: '{{output.decision}}',
                        orderId: '{{event.orderId}}',
                        by: '{{sentinel.id}}',
                    },
                },
            },
        }, ADMIN_TOKEN), 'sentinel.create').id;

        // nexus 消费者在 TRIGGER 上从 '$' 建组——必须等组真建好再 xAdd,否则条目落在
        // 组起点之前,永远不会投递(首跑 3 失 1 过的根因:后发的 test-4 触发一切正常,
        // 说明链路通,只有这第一条赶在建组前)。
        let nexusGrouped = false;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            const groups = await redis.xInfoGroups(TRIGGER).catch(() => []);
            if (groups.length > 0) { nexusGrouped = true; break; }
        }
        if (!nexusGrouped) throw new Error('nexus 未在 TRIGGER 上建组(consumer 未运行/未发现订阅?)');

        // 3. 触发:信封式条目 —— 携带链 id T0 / 事件 id E0 / depth=1,业务字段平铺
        //    (guard 与 payload_template 都读平铺字段,与 Router 信封共存)。
        await redis.xAdd(TRIGGER, '*', {
            type: 'TRACE', tag: TAG, orderId: ORDER_ID,
            trace_id: T0, event_id: E0, depth: '1', emitted_at: String(Date.now()),
        });
    }, 40_000);

    afterAll(async () => {
        await redis.del(`ORCHESTRATOR:WORKFLOW:${WF_ID}`);
        await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', WF_ID);
        const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
        for (const rid of runIds) {
            const run = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
            if (run?.workflowId === WF_ID) { await redis.del(`ORCHESTRATOR:RUN:${rid}`); await redis.sRem('ORCHESTRATOR:RUN_INDEX', rid); }
        }
        if (sentinelId) {
            await redis.del(`NEXUS:SENTINEL:${sentinelId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', sentinelId);
            await redis.sRem(`NEXUS:SUB:${TRIGGER}`, sentinelId);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${sentinelId}`);
            const msgs = await redis.zRange(`NOTIFICATION:INBOX:${sentinelId}`, 0, -1).catch(() => []);
            for (const m of msgs) await redis.del(`NOTIFICATION:MSG:${m}`);
            await redis.del(`NOTIFICATION:INBOX:${sentinelId}`);
        }
        await redis.del(TRIGGER);
        await redis.del(DECISION);
        await redis.quit();
    });

    test('1. 决策信封继承 T0:trace_id 透传、depth+1、parent_event_id=触发事件', async () => {
        for (let i = 0; i < 50 && !decisionEnv; i++) {
            await sleep(500);
            const msgs = await redis.xRevRange(DECISION, '+', '-', { COUNT: 10 }).catch(() => []);
            for (const m of msgs) {
                try {
                    const p = JSON.parse(m.message.payload);
                    if (p.orderId === ORDER_ID) { decisionEnv = m.message; break; }
                } catch (_) {}
            }
        }
        expect(decisionEnv).not.toBeNull();
        expect(decisionEnv.trace_id).toBe(T0);            // 不再每跳随机
        expect(decisionEnv.depth).toBe('2');              // 事件跳 1 → 2
        expect(decisionEnv.parent_event_id).toBe(E0);     // 精确因果边
        expect(decisionEnv.actor).toBe(`sentinel:${sentinelId}`);
    }, 40_000);

    test('2. run 记录携带链 id:trace=T0,parentEventId=决策事件 id', async () => {
        let run = null;
        for (let i = 0; i < 60 && !run; i++) {
            await sleep(500);
            const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
            for (const rid of runIds.reverse()) {
                const r = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
                if (r?.workflowId === WF_ID) { run = r; break; }
            }
        }
        expect(run).not.toBeNull();
        expect(run.trace).toBe(T0);
        expect(run.parentEventId).toBe(decisionEnv.event_id);
    }, 40_000);

    test('3. 实体 WAL 账本行 trace=T0(上一轮留位的字段被灌上)+ 收款事件信封 depth=3', async () => {
        // 3a. collection 的支付实体落库,WAL:STREAM 账本行带 trace
        let walRow = null;
        for (let i = 0; i < 60 && !walRow; i++) {
            await sleep(500);
            const entries = await redis.xRevRange('WAL:STREAM', '+', '-', { COUNT: 50 }).catch(() => []);
            for (const { message } of entries) {
                if (!String(message.key || '').startsWith('COLLECTION:PAYMENT:')) continue;
                // 只认 create 行:6699 上的 dev mock workflow(PAYMENT:RECEIVED→auto settle)
                // 会被本链触发出第二跳 update 行——它同样带 T0(链穿过第二个 workflow 仍不断),
                // 但本断言锚定的是 record 这一步。
                if (message.op !== 'create') continue;
                try {
                    const after = JSON.parse(message.after);
                    if (after?.orderId === ORDER_ID) { walRow = message; break; }
                } catch (_) {}
            }
        }
        expect(walRow).not.toBeNull();
        expect(walRow.op).toBe('create');
        expect(walRow.trace).toBe(T0);                    // RPC 头 → token meta → walContext → 账本
        expect(walRow.user).toBe('system.orchestrator');  // workflow 以共享 bot 身份执行(confused-deputy 现状)

        // 3b. record 的 _event 夹带:EVENT:PAYMENT:RECEIVED 信封同链、再 +1 跳
        let payEnv = null;
        for (let i = 0; i < 20 && !payEnv; i++) {
            const msgs = await redis.xRevRange('EVENT:PAYMENT:RECEIVED', '+', '-', { COUNT: 30 }).catch(() => []);
            for (const m of msgs) {
                try {
                    const p = JSON.parse(m.message.payload);
                    if (p.orderId === ORDER_ID || p.id === JSON.parse(walRow.after).id) { payEnv = m.message; break; }
                } catch (_) {}
            }
            if (!payEnv) await sleep(500);
        }
        expect(payEnv).not.toBeNull();
        expect(payEnv.trace_id).toBe(T0);
        expect(payEnv.depth).toBe('3');
    }, 50_000);

    test('4. 深度预算刹车:depth=16 的触发,emit 被拦、错误入队、链终止', async () => {
        // 同一个 Sentinel,新的触发条目(SETNX 守卫按 ref 区分),链深已达预算上限。
        await redis.xAdd(TRIGGER, '*', {
            type: 'TRACE', tag: TAG, orderId: `${ORDER_ID}-loop`,
            trace_id: T1, event_id: `${E0}loop`, depth: '16', emitted_at: String(Date.now()),
        });

        // 等错误入队(emit 在 Router 被拦截并记录)
        let blockedErr = null;
        let rawErr = null;
        for (let i = 0; i < 50 && !blockedErr; i++) {
            await sleep(500);
            const errs = await redis.lRange('ERROR:QUEUE:router', 0, -1).catch(() => []);
            for (const raw of errs) {
                try {
                    const e = JSON.parse(raw);
                    if (e.code === 'EVENT_DEPTH_EXCEEDED' && e.trace_id === T1) { blockedErr = e; rawErr = raw; break; }
                } catch (_) {}
            }
        }
        expect(blockedErr).not.toBeNull();
        expect(blockedErr.depth).toBe(17);
        expect(blockedErr.stream).toBe(DECISION);

        // DECISION 流上不存在 T1 链的事件(刹车真的没让它过)
        const msgs = await redis.xRange(DECISION, '-', '+').catch(() => []);
        expect(msgs.filter((m) => m.message.trace_id === T1)).toHaveLength(0);

        // 清掉本测试故意制造的错误队列条目,不污染后续套件的 assertNoErrors
        if (rawErr) await redis.lRem('ERROR:QUEUE:router', 1, rawErr);
    }, 40_000);
});
