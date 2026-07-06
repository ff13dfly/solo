/**
 * library/auth.js — Level 3 鉴权中间件:本地旁路加固单测.
 *
 * 守护两点(防回归):
 *   ① 旁路默认关闭,只在 AUTH_ALLOW_LOCAL_BYPASS=1 时放行(不再耦合 config.debug / NODE_ENV)
 *   ② 只信真实 loopback socket IP,不信可伪造的 Host 头(req.hostname)
 */
const { createAuthHandlers } = require('../auth');

const ROUTER_PK = '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji';

function mockRes() {
    const r = { _status: null, _json: null };
    r.status = (c) => { r._status = c; return r; };
    r.json = (o) => { r._json = o; return r; };
    return r;
}

// 跑一次中间件,返回是否放行(next 被调)+ res.
function run(middleware, reqOverrides) {
    let nexted = false;
    const res = mockRes();
    const req = { path: '/jsonrpc', headers: {}, body: { method: 'x.y.z' }, ...reqOverrides };
    middleware(req, res, () => { nexted = true; });
    return { nexted, res };
}

describe('auth middleware — local-auth-bypass hardening', () => {
    const ORIG = process.env.AUTH_ALLOW_LOCAL_BYPASS;
    const off = () => { delete process.env.AUTH_ALLOW_LOCAL_BYPASS; };
    const on = () => { process.env.AUTH_ALLOW_LOCAL_BYPASS = '1'; };
    afterEach(() => { if (ORIG === undefined) delete process.env.AUTH_ALLOW_LOCAL_BYPASS; else process.env.AUTH_ALLOW_LOCAL_BYPASS = ORIG; });

    const { middleware } = createAuthHandlers({ serviceName: 'test', routerPublicKey: ROUTER_PK });

    test('loopback + 无 token + 旁路关 → 拒绝(不 next)', () => {
        off();
        const { nexted, res } = run(middleware, { ip: '127.0.0.1' });
        expect(nexted).toBe(false);
        expect([400, 401, 403]).toContain(res._status);
    });

    test('伪造 Host: localhost(非 loopback IP)+ 旁路开 → 仍拒绝(不信 Host 头)', () => {
        on();
        const { nexted } = run(middleware, { ip: '203.0.113.7', hostname: 'localhost' });
        expect(nexted).toBe(false);
    });

    test('config.debug=true 不再开启旁路 → loopback + 无 token 仍拒绝', () => {
        off();
        const dbg = createAuthHandlers({ serviceName: 'test', routerPublicKey: ROUTER_PK, debug: true }).middleware;
        const { nexted } = run(dbg, { ip: '127.0.0.1' });
        expect(nexted).toBe(false);
    });

    test('NODE_ENV=test 不再开启旁路 → loopback + 无 token 仍拒绝', () => {
        off();
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        try {
            const { nexted } = run(middleware, { ip: '127.0.0.1' });
            expect(nexted).toBe(false);
        } finally { process.env.NODE_ENV = prev; }
    });

    test('AUTH_ALLOW_LOCAL_BYPASS=1 + loopback → 放行(显式 opt-in)', () => {
        on();
        expect(run(middleware, { ip: '127.0.0.1' }).nexted).toBe(true);
        expect(run(middleware, { ip: '::1' }).nexted).toBe(true);
        expect(run(middleware, { ip: '::ffff:127.0.0.1' }).nexted).toBe(true);
    });

    test('public 方法(ping)始终放行,与旁路无关', () => {
        off();
        expect(run(middleware, { ip: '203.0.113.7', body: { method: 'ping' } }).nexted).toBe(true);
    });
});
