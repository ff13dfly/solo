/**
 * rpc —— 传输层。锁三件事：网络层失败被归一化成可重试的码、会话失效会走 reauth、
 * 永久错误立刻抛。背景见 lib/rpc.js 顶部。
 */
// ESM 下 jest 对象不进全局（describe/expect 会），必须显式导入。
import { jest } from '@jest/globals';
import { createRpc, createPasswordAuth, RpcError, UNAUTHENTICATED } from '../lib/rpc.js';

const okRes = (result) => ({ ok: true, json: async () => ({ result }) });
const errRes = (code, message = 'x') => ({ ok: true, json: async () => ({ error: { code, message } }) });

function harness({ responses, token = 't0', reauth }) {
    const calls = [];
    let cur = token;
    // 耗尽后重复最后一个响应：call() 会把 -32099 当瞬态再重试 5 轮，
    // 逐条摆响应根本摆不完，而"一直失败"才是要测的那个形态。
    let last;
    const fetchImpl = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
        const next = responses.length ? (last = responses.shift()) : last;
        if (typeof next === 'function') return next();
        return next;
    };
    const rpc = createRpc({
        getEndpoint: async () => 'http://router.test/jsonrpc',
        getToken: async () => cur,
        setToken: async (t) => { cur = t; },
        reauth,
        fetchImpl,
    });
    return { rpc, calls, getToken: () => cur };
}

describe('raw / call', () => {
    test('正常返回 result，带上 Bearer', async () => {
        const h = harness({ responses: [okRes({ hi: 1 })] });
        expect(await h.rpc.call('demo.ping', {})).toEqual({ hi: 1 });
        expect(h.calls[0].auth).toBe('Bearer t0');
        expect(h.calls[0].body).toMatchObject({ jsonrpc: '2.0', method: 'demo.ping' });
    });

    test('🔴 fetch 网络层失败没有 code —— 归一化成 -32099 并自重试', async () => {
        jest.useFakeTimers();
        const boom = () => { throw new TypeError('Failed to fetch'); };
        const h = harness({ responses: [boom, boom, okRes({ ok: true })] });
        const p = h.rpc.call('demo.ping', {});
        await jest.advanceTimersByTimeAsync(5000);
        expect(await p).toEqual({ ok: true });
        expect(h.calls.length).toBe(3);          // 初次 + NETWORK_RETRIES(2)
        jest.useRealTimers();
    });

    test('网络层重试用尽 → RpcError(-32099)，消息指向网络/代理而不是业务', async () => {
        jest.useFakeTimers();
        const boom = () => { throw new TypeError('Failed to fetch'); };
        const h = harness({ responses: [boom] });
        const p = h.rpc.call('demo.ping', {}).catch((e) => e);
        // 网络层 3 次 × 外层 6 轮，退避加起来约 37s 的假时间
        await jest.advanceTimersByTimeAsync(60_000);
        const e = await p;
        expect(e).toBeInstanceOf(RpcError);
        expect(e.code).toBe(-32099);
        expect(e.message).toMatch(/网络请求失败/);
        jest.useRealTimers();
    });

    test('HTTP 非 2xx 也归一化成 -32099（可重试），不是静默成功', async () => {
        jest.useFakeTimers();
        const h = harness({ responses: [{ ok: false, status: 502 }, okRes({ ok: 1 })] });
        const p = h.rpc.call('demo.ping', {});
        await jest.advanceTimersByTimeAsync(5000);
        expect(await p).toEqual({ ok: 1 });
        jest.useRealTimers();
    });

    test('永久错误立刻抛，不重试', async () => {
        const h = harness({ responses: [errRes(-32602, 'bad params')] });
        await expect(h.rpc.call('demo.ping', {})).rejects.toMatchObject({ code: -32602 });
        expect(h.calls.length).toBe(1);
    });

    test('瞬态错误（-32029 限流）退避重试', async () => {
        jest.useFakeTimers();
        const h = harness({ responses: [errRes(-32029), okRes({ ok: 1 })] });
        const p = h.rpc.call('demo.ping', {});
        await jest.advanceTimersByTimeAsync(5000);
        expect(await p).toEqual({ ok: 1 });
        expect(h.calls.length).toBe(2);
        jest.useRealTimers();
    });
});

describe('reauth —— 取代写死的「拿存着的密码再登一次」', () => {
    test('-32001 触发 reauth，然后重放原请求', async () => {
        let reauthed = 0;
        const h = harness({
            responses: [errRes(UNAUTHENTICATED), okRes({ ok: 1 })],
            reauth: async () => { reauthed++; },
        });
        expect(await h.rpc.call('demo.ping', {})).toEqual({ ok: 1 });
        expect(reauthed).toBe(1);
    });

    test('reauth 只试一次 —— 第二次 -32001 直接抛，不打死循环', async () => {
        let reauthed = 0;
        const h = harness({
            responses: [errRes(UNAUTHENTICATED), errRes(UNAUTHENTICATED)],
            reauth: async () => { reauthed++; },
        });
        await expect(h.rpc.call('demo.ping', {})).rejects.toMatchObject({ code: UNAUTHENTICATED });
        expect(reauthed).toBe(1);
    });

    test('没配 reauth 时 -32001 原样抛出（passport / 只读插件的合法形态）', async () => {
        const h = harness({ responses: [errRes(UNAUTHENTICATED)] });
        await expect(h.rpc.call('demo.ping', {})).rejects.toMatchObject({ code: UNAUTHENTICATED });
    });
});

describe('login + createPasswordAuth', () => {
    test('挑战响应：response = sha256(challenge + sha256(password + salt))', async () => {
        const h = harness({ responses: [
            okRes({ challenge: 'CH', salt: 'SA' }),
            okRes({ token: 'newtok', uid: 'u1' }),
        ] });
        const out = await h.rpc.login('alice', 'pw', 'dev-1');
        expect(out.token).toBe('newtok');
        expect(h.getToken()).toBe('newtok');

        const inner = await h.rpc.sha256('pw' + 'SA');
        expect(h.calls[1].body.params).toMatchObject({
            name: 'alice', challenge: 'CH', deviceId: 'dev-1',
            response: await h.rpc.sha256('CH' + inner),
        });
    });

    test('login.request 不回 salt → 明确报错，而不是拿 undefined 派生出一个必然错的 hash', async () => {
        const h = harness({ responses: [okRes({ challenge: 'CH' })] });
        await expect(h.rpc.login('alice', 'pw', 'd')).rejects.toThrow(/salt/);
    });

    test('认证类失败清凭据；网络类失败保留（一次断网不该抹掉「记住密码」）', async () => {
        let cred = { name: 'a', password: 'p' };
        const mkAuth = (loginErr) => createPasswordAuth({
            rpc: { login: async () => { throw loginErr; } },
            getCredentials: async () => cred,
            clearCredentials: async () => { cred = null; },
            deviceId: 'd',
        });

        await expect(mkAuth(new RpcError(-32099, 'net'))()).rejects.toMatchObject({ code: -32099 });
        expect(cred).not.toBeNull();                       // 网络类：留着

        await expect(mkAuth(new RpcError(UNAUTHENTICATED, 'bad pw'))()).rejects.toThrow(/已失效并清除/);
        expect(cred).toBeNull();                           // 认证类：清掉
    });

    test('没有凭据时给出可执行的提示，而不是通用失败', async () => {
        const reauth = createPasswordAuth({ rpc: {}, getCredentials: async () => null, deviceId: 'd' });
        await expect(reauth()).rejects.toThrow(/请在插件弹窗重新登录/);
    });
});
