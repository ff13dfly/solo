/**
 * 00 · sample — demonstrates the four-pronged assertion pattern.
 *
 * Pattern:  ① RPC returns result  ② Redis has the record  ③ ERROR:QUEUE is empty.
 * Copy this file and rename to add tests for your own services.
 *
 * Run:  npm test                  (from e2e/)
 * Pre:  bash ../deploy/run.sh     (stack must be running)
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

describe('00 · sample (user register + login flow)', () => {
    let redis, uid, token;
    const name = `e2e-sample-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        // sessionUser: register + real SHA-256 challenge-response login + optional permit grant
        ({ uid, token } = await sessionUser(redis, name, {}));
    }, 20_000);

    afterAll(async () => {
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    // ── ① API ────────────────────────────────────────────────────────────────

    test('user.profile returns registered data', async () => {
        const profile = V.assertResult(
            await rpc('user.profile', { uid }, token),
            'user.profile',
        );
        expect(profile.id).toBe(uid);     // user.profile returns `id` (= the uid); request param is `uid`
        expect(profile.name).toBe(name);
    });

    // ── ② Redis ──────────────────────────────────────────────────────────────

    test('user record present in Redis', async () => {
        const rec = await V.readKey(redis, `user:${uid}`);
        expect(rec).not.toBeNull();
        expect(rec.name).toBe(name);
        expect(await redis.sIsMember('user:ids', uid)).toBeTruthy();
    });

    // ── ③ no error queue noise ───────────────────────────────────────────────

    test('user service ERROR:QUEUE is empty', async () => {
        await V.assertNoErrors(redis, ['user']);
    });
});
