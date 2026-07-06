/**
 * Hermetic unit test for library/vector.js — the AI-native vector/semantic-memory
 * utility.
 *
 * ⚠️ STUB NOTICE: As of this writing, vector.js is an UNIMPLEMENTED PLACEHOLDER.
 * All four methods (upsert / query / remove / ensureSchema) are TODO stubs that
 * only console.log and return canned objects — there is NO embedding, NO vector
 * store, NO similarity search. These tests pin the *current stub contract* only;
 * the 100% coverage they produce is VACUOUS and must NOT be read as evidence that
 * real vector functionality works.
 *
 * The factory takes (redisClient, config); the stub never touches either, so we
 * inject a no-op fake redis and an empty config. The only side effect is the
 * noisy console.log, which we silence and restore.
 */
const makeVector = require('../vector');

// No-op fake redis: the stub never calls it, but we pass a defensive double so
// any accidental future use surfaces as an obvious failure rather than a crash.
const fakeRedis = {};

describe('vector (STUB) — current placeholder contract', () => {
    let vector;
    let logSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        vector = makeVector(fakeRedis, {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    test('factory returns the four stub methods', () => {
        expect(typeof vector.upsert).toBe('function');
        expect(typeof vector.query).toBe('function');
        expect(typeof vector.remove).toBe('function');
        expect(typeof vector.ensureSchema).toBe('function');
    });

    test('upsert({id}) echoes the id back as { success, id }', async () => {
        await expect(vector.upsert({ id: 'uid-abc_msg-1' })).resolves.toEqual({
            success: true,
            id: 'uid-abc_msg-1',
        });
    });

    test('query({text}) defaults topK to 5 with empty results', async () => {
        await expect(vector.query({ text: 'find related memories' })).resolves.toEqual({
            results: [],
            topK: 5,
        });
    });

    test('query({text, topK}) honors the provided topK', async () => {
        await expect(vector.query({ text: 'q', topK: 12 })).resolves.toEqual({
            results: [],
            topK: 12,
        });
    });

    test('remove(...) returns { success: true }', async () => {
        await expect(vector.remove({ id: 'uid-abc_msg-1' })).resolves.toEqual({ success: true });
    });

    test('ensureSchema(...) returns { success: true }', async () => {
        await expect(vector.ensureSchema({ dims: 1536 })).resolves.toEqual({ success: true });
    });
});
