/** Hermetic: orchestrator runtime auto↔manual pause flag. */
const createControl = require('../logic/control');
const config = require('../config');

function fakeRedis() {
    const store = {};
    return { _store: store, async get(k) { return store[k] || null; }, async set(k, v) { store[k] = v; }, async del(k) { delete store[k]; } };
}

describe('orchestrator control (auto↔manual pause)', () => {
    test('pause / resume / status / isPaused toggle the runtime flag', async () => {
        const redis = fakeRedis();
        const c = createControl(redis);
        const KEY = config.redis.controlPausedKey;
        expect(await c.isPaused()).toBe(false);
        expect(await c.pause()).toEqual({ paused: true });
        expect(redis._store[KEY]).toBe('1');
        expect(await c.status()).toEqual({ paused: true });
        expect(await c.resume()).toEqual({ paused: false });
        expect(redis._store[KEY]).toBeUndefined();
    });
});
