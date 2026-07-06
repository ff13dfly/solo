/**
 * checkAccess — 三阶段权限门测试
 *
 * Phase 0: 无 targetService → 直接通过（Router 内部方法）
 * Phase 1: checkPermission()  → RBAC/ACL
 * Phase 2: isPublicMethod()   → 静态白名单；discovery 方法在 DEBUG=false 时禁止
 * Phase 3: capMap[method].public → 动态 public flag
 */

const cap = require('../../handlers/capability');
const config = require('../../config');

// Phase 3 测试前写入，afterEach 清理，防止污染其他测试
afterEach(() => {
    Object.keys(cap.CAPABILITY_MAP).forEach(k => delete cap.CAPABILITY_MAP[k]);
});

// 恢复 config.debug 原始值
const originalDebug = config.debug;
afterAll(() => {
    config.debug = originalDebug;
});

// checkAccess 每次重新 require（保证 config 修改生效）
function getCheckAccess() {
    return require('../../handlers/access').checkAccess;
}

const adminUser    = { username: 'admin', permit: { allow_all: true } };
const guestUser    = { username: 'guest', permit: { allow_all: false, services: {} } };
const restrictedUser = {
    username: 'bob',
    permit: { allow_all: false, services: { erp: ['erp.stock.query'] } }
};

describe('checkAccess — Phase 0: Router-internal bypass', () => {

    test('allows when targetServiceName is null', () => {
        const result = getCheckAccess()(guestUser, null, 'any.method');
        expect(result.allowed).toBe(true);
    });

    test('allows when targetServiceName is undefined', () => {
        const result = getCheckAccess()(guestUser, undefined, 'any.method');
        expect(result.allowed).toBe(true);
    });

    test('allows when targetServiceName is empty string', () => {
        const result = getCheckAccess()(guestUser, '', 'any.method');
        expect(result.allowed).toBe(true);
    });
});

describe('checkAccess — Phase 1: RBAC', () => {

    test('admin user (allow_all) is always allowed', () => {
        const result = getCheckAccess()(adminUser, 'erp', 'erp.sale_order.create');
        expect(result.allowed).toBe(true);
    });

    test('user with exact method permit is allowed', () => {
        const result = getCheckAccess()(restrictedUser, 'erp', 'erp.stock.query');
        expect(result.allowed).toBe(true);
    });

    test('user without permit for method falls through to Phase 2', () => {
        // erp.stock.create is not in permit, not public, capMap empty → denied
        const result = getCheckAccess()(restrictedUser, 'erp', 'erp.stock.create');
        expect(result.allowed).toBe(false);
    });
});

describe('checkAccess — Phase 2: Static public whitelist', () => {

    test('ping is statically public and allowed for any user', () => {
        const result = getCheckAccess()(guestUser, 'some-service', 'ping');
        expect(result.allowed).toBe(true);
    });

    test('agent.chat is NOT public — guest is denied (narrowed; anon/guest go via a bot account)', () => {
        const result = getCheckAccess()(guestUser, 'agent', 'agent.chat');
        expect(result.allowed).toBe(false);
    });

    test('[discovery lockdown] system.service.list denied when DEBUG=false', () => {
        config.debug = false;
        const result = getCheckAccess()(guestUser, 'router', 'system.service.list');
        expect(result.allowed).toBe(false);
        expect(result.errorCode).toBe(-32604);
    });

    test('[discovery lockdown] system.capability.list denied when DEBUG=false', () => {
        config.debug = false;
        const result = getCheckAccess()(guestUser, 'router', 'system.capability.list');
        expect(result.allowed).toBe(false);
        expect(result.errorCode).toBe(-32604);
    });

    test('[discovery lockdown] methods denied when DEBUG=false', () => {
        config.debug = false;
        const result = getCheckAccess()(guestUser, 'router', 'methods');
        expect(result.allowed).toBe(false);
    });

    test('[discovery allowed] system.service.list allowed when DEBUG=true', () => {
        config.debug = true;
        const result = getCheckAccess()(guestUser, 'router', 'system.service.list');
        expect(result.allowed).toBe(true);
    });

    test('[discovery allowed] system.capability.list allowed when DEBUG=true', () => {
        config.debug = true;
        const result = getCheckAccess()(guestUser, 'router', 'system.capability.list');
        expect(result.allowed).toBe(true);
    });
});

describe('checkAccess — Phase 3: Dynamic capMap public flag', () => {

    test('allows when capMap marks method as public', () => {
        cap.CAPABILITY_MAP['erp.stock.query'] = { public: true, service: 'erp' };
        const result = getCheckAccess()(guestUser, 'erp', 'erp.stock.query');
        expect(result.allowed).toBe(true);
    });

    test('denies when capMap has method but public=false', () => {
        cap.CAPABILITY_MAP['erp.sale_order.create'] = { public: false, service: 'erp' };
        const result = getCheckAccess()(guestUser, 'erp', 'erp.sale_order.create');
        expect(result.allowed).toBe(false);
    });

    test('denies when method not in capMap at all', () => {
        // CAPABILITY_MAP is empty (cleaned up in afterEach)
        const result = getCheckAccess()(guestUser, 'erp', 'erp.nonexistent');
        expect(result.allowed).toBe(false);
    });
});

describe('checkAccess — Full denial (all phases fail)', () => {

    test('returns allowed=false with errorCode -32604', () => {
        config.debug = false;
        // No permit, not public, not in capMap
        const result = getCheckAccess()(guestUser, 'erp', 'erp.sale_order.create');
        expect(result.allowed).toBe(false);
        expect(result.errorCode).toBe(-32604);
    });

    test('reason field is set on denial', () => {
        config.debug = false;
        const result = getCheckAccess()(guestUser, 'erp', 'erp.sale_order.create');
        expect(result.reason).toBeDefined();
    });
});
