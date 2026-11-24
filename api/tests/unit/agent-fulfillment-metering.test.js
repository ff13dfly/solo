const http = require('http');
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const tokenLogger = require('../../core/agent/lib/tokenLogger');
const OllamaProvider = require('../../core/agent/providers/ollama');
const SoloPeerProvider = require('../../core/agent/providers/solo-peer');
const { walContext, requestContext } = require('../../library/entity');
const { createRelay } = require('../../library/relay');
const { createPeerRelay } = require('../../library/peer-relay');
const traceHandler = require('../../router/handlers/trace');
const forwardHandler = require('../../router/handlers/forward');
const tasksHandler = require('../../router/handlers/tasks');
const createStream = require('../../core/nexus/logic/stream');

function createMockRedis() {
    const kv = new Map();
    const hashes = new Map();
    const lists = new Map();

    const getHash = (k) => {
        if (!hashes.has(k)) hashes.set(k, new Map());
        return hashes.get(k);
    };

    return {
        isOpen: true,
        kv,
        hashes,
        lists,
        async get(k) {
            return kv.has(k) ? kv.get(k) : null;
        },
        async set(k, v, opts = {}) {
            if (opts && opts.NX && kv.has(k)) return null;
            kv.set(k, String(v));
            return 'OK';
        },
        async del(k) {
            const existed = kv.delete(k) || hashes.delete(k) || lists.delete(k);
            return existed ? 1 : 0;
        },
        async expire() {
            return 1;
        },
        async lPush(k, v) {
            if (!lists.has(k)) lists.set(k, []);
            lists.get(k).unshift(String(v));
            return lists.get(k).length;
        },
        async rPush(k, v) {
            if (!lists.has(k)) lists.set(k, []);
            lists.get(k).push(String(v));
            return lists.get(k).length;
        },
        async lTrim(k, start, stop) {
            if (!lists.has(k)) return 'OK';
            lists.set(k, lists.get(k).slice(start, stop + 1));
            return 'OK';
        },
        async lRange(k, start, stop) {
            if (!lists.has(k)) return [];
            return lists.get(k).slice(start, stop + 1);
        },
        async hSet(k, field, val) {
            const h = getHash(k);
            if (field && typeof field === 'object') {
                for (const [fk, fv] of Object.entries(field)) h.set(fk, String(fv));
                return Object.keys(field).length;
            }
            h.set(String(field), String(val));
            return 1;
        },
        async hGet(k, field) {
            const h = hashes.get(k);
            return h && h.has(field) ? h.get(field) : null;
        },
        async hGetAll(k) {
            const h = hashes.get(k);
            if (!h) return {};
            const out = {};
            for (const [fk, fv] of h.entries()) out[fk] = fv;
            return out;
        },
        async hIncrBy(k, field, delta) {
            const h = getHash(k);
            const next = (parseInt(h.get(field) || '0', 10) || 0) + Number(delta);
            h.set(field, String(next));
            return next;
        },
        async hIncrByFloat(k, field, delta) {
            const h = getHash(k);
            const next = +(((parseFloat(h.get(field) || '0') || 0) + Number(delta)).toFixed(6));
            h.set(field, String(next));
            return next;
        },
    };
}

describe('agent & fulfillment layered usage metering (v1.3.x)', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
        tokenLogger.init(redis);
    });

    test('1. OllamaProvider logs tier="local" with costUsd=0 and does not pollute cloud costUsd', async () => {
        const mockFetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                message: { content: 'ok' },
                prompt_eval_count: 200000,
                eval_count: 100000,
            }),
        }));

        const ollama = new OllamaProvider({
            ollamaBaseUrl: 'http://127.0.0.1:11434',
            ollamaDefaultModel: 'qwen3.5:9b',
            fetchFn: mockFetch,
        });

        await walContext.run({ uid: 'system.catalog', trace: 'tr-local-1', fulfillmentId: 'FL-LOCAL-01', profileId: 'catalog_visual' }, async () => {
            await ollama.chat({ text: 'hello' });
        });

        // Log a paid cloud call on the same day
        await walContext.run({ uid: 'system.catalog', trace: 'tr-cloud-1', fulfillmentId: 'FL-LOCAL-01', profileId: 'catalog_visual' }, async () => {
            await tokenLogger.log({
                method: 'agent.image.parse',
                model: 'qwen-vl-plus',
                provider: 'qwen',
                inputTokens: 100000,
                outputTokens: 50000,
            });
        });

        const daily = await tokenLogger.daily(redis, 1);
        expect(daily.length).toBe(1);
        const today = daily[0];
        // qwen-vl-plus: (0.1M * 0.50) + (0.05M * 0.50) = 0.05 + 0.025 = 0.075
        expect(today.calls).toBe(2);
        expect(today.costUsd).toBeCloseTo(0.075, 5);
        expect(today.byTier.local).toMatchObject({
            calls: 1,
            inputTokens: 200000,
            outputTokens: 100000,
            costUsd: 0,
        });
        expect(today.byTier.cloud.calls).toBe(1);
        expect(today.byTier.cloud.costUsd).toBeCloseTo(0.075, 5);

        const recent = await tokenLogger.recent(redis, 5);
        const ollamaEntry = recent.find((e) => e.provider === 'ollama');
        expect(ollamaEntry).toMatchObject({
            tier: 'local',
            costUsd: 0,
            fulfillmentId: 'FL-LOCAL-01',
            profileId: 'catalog_visual',
            uid: 'system.catalog',
            trace: 'tr-local-1',
        });
    });

    test('2. SoloPeerProvider logs tier="peer" locally (costUsd=0) and forwards X-Fulfillment-Id to remote peer', async () => {
        const capturedHeaders = [];
        const mockFetch = jest.fn(async (_url, init) => {
            capturedHeaders.push(init.headers);
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        decision: 'approve',
                        confidence: 0.92,
                        reason: 'tax code matched',
                        escalate: false,
                        metadata: {
                            provider: 'ollama',
                            model: 'qwen3.5:9b',
                            usage: { inputTokens: 1200, outputTokens: 300 },
                        },
                    },
                }),
            };
        });

        const peerRelay = createPeerRelay({
            endpoint: 'https://catalog-api.w3os.net/jsonrpc',
            apiKey: 'peer-key-1',
            fetchFn: mockFetch,
        });
        const provider = new SoloPeerProvider({ peerRelay });

        await walContext.run(
            { uid: 'system.finance', trace: 'tr-peer-88', depth: 2, fulfillmentId: 'FL-FIN-20261116-09', profileId: 'finance_invoice_1688' },
            async () => {
                const out = await provider.decide({
                    instruction: 'Check tax code',
                    context: { item: 'cable' },
                    choices: ['approve', 'defer'],
                    model: 'solo-peer/ollama/qwen3.5:9b',
                });
                expect(out.success).toBe(true);
            }
        );

        expect(capturedHeaders.length).toBe(1);
        expect(capturedHeaders[0]['X-Fulfillment-Id']).toBe('FL-FIN-20261116-09');
        expect(capturedHeaders[0]['X-Fulfillment-Profile']).toBe('finance_invoice_1688');
        expect(capturedHeaders[0]['X-Trace-Id']).toBe('tr-peer-88');

        const ffStats = await tokenLogger.fulfillmentStats(redis, { id: 'FL-FIN-20261116-09' });
        expect(ffStats.item).toMatchObject({
            id: 'FL-FIN-20261116-09',
            profileId: 'finance_invoice_1688',
            totalCalls: 1,
            costUsd: 0,
        });
        expect(ffStats.item.tiers.peer).toMatchObject({
            calls: 1,
            inputTokens: 1200,
            outputTokens: 300,
            costUsd: 0,
        });
    });

    test('3. Router trace/forward/tasks + relay.call propagate X-Fulfillment-Id securely only for authenticated callers', async () => {
        // Unauthenticated caller cannot spoof X-Fulfillment-Id
        const unauthCtx = traceHandler.resolve(
            { 'x-trace-id': 'trace_unauth_1', 'x-fulfillment-id': 'FL-SPOOF-1', 'x-fulfillment-profile': 'prof_1' },
            { authenticated: false }
        );
        expect(unauthCtx.fulfillmentId).toBeUndefined();
        expect(unauthCtx.profileId).toBeUndefined();

        // Authenticated caller with valid headers inherits them; invalid chars rejected
        const authCtx = traceHandler.resolve(
            { 'x-trace-id': 'trace_auth_1', 'x-fulfillment-id': 'FL:2026-001', 'x-fulfillment-profile': 'bad\r\nheader' },
            { authenticated: true }
        );
        expect(authCtx.fulfillmentId).toBe('FL:2026-001');
        expect(authCtx.profileId).toBeUndefined();

        // Relay forwards walContext & explicit opts headers to Router, and Router signs them into X-Router-Token meta
        const kp = tweetnacl.sign.keyPair();
        let receivedDownstreamReq = null;
        const downstreamSrv = http.createServer((req, res) => {
            const rawToken = req.headers['x-router-token'];
            const decoded = JSON.parse(Buffer.from(bs58.decode(rawToken)).toString('utf8'));
            receivedDownstreamReq = decoded;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
        });
        await new Promise((r) => downstreamSrv.listen(0, '127.0.0.1', r));
        const dsPort = downstreamSrv.address().port;

        let routerReceivedHeaders = null;
        const routerSrv = http.createServer(async (req, res) => {
            routerReceivedHeaders = req.headers;
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', async () => {
                const parsed = JSON.parse(body);
                const tCtx = traceHandler.resolve(req.headers, { authenticated: true });
                const data = await forwardHandler.forwardRequest({
                    targetService: { url: `http://127.0.0.1:${dsPort}/jsonrpc` },
                    method: parsed.method,
                    params: parsed.params,
                    jsonrpc: '2.0',
                    id: parsed.id,
                    sessionUser: { uid: 'system.finance' },
                    isAdmin: false,
                    keypair: kp,
                    sourceHeaders: req.headers,
                    traceCtx: tCtx,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            });
        });
        await new Promise((r) => routerSrv.listen(0, '127.0.0.1', r));
        const rPort = routerSrv.address().port;

        try {
            const relay = createRelay({
                serviceName: 'finance',
                redis,
                routerUrl: `http://127.0.0.1:${rPort}/jsonrpc`,
            });
            await relay.setToken({ token: 'tok-valid-1', expiresAt: Date.now() + 30 * 86400_000, sub: 'system.finance' });

            await walContext.run({ uid: 'system.finance', trace: 'tr-relay-1', depth: 1, fulfillmentId: 'FL-CTX-100', profileId: 'prof.ctx' }, async () => {
                await relay.call('agent.chat', { text: 'hi' });
            });

            expect(routerReceivedHeaders['x-fulfillment-id']).toBe('FL-CTX-100');
            expect(routerReceivedHeaders['x-fulfillment-profile']).toBe('prof.ctx');

            const downstreamCtx = requestContext({ user: receivedDownstreamReq.user, meta: receivedDownstreamReq.meta, constraints: receivedDownstreamReq.constraints });
            expect(downstreamCtx).toMatchObject({
                uid: 'system.finance',
                trace: 'tr-relay-1',
                fulfillmentId: 'FL-CTX-100',
                profileId: 'prof.ctx',
            });

            // Explicit 3rd-arg override on relay.call
            await relay.call('agent.chat', { text: 'override' }, { fulfillmentId: 'FL-EXPLICIT-200', profileId: 'prof.explicit' });
            expect(receivedDownstreamReq.meta.fulfillmentId).toBe('FL-EXPLICIT-200');
            expect(receivedDownstreamReq.meta.profileId).toBe('prof.explicit');

            // Router _tasks per-task fulfillmentId propagation
            await redis.set('SYSTEM:CONFIG:TASK_WHITELIST', JSON.stringify({
                agent: { allowFrom: ['fulfillment'], allowMethods: ['*'] },
            }));
            tasksHandler.invalidate();
            await tasksHandler.processTasks(
                [{ service: 'agent', method: 'agent.chat', fulfillmentId: 'FL-TASK-300', profileId: 'prof.task', params: { text: 'bg' } }],
                'system.fulfillment',
                false,
                { agent: { url: `http://127.0.0.1:${dsPort}/jsonrpc` } },
                kp,
                redis,
                'fulfillment',
                {},
                { trace: 'tr-task-1', depth: 0 }
            );
            expect(receivedDownstreamReq.meta.fulfillmentId).toBe('FL-TASK-300');
            expect(receivedDownstreamReq.meta.profileId).toBe('prof.task');
        } finally {
            await new Promise((r) => routerSrv.close(r));
            await new Promise((r) => downstreamSrv.close(r));
        }
    });

    test('4. Nexus Sentinel autorun injects fulfillmentId & profileId into walContext on EVENT:FULFILLMENT:TRANSITIONED', async () => {
        let seenStore = null;
        const mockRelay = {
            async call(method) {
                if (method === 'agent.decide') {
                    seenStore = walContext.getStore();
                    return { decision: 'retry', confidence: 0.95, reason: 'ok', escalate: false, metadata: { model: 'ollama/qwen3.5:9b' } };
                }
                return { ok: true };
            },
        };
        const mockAssembler = {
            async assemble(_agent, event) {
                return {
                    skip: false,
                    payload: {
                        event: { payload: JSON.parse(event.payload) },
                        context: { system_prompt: 'Decide next step', data: {} },
                    },
                };
            },
            buildEmit() { return null; },
        };

        const streamLogic = createStream(
            redis,
            {
                redis: { emitGuardPrefix: 'NEXUS:EMIT:', dlqPrefix: 'NEXUS:DLQ:' },
                consumer: { retryBaseMs: 100, retryMaxMs: 1000, emitGuardTtlSec: 60 },
            },
            {
                relay: mockRelay,
                assembler: mockAssembler,
            }
        );

        await streamLogic.deliverEvent({
            stream: 'EVENT:FULFILLMENT:TRANSITIONED',
            agentId: 'snt-1',
            agent: { reachability: 'webhook', context: { autorun: { choices: ['retry', 'defer'] } } },
            event: {
                trace_id: 'tr-ff-sentinel',
                depth: '1',
                payload: JSON.stringify({ id: 'FL-SNT-777', profileId: 'steward_tax_flow', to: 'ASSIST_REQUIRED' }),
            },
            ref: '1700000-0',
        });

        expect(seenStore).toMatchObject({
            trace: 'tr-ff-sentinel',
            depth: 1,
            fulfillmentId: 'FL-SNT-777',
            profileId: 'steward_tax_flow',
        });
    });

    test('5. agent.stats.record idempotency, fulfillment batch query, and unauthorized (-32003) rejection', async () => {
        const first = await tokenLogger.record(redis, {
            provider: 'codex-rpa',
            model: 'codex-image-gen',
            tier: 'rpa',
            method: 'connector.image.auto',
            calls: 1,
            images: 4,
            costUsd: 0,
            fulfillmentId: 'FL-VIS-001',
            profileId: 'catalog_visual_automation',
            idempotencyKey: 'connjob-001-route-0',
        });
        expect(first).toMatchObject({ recorded: true, duplicate: false, tier: 'rpa', costUsd: 0 });

        // Duplicate idempotencyKey must be suppressed
        const dup = await tokenLogger.record(redis, {
            provider: 'codex-rpa',
            model: 'codex-image-gen',
            tier: 'rpa',
            method: 'connector.image.auto',
            calls: 1,
            images: 4,
            costUsd: 0,
            fulfillmentId: 'FL-VIS-001',
            profileId: 'catalog_visual_automation',
            idempotencyKey: 'connjob-001-route-0',
        });
        expect(dup).toMatchObject({ recorded: false, duplicate: true });

        // Batch query with existing + missing fulfillmentId + profile daily rollup
        const stats = await tokenLogger.fulfillmentStats(redis, {
            ids: ['FL-VIS-001', 'FL-MISSING-999'],
            profile: 'catalog_visual_automation',
            days: 3,
        });
        expect(stats.items.length).toBe(2);
        expect(stats.items[0]).toMatchObject({
            id: 'FL-VIS-001',
            profileId: 'catalog_visual_automation',
            totalCalls: 1,
            images: 4,
            costUsd: 0,
        });
        expect(stats.items[0].tiers.rpa).toMatchObject({ calls: 1, images: 4 });
        expect(stats.items[1]).toMatchObject({
            id: 'FL-MISSING-999',
            totalCalls: 0,
            costUsd: 0,
        });
        expect(stats.profile.summary.totalCalls).toBe(1);

        // Unauthorized principal check helper (-32003)
        expect(() => tokenLogger.assertStatsRecordAuthorized({ user: 'alice', permit: 'user' })).toThrow();
        try {
            tokenLogger.assertStatsRecordAuthorized({ user: 'alice', permit: 'user' });
        } catch (err) {
            expect(err.code).toBe(-32003);
        }
        expect(() => tokenLogger.assertStatsRecordAuthorized({ user: 'system.connector', permit: 'user' })).not.toThrow();
        expect(() => tokenLogger.assertStatsRecordAuthorized({ user: 'admin', permit: 'admin' })).not.toThrow();
    });
});
