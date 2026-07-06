/**
 * Hermetic unit test for the agent per-capability model config write path
 * (agent.model.list / set / reset). Fake redis, no network — replaces the
 * old redis-cli-only SYSTEM:CONFIG:AI_MODELS workflow.
 */
const mc = require('../logic/model_config');

function fakeRedis() {
    const store = new Map();
    return {
        store,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
    };
}

describe('agent model_config — admin write path', () => {
    test('list: no overrides → effective === default, override undefined', async () => {
        mc.init(fakeRedis());
        const { models } = await mc.listModels();
        const chat = models.find((m) => m.capability === 'agent.chat');
        expect(chat.effective).toBe(mc.HARDCODED_DEFAULTS['agent.chat']);
        expect(chat.default).toBe(mc.HARDCODED_DEFAULTS['agent.chat']);
        expect(chat.override).toBeUndefined();
    });

    test('set: override persists + takes effect immediately (cache busted, no TTL wait)', async () => {
        const r = fakeRedis(); mc.init(r);
        const out = await mc.setModel({ capability: 'agent.chat', model: 'gemini-5-pro' });
        expect(out.effective).toBe('gemini-5-pro');
        expect(await mc.resolve('agent.chat')).toBe('gemini-5-pro');
        expect(JSON.parse(r.store.get('SYSTEM:CONFIG:AI_MODELS'))['agent.chat']).toBe('gemini-5-pro');
        // list now reflects the override
        const { models } = await mc.listModels();
        expect(models.find((m) => m.capability === 'agent.chat').override).toBe('gemini-5-pro');
    });

    test('set model:null → provider default (effective mirrors hardcoded null for image.ps)', async () => {
        mc.init(fakeRedis());
        const out = await mc.setModel({ capability: 'image.ps', model: null });
        expect(out.model).toBeNull();
        expect(out.effective).toBeNull();   // image.ps hardcoded default is null
    });

    test('unknown capability → INVALID_PARAMS (-32602)', async () => {
        mc.init(fakeRedis());
        await expect(mc.setModel({ capability: 'bogus.cap', model: 'x' })).rejects.toMatchObject({ code: -32602 });
    });

    test('empty model string → INVALID_PARAMS (-32602)', async () => {
        mc.init(fakeRedis());
        await expect(mc.setModel({ capability: 'agent.chat', model: '' })).rejects.toMatchObject({ code: -32602 });
    });

    test('missing capability → MISSING_PARAM (-32602)', async () => {
        mc.init(fakeRedis());
        await expect(mc.setModel({})).rejects.toMatchObject({ code: -32602 });
    });

    test('reset: removes override → falls back to hardcoded default', async () => {
        const r = fakeRedis(); mc.init(r);
        await mc.setModel({ capability: 'agent.chat', model: 'gemini-5-pro' });
        const out = await mc.resetModel({ capability: 'agent.chat' });
        expect(out.effective).toBe(mc.HARDCODED_DEFAULTS['agent.chat']);
        expect(out.reset).toBe(true);
        expect(await mc.resolve('agent.chat')).toBe(mc.HARDCODED_DEFAULTS['agent.chat']);
        expect(JSON.parse(r.store.get('SYSTEM:CONFIG:AI_MODELS'))['agent.chat']).toBeUndefined();
    });

    test('resolve: caller params.model still wins over an override', async () => {
        mc.init(fakeRedis());
        await mc.setModel({ capability: 'agent.chat', model: 'gemini-5-pro' });
        expect(await mc.resolve('agent.chat', 'caller-supplied')).toBe('caller-supplied');
    });
});
