/**
 * 96 · ingress → orchestrator → fulfillment → nexus(agent.decide) → notification
 *
 * 五服务全链路端到端测试：
 *
 *   POST /hook (mock listener :8090)
 *     → ingress.ingest → EVENT:WEBHOOK:MOCK-LISTENER
 *     → orchestrator matcher → worker → runner
 *     → fulfillment.instance.transition (DRAFT → PROCESSING)
 *     → EVENT:FULFILLMENT:TRANSITIONED
 *     → nexus sentinel (autorun → agent.decide 优雅降级)
 *     → NOTIFICATION:INBOX:{sentinelId}
 *
 * 时序关键点：
 *   1. 先建 sentinel（在 EVENT:FULFILLMENT:TRANSITIONED 上建消费组，从 '$' 开始）
 *   2. 再注入 orchestrator workflow（matcher 需时发现）
 *   3. 最后 POST /hook 触发事件链
 *
 * 仅 full profile（需 ingress relay token + nexus relay token + orchestrator matcher/worker ON）。
 * agent.decide 优雅降级：无 LLM key 时 output=null，notification 仍然投递。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// listener 地址以 harness context 为准(支持 E2E_PORT_OFFSET 平移);env 可显式覆盖.
const { read: readCtx } = require('../lib/context');
const LISTENER_URL = process.env.LISTENER_URL || readCtx().listenerUrl || 'http://localhost:8090';
const PID = process.pid;
const WF_ID  = `wf-96-pipeline-${PID}`;
const TAG    = `pipe96-${PID}`;

function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(body);
        const u = new URL(url);
        const opts = {
            hostname: u.hostname, port: u.port || 80, path: u.pathname,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers },
        };
        const req = http.request(opts, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(d); } catch { parsed = { _raw: d }; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('http timeout')); });
        req.write(raw);
        req.end();
    });
}

gate('96 · ingress → orchestrator → fulfillment → nexus → notification (full pipeline)', () => {
    let redis;
    let apiKey;
    let profileId;
    let instanceId;
    let sentinelId;

    beforeAll(async () => {
        redis = await redisLib.connect();

        // Load API key from keys.env (written by deploy/mock/bootstrap.js)
        const keysFile = path.join(__dirname, '../../deploy/mock/keys.env');
        if (fs.existsSync(keysFile)) {
            for (const line of fs.readFileSync(keysFile, 'utf8').split('\n')) {
                if (line.startsWith('SRC_mock-listener=')) {
                    apiKey = line.slice('SRC_mock-listener='.length).trim();
                }
            }
        }

        // 1. Create fulfillment profile with DRAFT → PROCESSING transition
        //    fulfillment.profile.create requires an explicit id (no auto-generation)
        const pid = `e2e-96-profile-${PID}`;
        const profileRes = V.assertResult(
            await rpc('fulfillment.profile.create', {
                id: pid,
                name: pid,
                transitions: [
                    { event: 'start', from: 'DRAFT', to: 'PROCESSING' },
                ],
            }, ADMIN_TOKEN),
            'profile.create',
        );
        profileId = profileRes.id;

        // 2. Create fulfillment instance (starts in DRAFT)
        const instanceRes = V.assertResult(
            await rpc('fulfillment.instance.create', {
                sourceId: `e2e-96-${PID}`,
                profileId,
                meta: { pipelineTag: TAG },
            }, ADMIN_TOKEN),
            'instance.create',
        );
        instanceId = instanceRes.id;

        // 3. Create nexus sentinel subscribed to EVENT:FULFILLMENT:TRANSITIONED.
        //    Consumer group is created at '$' (current) — must happen BEFORE the event fires.
        const sentinelRes = V.assertResult(
            await rpc('nexus.sentinel.create', {
                name: `e2e-96-sentinel-${PID}`,
                authorityRole: 'e2e:96-pipeline',
                eventSubscriptions: ['EVENT:FULFILLMENT:TRANSITIONED'],
                reachability: 'polling',
                context: {
                    system_prompt_template: '履约实例状态变更({{event.toState}})，请评估是否需要人工复核。',
                    autorun: { choices: ['notify', 'escalate'] },
                },
            }, ADMIN_TOKEN),
            'sentinel.create',
        );
        sentinelId = sentinelRes.id;

        // Give nexus consumer loop time to discover the new subscription and create
        // the consumer group on EVENT:FULFILLMENT:TRANSITIONED from '$'.
        await sleep(1000);

        // 4. Inject orchestrator workflow that bridges the webhook event → fulfillment transition.
        //    Direct Redis injection so it's ACTIVE immediately (bypasses approval flow).
        const now = Date.now();
        const wfDoc = {
            id: WF_ID,
            name: 'e2e-96 full pipeline',
            category: 'e2e',
            desc: `Test ${PID}: EVENT:WEBHOOK:MOCK-LISTENER → fulfillment.instance.transition`,
            tags: [], examples: [], negative: [], keywords: [],
            required_inputs: [], optional_inputs: [], synonyms: {},
            steps: [
                {
                    id: 'transition',
                    service: 'fulfillment',
                    method: 'fulfillment.instance.transition',
                    params: { id: '$input.data.instanceId', event: 'start' },
                },
            ],
            resolvers: {},
            allowed_triggers: ['event'],
            event_subscriptions: [
                { stream: 'EVENT:WEBHOOK:MOCK-LISTENER', filter: { type: 'webhook.received' } },
            ],
            status: 'ACTIVE',
            submittedBy: 'e2e',
            approvals: [],
            priority: 50,
            createdAt: now,
            updatedAt: now,
        };
        await redis.json.set(`ORCHESTRATOR:WORKFLOW:${WF_ID}`, '$', wfDoc);
        await redis.sAdd('ORCHESTRATOR:WORKFLOW_INDEX', WF_ID);

        // Wait until the orchestrator matcher has ACTUALLY created its consumer
        // group on the stream — a blind sleep races group creation: the group
        // starts at '$', so a POST landing before it exists is silently missed
        // (the original flake: a later stray event matched instead, with the
        // wrong payload). XINFO GROUPS is the ground truth.
        const groupReady = async () => {
            try {
                const groups = await redis.xInfoGroups('EVENT:WEBHOOK:MOCK-LISTENER');
                return groups.some((g) => (g.name || g.NAME) === 'orchestrator');
            } catch { return false; }   // stream not created yet
        };
        for (let i = 0; i < 50 && !(await groupReady()); i++) await sleep(500);
        if (!(await groupReady())) throw new Error('orchestrator consumer group never appeared on EVENT:WEBHOOK:MOCK-LISTENER');
    }, 60_000);

    afterAll(async () => {
        // Remove injected workflow
        await redis.del(`ORCHESTRATOR:WORKFLOW:${WF_ID}`);
        await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', WF_ID);
        // EVENT:WEBHOOK:MOCK-LISTENER 是与 95/harness 夹具共享的流:matcher 订阅快照
        // 每 ≤5s 重建,等一个发现周期再走,免得旧快照对下一套(如 95)的 webhook 再触发.
        await sleep(7000);

        // Remove orchestrator runs created by this test
        const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
        for (const rid of runIds) {
            const run = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
            if (run?.workflowId === WF_ID) {
                await redis.del(`ORCHESTRATOR:RUN:${rid}`);
                await redis.sRem('ORCHESTRATOR:RUN_INDEX', rid);
            }
        }

        // Remove fulfillment instance + profile
        if (instanceId) {
            await redis.del(`FULFILLMENT:INSTANCE:${instanceId}`);
            await redis.sRem('FULFILLMENT:INSTANCE:INDEX', instanceId);
        }
        if (profileId) {
            await redis.del(`FULFILLMENT:PROFILE:${profileId}`);
            await redis.sRem('FULFILLMENT:PROFILE:INDEX', profileId);
        }

        // Remove nexus sentinel + inbox
        if (sentinelId) {
            await redis.del(`NEXUS:SENTINEL:${sentinelId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', sentinelId);
            await redis.sRem('NEXUS:SUB:EVENT:FULFILLMENT:TRANSITIONED', sentinelId);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${sentinelId}`);
            const msgIds = await redis.zRange(`NOTIFICATION:INBOX:${sentinelId}`, 0, -1).catch(() => []);
            for (const m of msgIds) await redis.del(`NOTIFICATION:MSG:${m}`);
            await redis.del(`NOTIFICATION:INBOX:${sentinelId}`);
        }

        await redis.quit();
    }, 20_000);

    // ── 前置条件 ──────────────────────────────────────────────────────────────────

    test('1a. mock listener /health 正常', async () => {
        const alive = await new Promise((resolve) => {
            http.get(`${LISTENER_URL}/health`, (r) => {
                let d = '';
                r.on('data', c => (d += c));
                r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            }).on('error', () => resolve(null));
        });
        expect(alive).not.toBeNull();
        expect(alive?.status).toBe('ok');
    });

    test('1b. RELAY:TOKEN:ingress 未过期（ingress relay bot 已 seed）', async () => {
        const raw = await redis.get('RELAY:TOKEN:ingress');
        expect(raw).not.toBeNull();
        const state = JSON.parse(raw);
        expect(state.token).toBeTruthy();
        expect(state.expiresAt).toBeGreaterThan(Date.now());
    });

    test('1c. fulfillment instance 初始状态为 DRAFT', async () => {
        expect(instanceId).toBeTruthy();
        const res = V.assertResult(
            await rpc('fulfillment.instance.get', { id: instanceId }, ADMIN_TOKEN),
            'instance.get',
        );
        expect(res.state).toBe('DRAFT');
    });

    test('1d. nexus sentinel 已订阅 EVENT:FULFILLMENT:TRANSITIONED', async () => {
        expect(sentinelId).toBeTruthy();
        const isMember = await redis.sIsMember('NEXUS:SUB:EVENT:FULFILLMENT:TRANSITIONED', sentinelId);
        expect(isMember).toBeTruthy();
    });

    // ── 2. 触发链路 ────────────────────────────────────────────────────────────────

    test('2. POST /hook 触发 orchestrator run，最长等待 30s', async () => {
        // 发送包含 instanceId 的 webhook，orchestrator workflow 通过 $input.data.instanceId 取值
        const res = await httpPost(`${LISTENER_URL}/hook`, { instanceId, pipelineTag: TAG });
        expect(res.status).toBe(200);
        expect(res.body.result?.ok).toBe(true);

        // 等待 orchestrator run 完成
        let run = null;
        for (let i = 0; i < 180; i++) {   // 90s headroom — the full chain lags under full-run load
            await sleep(500);
            const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
            for (const rid of runIds.reverse()) {
                const r = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
                if (r?.workflowId === WF_ID) { run = r; break; }
            }
            if (run) break;
        }
        expect(run).not.toBeNull();
        // 'RUNNING' (was lowercase 'running' — a latent case bug): the poll above breaks as
        // soon as the run DOC exists, so a 500ms tick can land inside the brief mid-flight
        // window. run.js states are ALL-CAPS; lowercase never matched and flaked the suite.
        expect(['DONE', 'completed', 'failed', 'FAILED', 'RUNNING', 'PAUSED_AWAITING_HUMAN']).toContain(run.status);

        // toFix §6.1 — FAILED runs now carry failedStep/lastError/cleanupManifest on the entity.
        if (run.status === 'FAILED' || run.status === 'failed') {
            console.warn('[96] run failed:', run.failedStep, run.lastError, JSON.stringify(run.cleanupManifest || null));
        }
    }, 120_000);

    // ── 3. fulfillment 状态验证 ────────────────────────────────────────────────────

    test('3a. fulfillment instance 状态已变为 PROCESSING', async () => {
        const res = V.assertResult(
            await rpc('fulfillment.instance.get', { id: instanceId }, ADMIN_TOKEN),
            'instance.get after transition',
        );
        expect(res.state).toBe('PROCESSING');
    });

    test('3b. EVENT:FULFILLMENT:TRANSITIONED 流中存在本实例的事件', async () => {
        const msgs = await redis.xRevRange('EVENT:FULFILLMENT:TRANSITIONED', '+', '-', { COUNT: 20 });
        let found = null;
        for (const msg of msgs) {
            try {
                const p = typeof msg.message.payload === 'string'
                    ? JSON.parse(msg.message.payload)
                    : msg.message.payload;
                if (p?.instanceId === instanceId || p?.data?.instanceId === instanceId) {
                    found = p; break;
                }
            } catch (_) {}
        }
        // 如果 found==null，说明 fulfillment relay token 没有或 event.emit 失败
        expect(found).not.toBeNull();
    });

    // ── 4. nexus → notification ────────────────────────────────────────────────────

    test('4. nexus sentinel inbox 收到 EVENT:FULFILLMENT:TRANSITIONED 通知（最长 30s）', async () => {
        let msg = null;
        for (let i = 0; i < 180; i++) {   // 90s headroom — the full chain lags under full-run load
            await sleep(500);
            const r = await rpc('notification.inbox.list', { targetId: sentinelId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            msg = items.find((m) => m.type === 'EVENT:FULFILLMENT:TRANSITIONED');
            if (msg) break;
        }
        // 如果 null → nexus relay token 没有 / notification.send 失败 / 消费组未建立
        expect(msg).not.toBeNull();
        expect(msg.sourceId).toBe('nexus');
    }, 120_000);

    test('4b. notification payload 含 context 字段（assembler 跑过）', async () => {
        const r = await rpc('notification.inbox.list', { targetId: sentinelId, unreadOnly: false }, ADMIN_TOKEN);
        const items = (r.result && r.result.items) || [];
        const msg = items.find((m) => m.type === 'EVENT:FULFILLMENT:TRANSITIONED');
        expect(msg).toBeTruthy();

        // payload 是 assembler 组装的 Context Payload
        expect(msg.payload).toBeDefined();
        expect(msg.payload.event).toBeDefined();
        expect(msg.payload.context).toBeDefined();

        // agent.decide 优雅降级：无 LLM key 时 output=null，有时是结构化决策对象
        const output = msg.payload.context?.output;
        if (output !== null && output !== undefined) {
            // agent.decide 成功：choices 约束下的结构化决策
            expect(['notify', 'escalate']).toContain(output.decision);
            expect(typeof output.confidence).toBe('number');
        }
        // output === null 是合法的降级状态，不报错
    });

    test('5. NOTIFICATION:INBOX Redis key 存在（notification 确实落存储）', async () => {
        const exists = await redis.exists(`NOTIFICATION:INBOX:${sentinelId}`);
        expect(exists).toBe(1);
    });
});
