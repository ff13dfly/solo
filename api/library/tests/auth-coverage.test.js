/**
 * library/auth.js — branch-completeness 单测（补齐 handshake/middleware 主路径之外的每条分支）。
 *
 * 覆盖既有 auth-handshake / auth-middleware 未触及的：
 *   ① seed sweeper 回调：>60s 过期项被清、未到期项保留（line 51 双分支 + 定时器函数）
 *   ② 定时器句柄无 unref 时的防御守卫不抛（line 54 false 分支）
 *   ③ handleVerify 对非法 base58 签名/公钥 → 400 'Invalid Format'（catch 分支）
 *   ④ public 方法携带合法 Router token → 透传 user/permit/constraints/meta（best-effort 解析）
 *   ⑤ middleware verify 成功路径 → 注入身份并 next
 *   ⑥ /auth/* 路径直接放行（不解析 token）
 *   ⑦ parseRouterToken 抛错的状态码映射：-32000→400 / -32001→401 / 其它→403 + 默认 rpcError
 *   ⑧ req.body 缺失时 req.body?.id / ?.method 的可选链分支
 *   ⑨ config.serviceName 缺省 → logger 名为 'service'；options.publicMethods 自定义放行
 */
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { createAuthHandlers } = require('../auth');

// ── helpers ───────────────────────────────────────────────────────────────
function mockRes() {
    const r = { _status: null, _json: null };
    r.status = (c) => { r._status = c; return r; };
    r.json = (o) => { r._json = o; return r; };
    return r;
}

// Router key + a base58 public key string the service is configured to trust.
function makeRouterKey() {
    const kp = tweetnacl.sign.keyPair();
    return { kp, pk: bs58.encode(kp.publicKey) };
}

// Forge a valid X-Router-Token / X-Router-Signature pair (mirrors the Router).
function makeToken(payload, kp) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    return {
        'x-router-token': bs58.encode(payloadBytes),
        'x-router-signature': bs58.encode(tweetnacl.sign.detached(payloadBytes, kp.secretKey)),
    };
}

function signSeed(seed, kp) {
    const message = new TextEncoder().encode(seed);
    return {
        signature: bs58.encode(tweetnacl.sign.detached(message, kp.secretKey)),
        publicKey: bs58.encode(kp.publicKey),
    };
}

function runMw(middleware, req) {
    let nexted = false;
    const res = mockRes();
    middleware(req, res, () => { nexted = true; });
    return { nexted, res, req };
}

const { pk: ROUTER_PK, kp: ROUTER_KP } = makeRouterKey();
const freshPayload = (over = {}) => ({
    iss: 'router', iat: Date.now(), user: 'uid-abc',
    permit: 'admin', constraints: { dept: 'A' }, meta: { route: 'r' }, ...over,
});

// ── ① + ② seed sweeper 回调 ─────────────────────────────────────────────────
describe('auth seed sweeper', () => {
    test('清除 >60s 的待验 seed，保留未到期的（line 51 双分支），且无 unref 句柄不抛（line 54）', () => {
        let sweepFn;
        const origSetInterval = global.setInterval;
        const origNow = Date.now;
        // 捕获 sweeper 回调；返回的句柄故意不带 unref → 触发 line 54 false 分支
        global.setInterval = (fn) => { sweepFn = fn; return {}; };
        let now = 1_000_000;
        Date.now = () => now;
        try {
            const { handleSeed, handleVerify } = createAuthHandlers({ serviceName: 'sweep', routerPublicKey: ROUTER_PK });
            expect(typeof sweepFn).toBe('function');

            // t=0：发出 stale seed
            const r1 = mockRes(); handleSeed({}, r1); const stale = r1._json.seed;
            // t=+30s：发出 fresh seed
            now += 30_000;
            const r2 = mockRes(); handleSeed({}, r2); const fresh = r2._json.seed;
            // t=+70s（相对 stale）：stale 年龄 70s → 删；fresh 年龄 40s → 留
            now += 40_000;
            sweepFn();

            const kp = tweetnacl.sign.keyPair();
            // stale 已被清 → 验证失败 401
            const sres = mockRes();
            handleVerify({ body: signSeed(stale, kp) }, sres, 'sweep', '1.0.0', 1);
            expect(sres._status).toBe(401);
            // fresh 仍在 → 验证成功
            const fres = mockRes();
            handleVerify({ body: signSeed(fresh, kp) }, fres, 'sweep', '1.0.0', 1);
            expect(fres._json.success).toBe(true);
        } finally {
            global.setInterval = origSetInterval;
            Date.now = origNow;
        }
    });
});

// ── ③ handleVerify 非法格式 → 400 ───────────────────────────────────────────
describe('auth handleVerify — 非法签名/公钥格式', () => {
    const { handleVerify } = createAuthHandlers({ serviceName: 't', routerPublicKey: ROUTER_PK });

    test('signature 非 base58 → 400 Invalid Format（catch 分支，区别于 Missing params）', () => {
        const res = mockRes();
        handleVerify({ body: { signature: '0OIl-not-base58', publicKey: 'whatever' } }, res, 't', '1', 1);
        expect(res._status).toBe(400);
        expect(res._json).toEqual({ success: false, error: 'Invalid Format' });
    });

    test('publicKey 非法（长度错） → 400 Invalid Format', () => {
        const kp = tweetnacl.sign.keyPair();
        const res = mockRes();
        // 合法 base58 签名但公钥长度非法（≠32 字节）→ bs58.decode 护栏抛 → catch
        handleVerify({ body: { signature: bs58.encode(tweetnacl.sign.detached(new TextEncoder().encode('x'), kp.secretKey)), publicKey: bs58.encode(Buffer.from([1, 2, 3])) } }, res, 't', '1', 1);
        expect(res._status).toBe(400);
        expect(res._json.error).toBe('Invalid Format');
    });
});

// ── ④ public 方法 + 合法 token → 透传身份 ──────────────────────────────────
describe('auth middleware — public 方法 best-effort 身份解析', () => {
    const { middleware } = createAuthHandlers({ serviceName: 't', routerPublicKey: ROUTER_PK });

    test('ping 携带合法 token → 注入 user/permit/constraints/meta 并 next', () => {
        const headers = makeToken(freshPayload(), ROUTER_KP);
        const { nexted, req } = runMw(middleware, { path: '/jsonrpc', headers, body: { method: 'ping' }, ip: '203.0.113.7' });
        expect(nexted).toBe(true);
        expect(req.user).toBe('uid-abc');
        expect(req.permit).toBe('admin');
        expect(req.constraints).toEqual({ dept: 'A' });
        expect(req.meta).toEqual({ route: 'r' });
    });

    test('public 方法带损坏 token → 匿名放行（catch 分支，不注入身份）', () => {
        const { nexted, req } = runMw(middleware, {
            path: '/jsonrpc', headers: { 'x-router-token': '0OIl', 'x-router-signature': 'AAAA' },
            body: { method: 'ping' }, ip: '203.0.113.7',
        });
        expect(nexted).toBe(true);
        expect(req.user).toBeUndefined();
    });
});

// ── ⑤ + ⑥ verify 成功路径 + /auth/ 旁路 ────────────────────────────────────
describe('auth middleware — 受保护方法 verify 成功 / 握手路径旁路', () => {
    const { middleware } = createAuthHandlers({ serviceName: 't', routerPublicKey: ROUTER_PK });

    test('受保护方法 + 合法 token → 注入身份并 next', () => {
        const headers = makeToken(freshPayload({ permit: 'user', user: 'uid-x' }), ROUTER_KP);
        const { nexted, req } = runMw(middleware, { path: '/jsonrpc', headers, body: { method: 'x.y.z', id: 9 }, ip: '203.0.113.7' });
        expect(nexted).toBe(true);
        expect(req.user).toBe('uid-x');
        expect(req.permit).toBe('user');
        expect(req.constraints).toEqual({ dept: 'A' });
        expect(req.meta).toEqual({ route: 'r' });
    });

    test('/auth/* 路径无条件放行，不解析 token', () => {
        const { nexted, req } = runMw(middleware, { path: '/auth/seed', headers: {}, body: {}, ip: '203.0.113.7' });
        expect(nexted).toBe(true);
        expect(req.user).toBeUndefined();
    });
});

// ── ⑦ + ⑧ 错误 → 状态码映射 + 可选链分支 ──────────────────────────────────
describe('auth middleware — 错误状态码映射', () => {
    const { middleware } = createAuthHandlers({ serviceName: 't', routerPublicKey: ROUTER_PK });

    test('malformed token (-32000) → 400，error 透传 rpcError，id 取自 body', () => {
        const { nexted, res } = runMw(middleware, {
            path: '/jsonrpc', headers: { 'x-router-token': '0OIl', 'x-router-signature': 'AAAA' },
            body: { method: 'x.y.z', id: 42 }, ip: '203.0.113.7',
        });
        expect(nexted).toBe(false);
        expect(res._status).toBe(400);
        expect(res._json.error.code).toBe(-32000);
        expect(res._json.id).toBe(42);
    });

    test('missing headers (-32001) → 401，body 缺失 → id 为 undefined（?.id 分支）', () => {
        // 无 body：line 111 req.body 假分支 + line 146 req.body?.id 短路
        const { nexted, res } = runMw(middleware, { path: '/jsonrpc', headers: {}, ip: '203.0.113.7' });
        expect(nexted).toBe(false);
        expect(res._status).toBe(401);
        expect(res._json.id).toBeUndefined();
        expect(res._json.jsonrpc).toBe('2.0');
    });

    test('非标准错误码（无 code/无 rpcError）→ 403 + 默认 rpcError', () => {
        jest.isolateModules(() => {
            jest.doMock('../router-auth', () => ({
                parseRouterToken: () => { throw new Error('weird failure'); },
            }));
            const { createAuthHandlers: mk } = require('../auth');
            const { middleware: mw } = mk({ serviceName: 't', routerPublicKey: ROUTER_PK });
            const res = mockRes();
            mw({ path: '/jsonrpc', headers: {}, body: { method: 'x.y.z', id: 'abc' }, ip: '203.0.113.7' }, res, () => {});
            expect(res._status).toBe(403);
            expect(res._json.error).toEqual({ code: -32000, message: 'weird failure' });
            expect(res._json.id).toBe('abc');
        });
        jest.dontMock('../router-auth');
    });
});

// ── bs58 CJS/ESM interop 守卫（line 24: require('bs58').default || require('bs58'）) ─
describe('auth module-load — bs58 interop 双形态', () => {
    test('bs58 暴露 .default 时取 .default；不暴露时回退模块本身', () => {
        // 形态 A：有 .default → 取左
        jest.isolateModules(() => {
            jest.doMock('bs58', () => ({ default: { encode() {}, decode() {} }, encode() {}, decode() {} }));
            expect(() => require('../auth')).not.toThrow();
        });
        jest.dontMock('bs58');
        // 形态 B：无 .default → 短路取右（模块本身）
        jest.isolateModules(() => {
            jest.doMock('bs58', () => ({ encode() {}, decode() {} }));
            expect(() => require('../auth')).not.toThrow();
        });
        jest.dontMock('bs58');
    });
});

// ── ⑨ config / options 分支 ────────────────────────────────────────────────
describe('auth factory — config/options 分支', () => {
    const ORIG = process.env.AUTH_ALLOW_LOCAL_BYPASS;
    afterEach(() => {
        if (ORIG === undefined) delete process.env.AUTH_ALLOW_LOCAL_BYPASS;
        else process.env.AUTH_ALLOW_LOCAL_BYPASS = ORIG;
    });

    test('config.serviceName 缺省仍可构建（logger 名 -> "service"）', () => {
        const h = createAuthHandlers({ routerPublicKey: ROUTER_PK });
        expect(typeof h.middleware).toBe('function');
        // 触发一次成功放行，确认无 serviceName 也工作
        const headers = makeToken(freshPayload(), ROUTER_KP);
        const { nexted } = runMw(h.middleware, { path: '/jsonrpc', headers, body: { method: 'x.y.z' }, ip: '203.0.113.7' });
        expect(nexted).toBe(true);
    });

    test('options.publicMethods 自定义方法被当作 public 放行（无 token 匿名）', () => {
        const { middleware } = createAuthHandlers(
            { serviceName: 't', routerPublicKey: ROUTER_PK },
            { publicMethods: ['storage.asset.resolve'] },
        );
        const { nexted, req } = runMw(middleware, { path: '/jsonrpc', headers: {}, body: { method: 'storage.asset.resolve' }, ip: '203.0.113.7' });
        expect(nexted).toBe(true);
        expect(req.user).toBeUndefined();
    });

    test('本地旁路开启 + loopback + 无 body → 记 "unknown" 方法并放行（?.method 分支）', () => {
        process.env.AUTH_ALLOW_LOCAL_BYPASS = '1';
        const { middleware } = createAuthHandlers({ serviceName: 't', routerPublicKey: ROUTER_PK });
        // 无 body：line 111 req.body 假分支 + line 129 req.body?.method || 'unknown'
        const { nexted } = runMw(middleware, { path: '/jsonrpc', headers: {}, ip: '127.0.0.1' });
        expect(nexted).toBe(true);
    });
});
