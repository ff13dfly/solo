/**
 * returns-contract.test.js — proves agent.* ACTUAL handler output satisfies the declared
 * return contract (introspection `returns_schema`). Hermetic: the real logic layer driven
 * over the MOCK LLM provider (AI_PROVIDER=mock), no live API keys, no network, no Redis.
 *
 * Why mock: every AI method in core/agent dispatches to a per-provider implementation
 * (providers/qwen/**, providers/gemini.js). Those need live keys + network + non-deterministic
 * output, which is exactly why core/agent/** is excluded from CI. providers/mock.js implements
 * the deterministic offline surface (chat / parseText / translateText / decide / focus) so the
 * logic → modelConfig.resolve → ProviderFactory(mock) → output loop runs hermetically.
 *
 * modelConfig.resolve() works WITHOUT a Redis client (falls back to HARDCODED_DEFAULTS), and
 * ProviderFactory forces the mock provider when config.provider === 'mock' regardless of the
 * resolved model name — so no Redis or stack is required for these paths.
 *
 * The remaining methods (vision/audio/image-gen/label/purpose/case + the inline stats &
 * providers handlers in index.js) need a real VL/LLM call, a non-mock provider, real RedisJSON,
 * or live config — they are NOT forced into this test; their returns_schema is static-derived
 * from the provider source and listed in the audit's `unverified`.
 *
 * NOTE on agent.focus: although providers/mock.js implements focus(), the logic layer's focus()
 * path eagerly requires logic/capability.js — a SINGLETON that opens a live Redis connection at
 * require-time (and keeps the handle open). To stay strictly hermetic (no Redis, clean exit) we
 * deliberately do NOT drive agent.focus here; its returns_schema is verified statically against
 * providers/mock.js + providers/qwen/intent.js and listed in the audit's `unverified`.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-agent-contract-${process.pid}`);
// Force the deterministic offline provider BEFORE config / logic are required (config reads
// process.env.AI_PROVIDER at module-load time).
process.env.AI_PROVIDER = 'mock';

const Methods = require('../logic');
const introspection = require('../handlers/introspection');
const { checkReturn } = require('../../../library/contract');

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

describe('agent.* — actual return satisfies declared returns_schema (mock provider)', () => {
    test('agent.chat → { success, text, metadata } matches contract', async () => {
        const res = await Methods.agent.chat({ text: 'hello world' });
        expect(checkReturn(method('agent.chat'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(typeof res.metadata).toBe('object');
        // mock echoes the prompt into `text` — proves the assembled input reached the provider.
        expect(res.text).toContain('hello world');
    });

    test('agent.text.parse → { success, data, metadata } matches contract', async () => {
        const res = await Methods.agent.text.parse({ text: 'parse me' });
        expect(checkReturn(method('agent.text.parse'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(res.data).toBeDefined();
        expect(typeof res.metadata).toBe('object');
    });

    test('agent.text.translate → { success, translatedText, sourceLang, metadata } matches contract', async () => {
        const res = await Methods.agent.text.translate({ text: 'hello', targetLang: 'zh' });
        expect(checkReturn(method('agent.text.translate'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(typeof res.translatedText).toBe('string');
        expect(typeof res.sourceLang).toBe('string');
    });

    test('agent.decide → { decision, confidence, reason, escalate, metadata } matches contract (high-confidence, no escalate)', async () => {
        const res = await Methods.agent.decide({
            instruction: 'approve or reject this',
            choices: ['approve', 'reject'],
        });
        expect(checkReturn(method('agent.decide'), res)).toEqual([]);
        // mock picks the first allowed choice at confidence 0.9 ⇒ inverted gate + no escalate.
        expect(res.decision).toBe('approve');
        expect(typeof res.confidence).toBe('number');
        expect(res.escalate).toBe(false);
        expect(typeof res.metadata).toBe('object');
    });

    test('agent.decide → escalates (still contract-valid) when a provider cannot decide', async () => {
        // Force a provider with no decide() so logic/decide.js degrades to escalation().
        // This exercises the escalation() return path: { decision:'defer', confidence, reason,
        // escalate:true, metadata } — proves the contract holds on the fail-soft branch too.
        const ProviderFactory = require('../providers');
        const orig = ProviderFactory.getProvider;
        ProviderFactory.getProvider = () => ({}); // no .decide
        try {
            const res = await Methods.agent.decide({ instruction: 'decide something' });
            expect(checkReturn(method('agent.decide'), res)).toEqual([]);
            expect(res.escalate).toBe(true);
            expect(res.decision).toBe('defer');
            expect(typeof res.metadata).toBe('object');
        } finally {
            ProviderFactory.getProvider = orig;
        }
    });

    // agent.focus is intentionally NOT driven here — see the header NOTE (its logic path eagerly
    // requires the Redis-connecting CapabilityManager singleton). Its contract is static-derived.
});
