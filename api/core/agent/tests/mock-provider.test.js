/**
 * Hermetic unit test for the offline mock LLM provider + factory selection.
 * No API keys, no network — this is exactly what lets the agent service run in CI/e2e.
 */
const ProviderFactory = require('../providers');
const MockProvider = require('../providers/mock');

describe('MockProvider (offline, deterministic)', () => {
    const p = new MockProvider({});

    test('chat echoes its prompt with a stable prefix + mock metadata', async () => {
        const r = await p.chat({ text: 'review payment 7777', model: 'gemini-1.5-flash' });
        expect(r.success).toBe(true);
        expect(r.text).toBe('MOCK_REPLY::review payment 7777');
        expect(r.metadata.provider).toBe('mock');
        expect(r.metadata.model).toBe('gemini-1.5-flash');
    });

    test('chat tolerates missing text', async () => {
        const r = await p.chat({});
        expect(r.text).toBe('MOCK_REPLY::');
    });

    test('parseText / translateText return deterministic stubs', async () => {
        expect((await p.parseText({ text: 'x' })).data).toEqual({ echo: 'x' });
        expect((await p.translateText({ text: 'x', targetLang: 'en' })).translatedText).toBe('MOCK_TR[en]::x');
    });
});

describe('ProviderFactory mock selection', () => {
    test('forced provider=mock wins even when a gemini-* model is resolved', () => {
        const prov = ProviderFactory.getProvider({ provider: 'mock', agents: {} }, 'gemini-1.5-flash');
        expect(prov.constructor.name).toBe('MockProvider');
    });

    test('model name starting with "mock" routes to the mock provider', () => {
        const prov = ProviderFactory.getProvider({ provider: 'gemini', agents: {} }, 'mock-1');
        expect(prov.constructor.name).toBe('MockProvider');
    });
});
