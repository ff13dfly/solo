/**
 * 00 · 真实登录(SHA-256 挑战-响应)—— 整套的根(§4).
 * register → login.request → 算 response → login.verify → 拿真 session token.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { createAndLogin, setPermit, cleanupUser } = require('../harness/identity');

describe('00 · real login (SHA-256 challenge-response)', () => {
    let redis;
    const name = `e2e-login-${process.pid}`;

    beforeAll(async () => { redis = await redisLib.connect(); });
    afterAll(async () => {
        const uid = await redis.get(`user:name:${name}`);
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('register → real login yields a working session token', async () => {
        const { uid, token } = await createAndLogin({ name, password: 'pw-12345' });

        // ① shape
        expect(uid).toMatch(/^[1-9A-HJ-NP-Za-km-z]{16}$/);   // base58, 16 chars
        expect(token).toHaveLength(64);                       // 32 bytes hex

        // ① token actually authenticates: user.profile (now permit-gated) via Router resolves
        //    the session. Grant this user the profile method first — a bare permit can't call it.
        await setPermit(redis, uid, { allow_all: false, services: { user: ['user.profile'] } });
        const prof = V.assertResult(await rpc('user.profile', { uid }, token), 'user.profile');
        expect(prof.id).toBe(uid);

        // ② Redis 落库:user 记录 + name 索引 + ids set
        await V.assertRecord(redis, `user:${uid}`, { name, status: 'ACTIVE' });
        expect(await redis.get(`user:name:${name}`)).toBe(uid);
        expect(await redis.sIsMember('user:ids', uid)).toBeTruthy();

        // ② challenge 一次性消费 + session 落库
        expect(await redis.get(`challenge:${name}`)).toBeNull();
        expect(await redis.get(`session:${token}`)).toBeTruthy();
    });

    test('wrong response is rejected', async () => {
        const challenge = V.assertResult(await rpc('user.login.request', { name }), 'login.request').challenge;
        const bad = await rpc('user.login.verify', { name, challenge, response: 'deadbeef'.repeat(8), deviceId: 'e2e' });
        const err = V.assertRpcError(bad, undefined, 'bad response must fail');
        expect(err.code).not.toBe(-32601);   // reachable: not method-not-found
    });
});
