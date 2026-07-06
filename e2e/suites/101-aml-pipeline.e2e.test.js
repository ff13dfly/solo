/**
 * 101 · ingress → collection → fulfillment → nexus(AI AML) → market order
 *
 * 完整业务链路 e2e：一笔"模拟入账"驱动一个 market 订单前进，中途由 nexus Sentinel
 * 跑 AI 决策（模拟 AML 审查）来 gate 订单是否放行。
 *
 *   POST ingress.ingest (ApiKey)                       —— 模拟支付通知入站
 *     → EVENT:WEBHOOK:{src}
 *     → orchestrator W1（多步）:
 *          collection.payment.record   —— 记一笔 collection 入账（"模拟的 collection"）
 *          fulfillment.instance.transition(pay)  —— fulfillment 推进 DRAFT→PAID
 *     → fulfillment 'pay' 动作 _task → market.order.pay   (订单 PLACED→PAID)
 *     → EVENT:FULFILLMENT:TRANSITIONED(toState=PAID)
 *     → nexus AML Sentinel(guard toState=PAID & 本实例): autorun agent.decide(['clear','hold'])
 *          —— 这是"AI 判 AML"的缝：mock provider 确定性返回 choices[0]
 *     → emit_when(output.escalate==false) → EVENT:E2E:AML:{pid}{decision}
 *     → orchestrator W_aml: fulfillment.instance.transition($input.decision)
 *     → fulfillment 'clear'/'hold' 动作 _task → market.order.confirm / market.order.hold
 *
 * 三条 lane 验证 AML 闸真的能 gate：
 *   - clear    lane（choices ['clear','hold'] → mock 选 clear）→ 订单应 CONFIRMED
 *   - hold     lane（choices ['hold','clear'] → mock 选 hold ）→ 订单应 HELD，且**绝不** CONFIRMED
 *   - escalate lane（confidence_threshold=0.95 > mock 的 0.9 → escalate=true）→ emit 被
 *     emit_when 压住、决策不上总线 → 订单停在 PAID 等人工（既不放行也不冻结）。这是 AML 最该
 *     守的"拿不准就别自动放行"的安全兜底路径。
 *
 * ⚠ AI 是确定性 mock（AI_PROVIDER=mock，agent.decide 回 choices[0]）。本套件测的是
 *   "裁决一旦给出，管道是否忠实地按它推进/拦截"，不是 AML 判断质量本身。
 *
 * 仅 full profile（需 ingress + collection + fulfillment + nexus + agent + orchestrator + market）。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');
const { cleanupAmlPipeline } = require('../lib/aml-cleanup');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.pid;
const { WL_KEY, TASK_WHITELIST_SUPERSET } = require('../lib/whitelist');
const TRANSITIONED = 'EVENT:FULFILLMENT:TRANSITIONED';
const AML_STREAM = `EVENT:E2E:AML:${PID}`;            // ⊂ system.nexus 注册的 EVENT:E2E:* —— 免改 setup.js
const PROFILE_ID = `aml-pipeline-${PID}`;
const WF1 = `wf-101-intake-${PID}`;
const WFA = `wf-101-aml-${PID}`;

const LANES = [
    { key: 'clear',    choices: ['clear', 'hold'], wantOrder: 'CONFIRMED', wantInst: 'CLEARED' },
    { key: 'hold',     choices: ['hold', 'clear'], wantOrder: 'HELD',      wantInst: 'HELD'    },
    // escalate: a confidence_threshold ABOVE the mock's 0.9 forces agent.decide to flag
    // escalate=true → emit_when suppresses the decision → the order never leaves PAID.
    { key: 'escalate', choices: ['clear', 'hold'], threshold: 0.95, wantOrder: 'PAID', wantInst: 'PAID' },
];

function workflowDoc(id, subscription, steps) {
    const now = Date.now();
    return {
        id, name: id, category: 'e2e-aml', desc: `AML pipeline ${PID}: ${id}`,
        tags: [], examples: [], negative: [], keywords: [],
        required_inputs: [], optional_inputs: [], synonyms: {}, resolvers: {},
        allowed_triggers: ['event'],
        event_subscriptions: [subscription],
        steps,
        status: 'ACTIVE', submittedBy: 'e2e', approvals: [], priority: 50,
        createdAt: now, updatedAt: now,
    };
}

gate('101 · ingress → collection → fulfillment → nexus(AI AML) → market order', () => {
    let redis;
    let sourceId, apiKey, webhookStream;
    let prevWhitelist;

    async function waitForGroup(stream, groupName, { tries = 80, delay = 500 } = {}) {
        for (let i = 0; i < tries; i++) {
            try {
                const groups = await redis.xInfoGroups(stream);
                if (groups.some((g) => (g.name || g.NAME) === groupName)) return true;
            } catch (_) { /* stream not created yet */ }
            await sleep(delay);
        }
        return false;
    }

    // The clear/escalate lanes traverse a long async chain (ingress → collection → fulfillment
    // → nexus AI(AML) → market); under full-run load the AI hop lags, so give generous headroom
    // (90s, inside the bumped 150s test timeouts). The order DOES reach the state, just slowly.
    async function pollOrderState(orderId, want, { tries = 180, delay = 500 } = {}) {
        let last = null;
        for (let i = 0; i < tries; i++) {
            const r = await rpc('market.order.get', { id: orderId }, ADMIN_TOKEN);
            last = r.result;
            if (last && last.state === want) return last;
            await sleep(delay);
        }
        return last;
    }

    // Scan the AML decision bus for an emitted decision carrying this instanceId.
    // Used to prove the escalate lane emitted NOTHING (emit_when suppressed it).
    async function amlDecisionFor(instanceId) {
        const entries = await redis.xRange(AML_STREAM, '-', '+').catch(() => []);
        for (const e of entries) {
            const raw = e.message && e.message.payload;
            const p = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
            if (p && p.instanceId === instanceId) return p;
        }
        return null;
    }

    async function dumpDiagnostics(tag) {
        const lines = [`\n[101 diag ${tag}]`];
        for (const lane of LANES) {
            const o = (await rpc('market.order.get', { id: lane.orderId }, ADMIN_TOKEN)).result;
            const inst = (await rpc('fulfillment.instance.get', { id: lane.instanceId }, ADMIN_TOKEN)).result;
            lines.push(`  ${lane.key}: order=${o && o.state} instance=${inst && inst.state}`);
        }
        const aml = await redis.xRevRange(AML_STREAM, '+', '-', { COUNT: 10 }).catch(() => []);
        lines.push(`  AML decisions on bus: ${aml.length}`);
        const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
        for (const rid of runIds) {
            const run = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
            if (run && (run.workflowId === WF1 || run.workflowId === WFA)) {
                lines.push(`  run ${run.workflowId} ${run.status}${run.failedStep ? ` failedStep=${run.failedStep} err=${JSON.stringify(run.lastError)}` : ''}`);
            }
        }
        for (const svc of ['ingress', 'collection', 'fulfillment', 'nexus', 'market']) {
            const n = await redis.lLen(`ERROR:QUEUE:${svc}`).catch(() => 0);
            if (n) lines.push(`  ERROR:QUEUE:${svc} = ${n}`);
        }
        console.warn(lines.join('\n'));
    }

    beforeAll(async () => {
        redis = await redisLib.connect();

        // 1. Task whitelist superset — fulfillment _tasks may dispatch to market.order.*.
        //    Shared constant (seeded at harness boot) so the value never flips and the
        //    Router's 60s whitelist cache can't wrongly block a market _task (§5.6③).
        prevWhitelist = await redis.get(WL_KEY);
        await redis.set(WL_KEY, JSON.stringify(TASK_WHITELIST_SUPERSET));

        // 2. Ingress source (inbound webhook adapter) → apiKey + EVENT:WEBHOOK:{NAME}.
        const src = V.assertResult(
            await rpc('ingress.source.create', { name: `aml-pipe-${PID}`, dedupTtlSec: 120 }, ADMIN_TOKEN),
            'ingress.source.create');
        sourceId = src.id; apiKey = src.apiKey; webhookStream = src.stream;

        // 3. Shared fulfillment profile — the state machine that DRIVES the order:
        //    DRAFT --pay--> PAID --clear--> CLEARED | --hold--> HELD ; each transition
        //    dispatches a _task to the matching market.order.* method (instance.meta.orderId).
        V.assertResult(await rpc('fulfillment.profile.create', {
            id: PROFILE_ID, name: PROFILE_ID,
            transitions: [
                { event: 'pay',   from: 'DRAFT', to: 'PAID',    condition: null,
                  actions: [{ type: 'task', method: 'market.order.pay',     params: { id: { var: 'instance.meta.orderId' } } }] },
                { event: 'clear', from: 'PAID',  to: 'CLEARED', condition: null,
                  actions: [{ type: 'task', method: 'market.order.confirm', params: { id: { var: 'instance.meta.orderId' } } }] },
                { event: 'hold',  from: 'PAID',  to: 'HELD',    condition: null,
                  actions: [{ type: 'task', method: 'market.order.hold',    params: { id: { var: 'instance.meta.orderId' } } }] },
            ],
        }, ADMIN_TOKEN), 'fulfillment.profile.create');

        // 4. Per-lane: market order (PLACED) + fulfillment instance (meta.orderId) + AML Sentinel.
        for (const lane of LANES) {
            const order = V.assertResult(
                await rpc('market.order.create', { orderRef: `${lane.key}-${PID}`, amount: 5000, currency: 'CNY' }, ADMIN_TOKEN),
                `market.order.create(${lane.key})`);
            lane.orderId = order.id;

            const inst = V.assertResult(
                await rpc('fulfillment.instance.create', { sourceId: order.id, profileId: PROFILE_ID, meta: { orderId: order.id } }, ADMIN_TOKEN),
                `fulfillment.instance.create(${lane.key})`);
            lane.instanceId = inst.id;

            // AML Sentinel: react to THIS instance reaching PAID, run agent.decide, emit a
            // gated decision. guard reads event.payload.* (a Router-emitted event nests the
            // business fields under .payload). choices order picks the mock verdict.
            const sentinel = V.assertResult(await rpc('nexus.sentinel.create', {
                name: `e2e-101-aml-${lane.key}-${PID}`,
                authorityRole: `e2e:101-aml-${lane.key}`,
                eventSubscriptions: [TRANSITIONED],
                reachability: 'polling',
                context: {
                    guard: { and: [
                        { '==': [{ var: 'event.payload.toState' }, 'PAID'] },
                        { '==': [{ var: 'event.payload.instanceId' }, inst.id] },
                    ] },
                    system_prompt_template:
                        '订单 {{event.payload.instanceId}} 已收款（金额 {{event.payload.sourceId}}）。' +
                        '判断这笔资金是否存在 AML 风险：clear=放行 / hold=冻结。',
                    autorun: lane.threshold !== undefined
                        ? { choices: lane.choices, confidence_threshold: lane.threshold }
                        : { choices: lane.choices },
                    emit: {
                        stream: AML_STREAM, type: 'AML',
                        emit_when: { '==': [{ var: 'output.escalate' }, false] },
                        payload_template: {
                            decision:   '{{output.decision}}',
                            instanceId: '{{event.payload.instanceId}}',
                            confidence: '{{output.confidence}}',
                            by:         '{{sentinel.id}}',
                        },
                    },
                },
            }, ADMIN_TOKEN), `nexus.sentinel.create(${lane.key})`);
            lane.sentinelId = sentinel.id;
        }

        // 5. Orchestrator bridges (direct Redis injection → ACTIVE immediately).
        //    W1: webhook → record a collection payment + drive fulfillment 'pay'.
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${WF1}`, '$', workflowDoc(
            WF1,
            { stream: webhookStream, filter: { type: 'webhook.received' } },
            [
                { id: 'record', service: 'collection', method: 'collection.payment.record',
                  params: { source: 'aml-e2e', orderId: '$input.data.orderId', amount: '$input.data.amount', currency: 'CNY' } },
                { id: 'pay', service: 'fulfillment', method: 'fulfillment.instance.transition',
                  params: { id: '$input.data.instanceId', event: 'pay' } },
            ]));
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', WF1);

        //    W_aml: AML decision → drive fulfillment 'clear'/'hold' ($input.decision).
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${WFA}`, '$', workflowDoc(
            WFA,
            { stream: AML_STREAM, filter: { type: 'AML' } },
            [
                { id: 'decide', service: 'fulfillment', method: 'fulfillment.instance.transition',
                  params: { id: '$input.instanceId', event: '$input.decision' } },
            ]));
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', WFA);

        // 6. Wait for consumer groups to exist before any event flows (groups start at '$').
        const g1 = await waitForGroup(webhookStream, 'orchestrator');
        const g2 = await waitForGroup(AML_STREAM, 'orchestrator');
        const g3 = await waitForGroup(TRANSITIONED, 'nexus');
        if (!g1) throw new Error(`orchestrator group never appeared on ${webhookStream}`);
        if (!g2) throw new Error(`orchestrator group never appeared on ${AML_STREAM}`);
        if (!g3) throw new Error(`nexus group never appeared on ${TRANSITIONED}`);
    }, 120_000);

    afterAll(async () => {
        if (!redis) return;
        // Source ENTITY removal goes through the service (needs the RPC client). The rest is
        // exact-key Redis teardown extracted to lib/aml-cleanup.js — deterministic, no glob,
        // and unit-tested for over-deletion in lib/aml-cleanup.test.js.
        if (sourceId) await rpc('ingress.source.delete', { id: sourceId }, ADMIN_TOKEN).catch(() => {});
        await cleanupAmlPipeline(redis, {
            wlKey: WL_KEY, prevWhitelist,
            transitionedStream: TRANSITIONED,
            workflows: [WF1, WFA],
            profileId: PROFILE_ID,
            amlStream: AML_STREAM,
            webhookStream,
            sourceName: `aml-pipe-${PID}`,
            requestIds: LANES.map((l) => `aml-${PID}-${l.key}`),
            lanes: LANES,
        });
        // let nexus rebuild its subscription snapshot before the next suite reuses the stream
        await sleep(2000);
        await redis.quit();
    }, 30_000);

    // ── 前置条件 ──────────────────────────────────────────────────────────────────
    test('sanity: each order PLACED, each instance DRAFT, each sentinel subscribed', async () => {
        for (const lane of LANES) {
            const o = V.assertResult(await rpc('market.order.get', { id: lane.orderId }, ADMIN_TOKEN), `order.get(${lane.key})`);
            expect(o.state).toBe('PLACED');
            const inst = V.assertResult(await rpc('fulfillment.instance.get', { id: lane.instanceId }, ADMIN_TOKEN), `instance.get(${lane.key})`);
            expect(inst.state).toBe('DRAFT');
            expect(await redis.sIsMember(`NEXUS:SUB:${TRANSITIONED}`, lane.sentinelId)).toBeTruthy();
        }
    });

    // ── clear lane：AI 放行 → 订单推进到 CONFIRMED ─────────────────────────────────
    test('clear lane: webhook → payment → fulfillment → AI(clear) → order CONFIRMED', async () => {
        const lane = LANES.find((l) => l.key === 'clear');
        const res = await rpc('ingress.ingest',
            { request_id: `aml-${PID}-clear`, data: { instanceId: lane.instanceId, orderId: lane.orderId, amount: 5000 } },
            null, { authHeader: `ApiKey ${apiKey}` });
        expect(res.status).toBe(200);

        const order = await pollOrderState(lane.orderId, 'CONFIRMED');
        if (!order || order.state !== 'CONFIRMED') await dumpDiagnostics('clear');
        expect(order && order.state).toBe('CONFIRMED');

        const inst = V.assertResult(await rpc('fulfillment.instance.get', { id: lane.instanceId }, ADMIN_TOKEN), 'instance.get(clear)');
        expect(inst.state).toBe('CLEARED');
    }, 150_000);

    // ── hold lane：AI 冻结 → 订单 HELD，且绝不 CONFIRMED（AML 闸真的拦住了）────────────
    test('hold lane: webhook → payment → fulfillment → AI(hold) → order HELD, never CONFIRMED', async () => {
        const lane = LANES.find((l) => l.key === 'hold');
        const res = await rpc('ingress.ingest',
            { request_id: `aml-${PID}-hold`, data: { instanceId: lane.instanceId, orderId: lane.orderId, amount: 5000 } },
            null, { authHeader: `ApiKey ${apiKey}` });
        expect(res.status).toBe(200);

        const order = await pollOrderState(lane.orderId, 'HELD');
        if (!order || order.state !== 'HELD') await dumpDiagnostics('hold');
        expect(order && order.state).toBe('HELD');
        expect(order.state).not.toBe('CONFIRMED');   // the AML gate blocked advancement

        const inst = V.assertResult(await rpc('fulfillment.instance.get', { id: lane.instanceId }, ADMIN_TOKEN), 'instance.get(hold)');
        expect(inst.state).toBe('HELD');
    }, 150_000);

    // ── escalate lane：AI 拿不准 → emit 被压住 → 订单停在 PAID（不放行也不冻结）────────────
    test('escalate lane: low-confidence AI → emit suppressed → order STAYS PAID (pending human)', async () => {
        const lane = LANES.find((l) => l.key === 'escalate');
        const res = await rpc('ingress.ingest',
            { request_id: `aml-${PID}-escalate`, data: { instanceId: lane.instanceId, orderId: lane.orderId, amount: 5000 } },
            null, { authHeader: `ApiKey ${apiKey}` });
        expect(res.status).toBe(200);

        // Payment is collected → order reaches PAID (the AI gates only what comes AFTER).
        const paid = await pollOrderState(lane.orderId, 'PAID');
        if (!paid || paid.state !== 'PAID') await dumpDiagnostics('escalate');
        expect(paid && paid.state).toBe('PAID');

        // Prove the Sentinel actually RAN and ESCALATED (not merely "never fired"): its inbox
        // carries the assembled delivery with output.escalate === true.
        let escalated = null;
        for (let i = 0; i < 40; i++) {
            const r = await rpc('notification.inbox.list', { targetId: lane.sentinelId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            escalated = items.find((m) => m.payload && m.payload.context && m.payload.context.output && m.payload.context.output.escalate === true);
            if (escalated) break;
            await sleep(500);
        }
        if (!escalated) await dumpDiagnostics('escalate-no-inbox');
        expect(escalated).toBeTruthy();

        // Grace window: confirm the order does NOT advance past PAID and NO decision was emitted.
        await sleep(4000);
        const after = V.assertResult(await rpc('market.order.get', { id: lane.orderId }, ADMIN_TOKEN), 'order.get(escalate)');
        expect(after.state).toBe('PAID');           // never CONFIRMED, never HELD
        const inst = V.assertResult(await rpc('fulfillment.instance.get', { id: lane.instanceId }, ADMIN_TOKEN), 'instance.get(escalate)');
        expect(inst.state).toBe('PAID');
        expect(await amlDecisionFor(lane.instanceId)).toBeNull();   // emit_when suppressed the decision
    }, 150_000);

    // ── UI data path: the operator portal ExecutionTrace page stitches a chain by trace_id
    //    using orchestrator.run.list + nexus.trace.get (the complete server-side event chain).
    //    The windowed nexus.event.streams/recent scan is kept here as a cross-check baseline.
    //    This drives those same RPCs against the clear lane and asserts the WHOLE nexus chain
    //    (ingress → collection → fulfillment → nexus AI → market) is reconstructable from a
    //    SINGLE trace id — i.e. the page would render the full execution. Regression guard:
    //    if any hop stops propagating the trace (chain split), distinctTraces>1 trips here.
    test('UI data path: ExecutionTrace stitch reconstructs the full clear-lane chain on one trace', async () => {
        const lane = LANES.find((l) => l.key === 'clear');

        // chain trace from the instance history (router mints at ingress, propagates via walContext)
        const inst = V.assertResult(await rpc('fulfillment.instance.get', { id: lane.instanceId }, ADMIN_TOKEN), 'instance.get(clear)');
        const histTraces = [...new Set((inst.history || []).map((h) => h.trace).filter(Boolean))];
        console.log('[trace-ui] instance.history traces =', JSON.stringify(histTraces));
        // The whole chain stays on ONE trace — this is exactly what lets the UI stitch it.
        expect(histTraces.length).toBe(1);
        const traceId = histTraces[0];

        // (1) runs — orchestrator.run.list filtered by run.trace (what the page does)
        const allRuns = V.assertResult(await rpc('orchestrator.run.list', {}, ADMIN_TOKEN), 'run.list');
        const traceRuns = allRuns.filter((r) => r.trace === traceId);
        console.log('[trace-ui] runs =', JSON.stringify(traceRuns.map((r) => ({ wf: r.workflowId, status: r.status }))));
        expect(traceRuns.length).toBeGreaterThanOrEqual(2);          // intake (W1) + AML (W_aml)
        expect(traceRuns.some((r) => r.workflowId === WF1)).toBe(true);
        expect(traceRuns.some((r) => r.workflowId === WFA)).toBe(true);

        // (2) events — nexus.event.streams + nexus.event.recent filtered by trace_id (what the page does)
        const streamsR = V.assertResult(await rpc('nexus.event.streams', {}, ADMIN_TOKEN), 'event.streams');
        const matched = [];
        for (const s of (streamsR.items || [])) {
            const r = await rpc('nexus.event.recent', { stream: s.key, count: 200 }, ADMIN_TOKEN);
            for (const e of ((r.result && r.result.entries) || [])) {
                const tid = e.trace_id || (e.payload && e.payload.trace_id);
                if (tid === traceId) matched.push({ stream: s.key, type: e.type });
            }
        }
        const streams = matched.map((m) => m.stream);
        const types = matched.map((m) => m.type);
        console.log('[trace-ui] events =', JSON.stringify(matched));
        console.log(`[trace-ui] SUMMARY distinctTraces=${histTraces.length} runs=${traceRuns.length} events=${matched.length}`);

        // The full nexus chain is present in the stitched view, all on the one trace:
        expect(streams.some((s) => s.startsWith('EVENT:WEBHOOK'))).toBe(true);        // ingress origin
        expect(types).toContain('instance.transitioned');                            // fulfillment hop(s)
        expect(streams.some((s) => s.includes('AML'))).toBe(true);                    // nexus AI decision

        // (3) nexus.trace.get — the page's NEW path: ONE server-side call returning the COMPLETE
        //     event chain (full history, not a window). Must be a superset of the windowed scan.
        const tg = V.assertResult(await rpc('nexus.trace.get', { traceId }, ADMIN_TOKEN), 'nexus.trace.get');
        const walRows = tg.events.filter((e) => e.stream === 'WAL:STREAM');
        console.log(`[trace-ui] nexus.trace.get events=${tg.events.length} (wal=${walRows.length}) streamsScanned=${tg.streamsScanned} truncated=${tg.truncated}`);
        expect(tg.traceId).toBe(traceId);
        expect(tg.events.length).toBeGreaterThanOrEqual(matched.length);             // complete ⊇ windowed
        // every node is on this trace (events carry trace_id; WAL rows carry trace)
        expect(tg.events.every((e) => (e.trace_id || e.trace || (e.payload && e.payload.trace_id)) === traceId)).toBe(true);
        const tgStreams = tg.events.map((e) => e.stream);
        expect(tgStreams.some((s) => s.startsWith('EVENT:WEBHOOK'))).toBe(true);     // ingress origin
        expect(tg.events.map((e) => e.type)).toContain('instance.transitioned');    // fulfillment hop
        expect(tgStreams.some((s) => s.includes('AML'))).toBe(true);                // nexus AI decision
        expect(walRows.length).toBeGreaterThan(0);                                  // entity-WAL rows folded in (order writes carry trace)
        const ats = tg.events.map((e) => e.at || 0);
        expect(ats).toEqual([...ats].sort((a, b) => a - b));                         // chronological
    }, 60_000);

    test('no service-side errors across the pipeline', async () => {
        await dumpDiagnostics('final');
        await V.assertNoErrors(redis, ['ingress', 'collection', 'fulfillment', 'nexus', 'market']);
    });
});
