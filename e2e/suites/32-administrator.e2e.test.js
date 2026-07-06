/**
 * 32 · administrator 登录(单管理员模型,SHA-256 挑战-响应,PBKDF2 账号).
 * 注入一个 admin 账号(administrator:user:{username},login_hash 已知)→ 真实
 * admin.login.request → 算 response=SHA256(challenge+login_hash) → admin.login.verify →
 * 拿 admin session token → 用它调通一个 admin 方法.（admin.self.lock 等危险方法排除）
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sha256 } = require('../lib/crypto');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('32 · administrator login (SHA-256 challenge-response)', () => {
    let redis, token;
    const username = `e2e-admin-${process.pid}`;
    const LOGIN_HASH = sha256(`adminpass-${process.pid}`);   // verify 只做 SHA256(challenge+login_hash),已知即可

    beforeAll(async () => {
        redis = await redisLib.connect();
        await redis.set(`administrator:user:${username}`, JSON.stringify({
            username, salt: 'e2e-salt', iterations: 200000, login_hash: LOGIN_HASH,
            role: 'admin', permit: { allow_all: true, services: {} },
        }));
    }, 20_000);
    afterAll(async () => {
        await redis.del(`administrator:user:${username}`);
        if (token) await redis.del(`session:${token}`);
        await redis.quit();
    });

    test('login.request → verify → token + session(allow_all)落库', async () => {
        const req = V.assertResult(await rpc('admin.login.request', { username }), 'admin.login.request');
        expect(req.salt).toBe('e2e-salt');
        expect(req.iterations).toBe(200000);

        const response = sha256(req.challenge + LOGIN_HASH);
        const ver = V.assertResult(await rpc('admin.login.verify', { username, challenge: req.challenge, response }), 'admin.login.verify');
        token = ver.token;
        expect(token).toHaveLength(64);

        const sess = JSON.parse(await redis.get(`session:${token}`));
        expect(sess.username).toBe(username);
        expect(sess.permit.allow_all).toBe(true);
    });

    test('admin token authorizes an admin method', async () => {
        V.assertResult(await rpc('admin.log.error', { service: 'user', limit: 1 }, token), 'admin.log.error');
    });

    test('wrong response is rejected', async () => {
        const req = V.assertResult(await rpc('admin.login.request', { username }), 'request#2');
        const bad = await rpc('admin.login.verify', { username, challenge: req.challenge, response: 'deadbeef'.repeat(8) });
        const err = V.assertRpcError(bad, undefined, 'bad admin response must fail');
        expect(err.code).not.toBe(-32601);
    });
});
