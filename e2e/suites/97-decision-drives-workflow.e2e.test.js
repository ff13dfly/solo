/**
 * 97 · AI 决策 → workflow 执行 = 受控下游动作（闭合 96 留下的 #1 空洞）
 *
 * 96 把 workflow 接在了决策的【上游】（workflow 触发事件 → AI 决策 → 死在 inbox）。
 * 这条把箭头反过来，证明【AI 决策真的驱动了一个受控动作】：
 *
 *   xAdd 触发事件(代表一条 fulfillment 事件)
 *     → nexus Sentinel A（autorun → agent.decide：approve / reject）
 *     → context.emit 把决策值发上 EVENT:E2E:DECISION:{pid}
 *     → orchestrator matcher → workflow W
 *     → step: fulfillment.instance.transition({ id, event: $input.decision })
 *     → 实例状态机按【决策值】跳转（approve→APPROVED / reject→REJECTED）
 *
 * 关键：动作不是硬编码——transition 的 event 就是 $input.decision，即 AI 选的那个值。
 * 断言读出真实决策，再断言实例落到对应状态 ⇒ 证明“决策值真的路由了动作”，
 * 对 mock(选 choices[0]=approve) 与真 Gemini(按 prompt 选) 都成立。
 *
 * 隔离触发流（EVENT:E2E:TRIGGER:*，非 EVENT:FULFILLMENT:*）——否则动作自己的
 * transition 事件会回灌 Sentinel → 死循环。
 *
 * 仅 full profile（需 nexus 消费者 + agent + orchestrator matcher/worker + Router event.emit）。
 * 时序：注入 W（matcher 在 DECISION 上从 '$' 建组）→ 建 Sentinel A（nexus 在 TRIGGER 建组）
 *      → sleep → xAdd 触发。两个组都在各自事件发生前就位。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.pid;
const TAG = `drive-${PID}`;
const TRIGGER = `EVENT:E2E:TRIGGER:${PID}`;     // Sentinel A 订阅；我们 xAdd 注入
const DECISION = `EVENT:E2E:DECISION:${PID}`;   // A 发往；workflow W 订阅
const WF_ID = `wf-97-drive-${PID}`;
const STATE_FOR = { approve: 'APPROVED', reject: 'REJECTED' };

gate('97 · AI decision drives a workflow action (decision → emit → orchestrator → state machine)', () => {
    let redis;
    let profileId;
    let instanceId;
    let sentinelId;
    let decision = null;   // 真实决策值（test 2 读出，test 4 用于断言期望状态）

    beforeAll(async () => {
        redis = await redisLib.connect();

        // 1. profile：transition 的 event 名 = 决策值（approve/reject），都从 DRAFT 出发
        const pid = `e2e-97-profile-${PID}`;
        profileId = V.assertResult(await rpc('fulfillment.profile.create', {
            id: pid, name: pid,
            transitions: [
                { event: 'approve', from: 'DRAFT', to: 'APPROVED' },
                { event: 'reject', from: 'DRAFT', to: 'REJECTED' },
            ],
        }, ADMIN_TOKEN), 'profile.create').id;

        // 2. instance（DRAFT）
        instanceId = V.assertResult(await rpc('fulfillment.instance.create', {
            sourceId: `e2e-97-${PID}`, profileId, meta: { tag: TAG },
        }, ADMIN_TOKEN), 'instance.create').id;

        // 3. 注入 workflow W：订阅 DECISION 流，step 用 $input.decision 当 transition 事件。
        //    先注入 → matcher 在 DECISION 上从 '$' 建消费组（必须早于决策事件 emit）。
        const now = Date.now();
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${WF_ID}`, '$', {
            id: WF_ID, name: 'e2e-97 decision-driven action', category: 'e2e',
            desc: 'AI decision (approve/reject) drives a fulfillment transition',
            tags: [], examples: [], negative: [], keywords: [],
            required_inputs: [], optional_inputs: [], synonyms: {},
            steps: [{
                id: 'drive', service: 'fulfillment', method: 'fulfillment.instance.transition',
                params: { id: '$input.instanceId', event: '$input.decision' },
            }],
            resolvers: {}, allowed_triggers: ['event'],
            event_subscriptions: [{ stream: DECISION, filter: { type: 'DECISION' } }],
            status: 'ACTIVE', submittedBy: 'e2e', approvals: [], priority: 50,
            createdAt: now, updatedAt: now,
        });
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', WF_ID);
        // 等 matcher 真在 DECISION 上建好消费组（'$' on empty stream）再继续——否则决策事件
        // 可能在建组之前就 emit，落在 '$' 之前 → matcher 永远读不到（之前 reject 跑挂的就是这个竞态）。
        let grouped = false;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            const groups = await redis.xInfoGroups(DECISION).catch(() => []);
            if (groups.some((g) => g.name === 'orchestrator')) { grouped = true; break; }
        }
        if (!grouped) throw new Error('matcher 未在 DECISION 上建组（orchestrator matcher 未运行?）');

        // 4. Sentinel A：订阅 TRIGGER，autorun 决策 approve/reject，emit 决策值到 DECISION。
        //    payload 带 instanceId（从触发事件透传）→ workflow W 用它定位实例。
        sentinelId = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-97-decider-${PID}`,
            authorityRole: 'e2e:97-decider',
            eventSubscriptions: [TRIGGER],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                system_prompt_template:
                    '履约实例 {{event.instanceId}} 进入 {{event.toState}}（金额 {{event.amount}} CNY，' +
                    'verified={{event.verified}}）。请在 approve / reject 中二选一：是否批准放行？',
                autorun: { choices: ['approve', 'reject'] },
                emit: {
                    stream: DECISION, type: 'DECISION',
                    emit_when: { '==': [{ var: 'output.escalate' }, false] },
                    payload_template: {
                        decision: '{{output.decision}}',
                        instanceId: '{{event.instanceId}}',
                        confidence: '{{output.confidence}}',
                        by: '{{sentinel.id}}',
                    },
                },
            },
        }, ADMIN_TOKEN), 'sentinel.create').id;
        expect(await redis.sIsMember(`NEXUS:SUB:${TRIGGER}`, sentinelId)).toBeTruthy();

        await sleep(900);   // 订阅集对消费者可见

        // 5. 触发：一条代表“fulfillment 事件”的载荷（已验证、常规金额 → 清晰可决策）
        await redis.xAdd(TRIGGER, '*', {
            tag: TAG, instanceId, toState: 'PROCESSING', amount: '88.8', verified: 'true', kind: 'e2e',
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
        if (instanceId) { await redis.del(`FULFILLMENT:INSTANCE:${instanceId}`); await redis.sRem('FULFILLMENT:INSTANCE:INDEX', instanceId); }
        if (profileId) { await redis.del(`FULFILLMENT:PROFILE:${profileId}`); await redis.sRem('FULFILLMENT:PROFILE:INDEX', profileId); }
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

    // ── 前置 ─────────────────────────────────────────────────────────────────────

    test('1. Sentinel 订阅 TRIGGER；workflow W ACTIVE 且已入索引', async () => {
        expect(await redis.sIsMember(`NEXUS:SUB:${TRIGGER}`, sentinelId)).toBeTruthy();
        const wf = await redis.json.get(`ORCHESTRATOR:WORKFLOW:${WF_ID}`);
        expect(wf?.status).toBe('ACTIVE');
        expect(await redis.sIsMember('ORCHESTRATOR:WORKFLOW_INDEX', WF_ID)).toBeTruthy();
    });

    // ── 决策 → emit ───────────────────────────────────────────────────────────────

    test('2. AI 决策已 emit 到 DECISION 流（读出真实决策值）', async () => {
        let evt = null;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const msgs = await redis.xRevRange(DECISION, '+', '-', { COUNT: 10 }).catch(() => []);
            for (const m of msgs) {
                try {
                    const p = JSON.parse(m.message.payload);
                    if (p.instanceId === instanceId) { evt = { ...p, _type: m.message.type, _actor: m.message.actor, _source: m.message.source }; break; }
                } catch (_) {}
            }
            if (evt) break;
        }
        // null ⇒ autorun 没产决策 / emit_when 挡住(escalate) / 注册表拦了 emit
        expect(evt).not.toBeNull();
        expect(['approve', 'reject']).toContain(evt.decision);   // inverted gate：只能选闭集
        decision = evt.decision;
        console.log(`[97] AI decision = ${decision}  (confidence ${evt.confidence}, by ${evt.by})`);

        // provenance：决策事件归因到 Sentinel A，经 system.nexus 身份发出
        expect(evt._type).toBe('DECISION');
        expect(evt._actor).toBe(`sentinel:${sentinelId}`);
        expect(evt._source).toBe('system.nexus');
    }, 40_000);

    // ── emit → workflow ───────────────────────────────────────────────────────────

    test('3. 决策事件触发了 workflow W 的一次 run', async () => {
        let run = null;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
            for (const rid of runIds.reverse()) {
                const r = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
                if (r?.workflowId === WF_ID) { run = r; break; }
            }
            if (run) break;
        }
        expect(run).not.toBeNull();   // null ⇒ matcher 没在 DECISION 上消费 / 未发现 W
        expect(run.triggerSource).toContain(DECISION);   // 确认是被决策事件拉起的
        const last = run.steps?.slice(-1)[0];
        if (last?.status === 'failed') console.warn('[97] drive step failed:', last.error || JSON.stringify(last));
    }, 40_000);

    // ── workflow → 受控动作（状态机按决策值跳转）────────────────────────────────────

    test('4. 实例被【决策值】驱动跳转到对应状态（这就是驱动能力）', async () => {
        expect(decision).not.toBeNull();   // 依赖 test 2
        let state = 'DRAFT';
        for (let i = 0; i < 60; i++) {
            const inst = V.assertResult(await rpc('fulfillment.instance.get', { id: instanceId }, ADMIN_TOKEN), 'instance.get');
            if (inst.state !== 'DRAFT') { state = inst.state; break; }
            await sleep(500);
        }
        // 决策 approve ⇒ APPROVED；reject ⇒ REJECTED。证明 AI 选的值真的路由了动作。
        expect(state).toBe(STATE_FOR[decision]);
    }, 40_000);
});
