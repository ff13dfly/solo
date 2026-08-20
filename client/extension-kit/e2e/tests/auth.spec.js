/**
 * 登录链路 —— 在真浏览器的 crypto.subtle 与 chrome.storage 上验一遍。
 *
 * 单元测试里 fetch 和 crypto 都是我给的；这里两者都是真的，验的是**派生出来的
 * challenge-response 真能上到线上**，以及 token 落在了正确的存储层。
 */
import { test, expect } from '../fixtures.js';
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function scriptLogin(router, { salt = 'SALT', challenge = 'CH', token = 'tok-1' } = {}) {
    router.reply((p) => {
        if (p.method === 'user.login.request') return { result: { challenge, salt } };
        if (p.method === 'user.login.verify') return { result: { token, uid: 'uid-1' } };
        return { result: { ok: true } };
    });
}

test('挑战响应：response = sha256(challenge + sha256(password + salt))', async ({ serviceWorker, router }) => {
    scriptLogin(router);
    const out = await serviceWorker.evaluate(() => globalThis.__solo.rpc.login('alice', 'pw', 'e2e-dev'));
    expect(out.uid).toBe('uid-1');

    const verify = router.calls.find((c) => c.method === 'user.login.verify');
    expect(verify.params.response).toBe(sha256('CH' + sha256('pw' + 'SALT')));
    expect(verify.params.deviceId).toBe('e2e-dev');
});

test('token 存进 session 区（未勾「记住密码」），并带上 Bearer', async ({ serviceWorker, router }) => {
    scriptLogin(router);
    await serviceWorker.evaluate(() => globalThis.__solo.rpc.login('alice', 'pw', 'e2e-dev'));

    const where = await serviceWorker.evaluate(async () => ({
        session: (await chrome.storage.session.get('token')).token,
        local: (await chrome.storage.local.get('token')).token,
    }));
    expect(where).toEqual({ session: 'tok-1', local: undefined });

    await serviceWorker.evaluate(() => globalThis.__solo.rpc.call('demo.thing.list', {}));
    expect(router.calls.at(-1).auth).toBe('Bearer tok-1');
});

test('勾了「记住密码」→ token 落 local，跨浏览器重启仍在', async ({ serviceWorker, router }) => {
    scriptLogin(router);
    await serviceWorker.evaluate(async () => {
        await globalThis.__solo.session.setRemember(true);
        await globalThis.__solo.rpc.login('alice', 'pw', 'e2e-dev');
    });
    const where = await serviceWorker.evaluate(async () => ({
        local: (await chrome.storage.local.get('token')).token,
        session: (await chrome.storage.session.get('token')).token,
    }));
    expect(where).toEqual({ local: 'tok-1', session: undefined });
});

test('会话失效 -32001 → 自动重登一次并重放原请求', async ({ serviceWorker, router }) => {
    // 先正常登录拿到 token
    scriptLogin(router);
    await serviceWorker.evaluate(async () => {
        await globalThis.__solo.session.setRemember(true);
        await globalThis.__solo.rpc.login('alice', 'pw', 'e2e-dev');
        await globalThis.__solo.session.setCredentials({ name: 'alice', password: 'pw' });
    });
    const before = router.calls.length;

    // 业务调用第一次撞 -32001，重登之后放行
    let denied = false;
    router.reply((p) => {
        if (p.method === 'user.login.request') return { result: { challenge: 'CH2', salt: 'SALT' } };
        if (p.method === 'user.login.verify') return { result: { token: 'tok-2', uid: 'uid-1' } };
        if (!denied) { denied = true; return { error: { code: -32001, message: 'session expired' } }; }
        return { result: { ok: 'after-reauth' } };
    });

    const out = await serviceWorker.evaluate(() => globalThis.__solo.rpc.call('demo.thing.list', {}));
    expect(out).toEqual({ ok: 'after-reauth' });

    const after = router.calls.slice(before).map((c) => c.method);
    expect(after).toEqual([
        'demo.thing.list',      // 撞 -32001
        'user.login.request',   // reauth
        'user.login.verify',
        'demo.thing.list',      // 重放
    ]);
    expect(router.calls.at(-1).auth).toBe('Bearer tok-2');   // 用的是新 token
});
