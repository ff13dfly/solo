/**
 * Hermetic Regression Suite:
 *   1. `core/agent` ProviderFactory explicit prefix routing (`ollama/qwen3.5:9b`, `solo-peer/ollama/qwen3.5:9b`, `openai/gpt-4o`, `qwen-plus`)
 *   2. `core/agent` Native `OllamaProvider` (`/api/chat`, `think: false`, `keep_alive: '30m'`, no `response_format`, JSON extraction, vision base64, tokenLogger)
 *   3. `library/peer-relay.js` + `SoloPeerProvider` (M2M ApiKey, challenge-response single-flight login, 401 re-login, hop-count loop guard)
 *   4. `library/outbound.js` (SSRF denylist, DNS rebinding domains, trustedPeers, socket DNS pinning, maxBodyBytes cap, hop-by-hop redirect SSRF check)
 *   5. `autocheck/static/security.js` (business service direct `:11434` / LLM API key warning)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HAS_SOLO_SOURCE_TREE = fs.existsSync(path.join(__dirname, '../../core/agent/providers/index.js'));
const describeInSoloRepo = HAS_SOLO_SOURCE_TREE ? describe : describe.skip;

const ProviderFactory = HAS_SOLO_SOURCE_TREE ? require('../../core/agent/providers') : null;
const OllamaProvider = HAS_SOLO_SOURCE_TREE ? require('../../core/agent/providers/ollama') : null;
const SoloPeerProvider = HAS_SOLO_SOURCE_TREE ? require('../../core/agent/providers/solo-peer') : null;
const tokenLogger = HAS_SOLO_SOURCE_TREE ? require('../../core/agent/lib/tokenLogger') : null;
const { createPeerRelay } = require('../peer-relay');
const {
    outboundRequest,
    assertPublicHost,
    isForbiddenHostname,
    isPrivateOrReservedIp,
    isTrustedPeer,
} = require('../outbound');
const securityCheck = require('../../autocheck/static/security');

function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

describe('outbound-layering-ollama-agent-and-peer-relay regression suite', () => {
    beforeEach(() => {
        if (ProviderFactory) ProviderFactory.instances = {};
    });

    describeInSoloRepo('1. ProviderFactory explicit namespace prefix routing', () => {
        test('routes ollama/qwen3.5:9b and bare qwen3.5:9b to OllamaProvider instead of QwenProvider', () => {
            const cfg = { provider: 'qwen', agents: { qwen: { language: 'zh' }, ollama: { language: 'zh' } } };
            expect(ProviderFactory.resolveProviderType(cfg, 'ollama/qwen3.5:9b')).toBe('ollama');
            expect(ProviderFactory.resolveProviderType(cfg, 'ollama:qwen3.5:9b')).toBe('ollama');
            expect(ProviderFactory.resolveProviderType(cfg, 'qwen3.5:9b')).toBe('ollama');

            const provider = ProviderFactory.getProvider(cfg, 'ollama/qwen3.5:9b');
            expect(provider).toBeInstanceOf(OllamaProvider);
        });

        test('routes solo-peer/ollama/qwen3.5:9b to SoloPeerProvider', () => {
            const cfg = { provider: 'qwen', peerAgentUrl: 'http://127.0.0.1:8600' };
            expect(ProviderFactory.resolveProviderType(cfg, 'solo-peer/ollama/qwen3.5:9b')).toBe('solo-peer');
            const provider = ProviderFactory.getProvider(cfg, 'solo-peer/ollama/qwen3.5:9b');
            expect(provider).toBeInstanceOf(SoloPeerProvider);
        });

        test('routes cloud models (qwen-plus, gemini-2.5-flash, openai/gpt-4o) and honors AI_PROVIDER=mock lock', () => {
            const cfg = { provider: 'qwen' };
            expect(ProviderFactory.resolveProviderType(cfg, 'qwen-plus')).toBe('qwen');
            expect(ProviderFactory.resolveProviderType(cfg, 'qwen/qwen-max')).toBe('qwen');
            expect(ProviderFactory.resolveProviderType(cfg, 'gemini-2.5-flash')).toBe('gemini');
            expect(ProviderFactory.resolveProviderType(cfg, 'openai/qwen3.5:9b')).toBe('openai');
            expect(ProviderFactory.resolveProviderType({ provider: 'ollama' }, '')).toBe('ollama');
            expect(ProviderFactory.resolveProviderType({ provider: 'mock' }, 'ollama/qwen3.5:9b')).toBe('mock');
        });
    });

    describeInSoloRepo('2. OllamaProvider native /api/chat protocol & MLX safety', () => {
        test('strips ollama/ prefix, sends think:false & keep_alive:30m, never sends response_format, and logs tokens', async () => {
            const capturedRequests = [];
            const fakeFetch = async (url, init) => {
                const body = JSON.parse(init.body);
                capturedRequests.push({ url, body });
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        model: body.model,
                        message: {
                            role: 'assistant',
                            content: '```json\n{"decision":"ALLOW","confidence":0.94,"reason":"normal status"}\n```',
                        },
                        prompt_eval_count: 120,
                        eval_count: 35,
                    }),
                };
            };

            const loggedTokens = [];
            const origLog = tokenLogger.log;
            tokenLogger.log = (entry) => loggedTokens.push(entry);

            try {
                const provider = new OllamaProvider({
                    ollamaBaseUrl: 'http://127.0.0.1:11434',
                    ollamaKeepAlive: '30m',
                    ollamaThink: false,
                    fetchFn: fakeFetch,
                });

                const decideRes = await provider.decide({
                    instruction: 'Check node status',
                    context: { cpu: 12 },
                    choices: ['ALLOW', 'WARN'],
                    model: 'ollama/qwen3.5:9b',
                });

                expect(decideRes.success).toBe(true);
                expect(decideRes.data).toEqual({
                    decision: 'ALLOW',
                    confidence: 0.94,
                    reason: 'normal status',
                });
                expect(decideRes.metadata.provider).toBe('ollama');
                expect(decideRes.metadata.model).toBe('qwen3.5:9b');

                expect(capturedRequests).toHaveLength(1);
                const sent = capturedRequests[0];
                expect(sent.url).toBe('http://127.0.0.1:11434/api/chat');
                expect(sent.body.model).toBe('qwen3.5:9b');
                expect(sent.body.stream).toBe(false);
                expect(sent.body.keep_alive).toBe('30m');
                expect(sent.body.think).toBe(false);
                expect(sent.body.response_format).toBeUndefined();

                expect(loggedTokens).toHaveLength(1);
                expect(loggedTokens[0]).toMatchObject({
                    method: 'agent.decide',
                    model: 'qwen3.5:9b',
                    provider: 'ollama',
                    inputTokens: 120,
                    outputTokens: 35,
                });

                // Vision parseImage strips data URL prefix and populates messages[0].images
                const imgRes = await provider.parseImage({
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
                    prompt: 'OCR this label',
                    model: 'ollama/qwen3.5:9b',
                });
                expect(imgRes.success).toBe(true);
                expect(capturedRequests[1].body.messages[0].images).toEqual(['iVBORw0KGgoAAAANSUhEUg==']);
            } finally {
                tokenLogger.log = origLog;
            }
        });

        test('decide degrades gracefully ({ success: false }) when Ollama returns non-JSON text', async () => {
            const provider = new OllamaProvider({
                fetchFn: async () => ({
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        message: { content: 'Sorry, I cannot decide right now.' },
                    }),
                }),
            });
            const res = await provider.decide({
                instruction: 'Check',
                context: {},
                choices: ['A', 'B'],
                model: 'ollama/qwen3.5:9b',
            });
            expect(res.success).toBe(false);
            expect(res.metadata.provider).toBe('ollama');
        });
    });

    describe('3. library/peer-relay.js & SoloPeerProvider cross-box delegation', () => {
        test('coalesces concurrent challenge-response logins, re-logins on -32001, enforces hop limit, and forwards solo-peer/<model>', async () => {
            let loginRequestCount = 0;
            let loginVerifyCount = 0;
            let issuedToken = 'tok-1';
            let failNextWithExpired = false;
            const rpcCalls = [];

            const fakeFetch = async (url, init) => {
                const body = JSON.parse(init.body);
                const auth = init.headers?.Authorization || '';
                rpcCalls.push({ url, method: body.method, params: body.params, auth });

                if (body.method === 'user.login.request') {
                    loginRequestCount += 1;
                    await new Promise((r) => setTimeout(r, 20));
                    return {
                        ok: true,
                        status: 200,
                        text: async () => JSON.stringify({
                            jsonrpc: '2.0',
                            id: body.id,
                            result: { challenge: 'ch-123', salt: 'salt-abc' },
                        }),
                    };
                }

                if (body.method === 'user.login.verify') {
                    loginVerifyCount += 1;
                    const expectedSig = sha256('ch-123' + sha256('secret-pass' + 'salt-abc'));
                    if (body.params.signature !== expectedSig) {
                        return {
                            ok: false,
                            status: 401,
                            text: async () => JSON.stringify({
                                jsonrpc: '2.0',
                                id: body.id,
                                error: { code: -32001, message: 'Bad signature' },
                            }),
                        };
                    }
                    issuedToken = `tok-${loginVerifyCount}`;
                    return {
                        ok: true,
                        status: 200,
                        text: async () => JSON.stringify({
                            jsonrpc: '2.0',
                            id: body.id,
                            result: { token: issuedToken, expiresAt: Date.now() + 3600_000 },
                        }),
                    };
                }

                if (failNextWithExpired) {
                    failNextWithExpired = false;
                    return {
                        ok: false,
                        status: 401,
                        text: async () => JSON.stringify({
                            jsonrpc: '2.0',
                            id: body.id,
                            error: { code: -32001, message: 'Token expired' },
                        }),
                    };
                }

                if (body.method === 'agent.decide') {
                    return {
                        ok: true,
                        status: 200,
                        text: async () => JSON.stringify({
                            jsonrpc: '2.0',
                            id: body.id,
                            result: {
                                decision: 'REQUEUE',
                                confidence: 0.91,
                                reason: 'transient timeout',
                                escalate: false,
                                metadata: { provider: 'ollama', model: body.params.model },
                            },
                        }),
                    };
                }

                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id,
                        result: { success: true, text: `pong:${body.params.model}`, metadata: { provider: 'ollama' } },
                    }),
                };
            };

            const peer = createPeerRelay({
                endpoint: 'http://100.68.103.124:8600',
                user: 'operator',
                password: 'secret-pass',
                maxHops: 3,
                fetchFn: fakeFetch,
            });

            // Fire 3 concurrent calls — single-flight login must coalesce into 1 handshake
            const [r1, r2, r3] = await Promise.all([
                peer.call('agent.chat', { text: 'a', model: 'ollama/qwen3.5:9b' }),
                peer.call('agent.chat', { text: 'b', model: 'ollama/qwen3.5:9b' }),
                peer.call('agent.chat', { text: 'c', model: 'ollama/qwen3.5:9b' }),
            ]);
            expect(r1.text).toBe('pong:ollama/qwen3.5:9b');
            expect(r2.text).toBe('pong:ollama/qwen3.5:9b');
            expect(r3.text).toBe('pong:ollama/qwen3.5:9b');
            expect(loginRequestCount).toBe(1);
            expect(loginVerifyCount).toBe(1);

            // Simulate remote token expiry (-32001) -> automatic 1-time re-login and retry
            failNextWithExpired = true;
            const r4 = await peer.call('agent.chat', { text: 'after-expiry', model: 'ollama/qwen3.5:9b' });
            expect(r4.text).toBe('pong:ollama/qwen3.5:9b');
            expect(loginVerifyCount).toBe(2);

            // Hop guard blocks calls when hop >= maxHops (3)
            await expect(
                peer.call('agent.chat', { text: 'loop' }, { hop: 3 })
            ).rejects.toThrow(/maximum cross-box hop limit reached/);

            // SoloPeerProvider strips `solo-peer/` prefix and maps agent.decide contract (when core/agent source present)
            if (SoloPeerProvider) {
                const soloPeerProvider = new SoloPeerProvider({ peerRelay: peer });
                const decideOut = await soloPeerProvider.decide({
                    instruction: 'Triage DLQ',
                    context: { error: 'ETIMEDOUT' },
                    choices: ['REQUEUE', 'ARCHIVE'],
                    model: 'solo-peer/ollama/qwen3.5:9b',
                });
                expect(decideOut.success).toBe(true);
                expect(decideOut.data).toEqual({
                    decision: 'REQUEUE',
                    confidence: 0.91,
                    reason: 'transient timeout',
                });
                expect(decideOut.metadata.provider).toBe('solo-peer');
                expect(decideOut.metadata.model).toBe('ollama/qwen3.5:9b');
            }
        });
    });

    describe('4. library/outbound.js SSRF, DNS pinning, redirect hops, and maxBodyBytes', () => {
        test('blocks forbidden hostnames, DNS rebinding domains, private/CGNAT IPs, and allows explicit trustedPeers', async () => {
            expect(isForbiddenHostname('localhost')).toBe(true);
            expect(isForbiddenHostname('127.0.0.1.nip.io')).toBe(true);
            expect(isForbiddenHostname('attacker.sslip.io')).toBe(true);
            expect(isForbiddenHostname('sub.localtest.me')).toBe(true);
            expect(isForbiddenHostname('metadata.google.internal')).toBe(true);
            expect(isForbiddenHostname('api.example.com')).toBe(false);

            expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
            expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
            expect(isPrivateOrReservedIp('100.68.103.124')).toBe(true);
            expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);

            // Blocked without trustedPeers
            await expect(assertPublicHost('100.68.103.124')).rejects.toThrow(/private or reserved IP blocked/);

            // Allowed when explicitly listed in trustedPeers
            const trusted = [{ host: '*.w3os.net', ip: '100.68.103.124' }];
            expect(isTrustedPeer('pulse.w3os.net', '100.68.103.124', trusted)).toBe(true);
            expect(isTrustedPeer('evil.example.com', '100.68.103.124', trusted)).toBe(false);

            const resolved = await assertPublicHost('pulse.w3os.net', {
                trustedPeers: trusted,
                lookupFn: async () => [{ address: '100.68.103.124', family: 4 }],
            });
            expect(resolved).toEqual({ address: '100.68.103.124', family: 4 });
        });

        test('enforces maxBodyBytes cap and blocks 302 redirect hop targeting internal/loopback address', async () => {
            const server = http.createServer((req, res) => {
                if (req.url === '/redirect-to-internal') {
                    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
                    res.end();
                    return;
                }
                if (req.url === '/oversized') {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('X'.repeat(4096));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, hostHeader: req.headers.host }));
            });

            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const { port } = server.address();

            try {
                // 1) Normal request with allowLoopback: true succeeds and pins IP
                const okRes = await outboundRequest(`http://127.0.0.1:${port}/ok`, {
                    allowLoopback: true,
                });
                expect(okRes.status).toBe(200);
                expect(okRes.body).toEqual({ ok: true, hostHeader: `127.0.0.1:${port}` });
                expect(okRes.pinnedAddress).toBe('127.0.0.1');

                // 2) Redirect hop to 169.254.169.254 is blocked when followRedirects: true
                await expect(
                    outboundRequest(`http://127.0.0.1:${port}/redirect-to-internal`, {
                        allowLoopback: true,
                        followRedirects: true,
                    })
                ).rejects.toThrow(/private or reserved IP blocked/);

                // 3) Response exceeding maxBodyBytes is aborted with ERR_OUTBOUND_MAX_BODY
                await expect(
                    outboundRequest(`http://127.0.0.1:${port}/oversized`, {
                        allowLoopback: true,
                        maxBodyBytes: 1024,
                    })
                ).rejects.toThrow(/exceeded 1024 bytes cap/);
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        });
    });

    describe('5. autocheck static security check warns on direct Ollama (:11434) or LLM API key in business services', () => {
        test('emits warning when a business service references :11434 or DASHSCOPE_API_KEY directly', () => {
            const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-autocheck-ai-'));
            const svcDir = path.join(tmpRoot, 'steward');
            fs.mkdirSync(path.join(svcDir, 'handlers'), { recursive: true });
            fs.mkdirSync(path.join(svcDir, 'logic'), { recursive: true });
            fs.writeFileSync(
                path.join(svcDir, 'handlers/auth.js'),
                "const { createAuthHandlers } = require('../../../library/auth'); module.exports = createAuthHandlers();"
            );
            fs.writeFileSync(
                path.join(svcDir, 'logic/bad-ai.js'),
                "const url = 'http://127.0.0.1:11434/api/chat'; const k = process.env.DASHSCOPE_API_KEY;\n"
            );

            try {
                const results = { passed: [], warnings: [], errors: [] };
                securityCheck.check(svcDir, results);
                const aiWarnings = results.warnings.filter((w) => w.includes('发现直接调用 LLM/Ollama'));
                expect(aiWarnings.length).toBeGreaterThanOrEqual(2);
            } finally {
                fs.rmSync(tmpRoot, { recursive: true, force: true });
            }
        });
    });

    describeInSoloRepo('6. v1.3.4 minor follow-up: user.token.revoke delegated guard', () => {
        test('allows delegated non-admin bot to revoke normal seat user tokens, but blocks admin/operator/system.*', async () => {
            const createBotLogic = require('../../core/user/logic/bot');
            const store = new Map([
                ['user:u_seat0000000001', JSON.stringify({ id: 'u_seat0000000001', role: 'user', categories: { POWER: 'user' } })],
                ['user:u_admin000000001', JSON.stringify({ id: 'u_admin000000001', role: 'admin', permit: { allow_all: true } })],
                ['user:u_oper0000000001', JSON.stringify({ id: 'u_oper0000000001', role: 'user', categories: { POWER: 'operator' } })],
            ]);
            const fakeRedis = {
                get: async (k) => store.get(k) || null,
                sMembers: async () => ['tok_a', 'tok_b'],
                del: async () => 1,
                multi: () => {
                    const ops = [];
                    return {
                        del: (k) => { ops.push(k); },
                        exec: async () => ops.map(() => 1),
                    };
                },
            };
            const botLogic = createBotLogic(fakeRedis, { redis: { userPrefix: 'user:' } });

            // Delegated non-admin caller can revoke a normal seat user
            const ok = await botLogic.revoke(
                { uid: 'u_seat0000000001' },
                { isAdmin: false, user: 'system.steward' }
            );
            expect(ok).toEqual({ uid: 'u_seat0000000001', revoked: 2 });

            // Delegated non-admin caller is blocked from revoking admin, operator, or system.*
            await expect(
                botLogic.revoke({ uid: 'u_admin000000001' }, { isAdmin: false, user: 'system.steward' })
            ).rejects.toMatchObject({ code: -32005 });

            await expect(
                botLogic.revoke({ uid: 'u_oper0000000001' }, { isAdmin: false, user: 'system.steward' })
            ).rejects.toMatchObject({ code: -32005 });

            await expect(
                botLogic.revoke({ uid: 'system.gateway' }, { isAdmin: false, user: 'system.steward' })
            ).rejects.toMatchObject({ code: -32005 });
        });
    });
});
