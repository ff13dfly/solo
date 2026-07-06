const authHandlers = require('../handlers/auth');

// --- Mock Infrastructure ---
class MockRedisClient {
    constructor() {
        this.data = new Map();
        this.isOpen = true;
        this.expireCalls = [];
    }
    async get(key) { return this.data.get(key) || null; }
    async set(key, val) { this.data.set(key, val); }
    async expire(key, ttl) { this.expireCalls.push({ key, ttl }); }
}

describe('Auth Handler', () => {

    // ─────────────────────────────────────────────────────────────────────────
    describe('extractToken', () => {
        test('extracts from Authorization Bearer header', () => {
            const req = { headers: { 'authorization': 'Bearer token123' } };
            expect(authHandlers.extractToken(req)).toBe('token123');
        });

        test('extracts from x-admin-token header', () => {
            const req = { headers: { 'x-admin-token': 'adminSecret' } };
            expect(authHandlers.extractToken(req)).toBe('adminSecret');
        });

        test('returns null if no token found', () => {
            const req = { headers: {} };
            expect(authHandlers.extractToken(req)).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('isAdmin', () => {
        test('returns true when allow_all is true', () => {
            expect(authHandlers.isAdmin({ permit: { allow_all: true } })).toBe(true);
        });

        test('returns false when allow_all is false', () => {
            expect(authHandlers.isAdmin({ permit: { allow_all: false } })).toBe(false);
        });

        test('returns false when permit is missing', () => {
            expect(authHandlers.isAdmin({})).toBe(false);
        });

        test('returns false when sessionUser is null', () => {
            expect(authHandlers.isAdmin(null)).toBe(false);
        });
    });

    describe('isLoopbackRequest', () => {
        test('true for IPv4 / IPv6 loopback ip and localhost hostname', () => {
            expect(authHandlers.isLoopbackRequest({ ip: '127.0.0.1' })).toBe(true);
            expect(authHandlers.isLoopbackRequest({ ip: '::1' })).toBe(true);
            expect(authHandlers.isLoopbackRequest({ hostname: 'localhost' })).toBe(true);
        });

        test('false for a remote ip / hostname', () => {
            expect(authHandlers.isLoopbackRequest({ ip: '10.0.0.5', hostname: 'router' })).toBe(false);
            expect(authHandlers.isLoopbackRequest({ ip: '203.0.113.7' })).toBe(false);
        });

        test('false for a nullish request', () => {
            expect(authHandlers.isLoopbackRequest(undefined)).toBe(false);
            expect(authHandlers.isLoopbackRequest({})).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('checkPermission', () => {
        const permit = {
            allow_all: false,
            services: {
                'crm': ['crm.create', 'crm.read'],
                'finance': ['*']
            }
        };

        test('allow_all bypasses all checks', () => {
            expect(authHandlers.checkPermission({ allow_all: true }, 'any', 'any.method')).toBe(true);
        });

        test('null permit is denied', () => {
            expect(authHandlers.checkPermission(null, 'crm', 'crm.read')).toBe(false);
        });

        test('undefined permit is denied', () => {
            expect(authHandlers.checkPermission(undefined, 'crm', 'crm.read')).toBe(false);
        });

        test('empty services object is denied', () => {
            expect(authHandlers.checkPermission({ allow_all: false, services: {} }, 'crm', 'crm.read')).toBe(false);
        });

        test('service not in permit is denied', () => {
            expect(authHandlers.checkPermission(permit, 'hr', 'hr.read')).toBe(false);
        });

        test('wildcard grants access to any method on that service', () => {
            expect(authHandlers.checkPermission(permit, 'finance', 'finance.transfer')).toBe(true);
        });

        test('exact method match is allowed', () => {
            expect(authHandlers.checkPermission(permit, 'crm', 'crm.read')).toBe(true);
        });

        test('unlisted method on known service is denied', () => {
            expect(authHandlers.checkPermission(permit, 'crm', 'crm.delete')).toBe(false);
        });

        test('second method in list is allowed', () => {
            expect(authHandlers.checkPermission(permit, 'crm', 'crm.create')).toBe(true);
        });

        test('cross-service access with multi-service permit is denied', () => {
            const multiPermit = { services: { erp: ['*'], commodity: ['*'] } };
            expect(authHandlers.checkPermission(multiPermit, 'authority', 'user.create')).toBe(false);
        });

        test('empty method list on service is denied', () => {
            expect(authHandlers.checkPermission({ services: { erp: [] } }, 'erp', 'erp.stock.query')).toBe(false);
        });

        test('missing services field is denied', () => {
            expect(authHandlers.checkPermission({ allow_all: false }, 'crm', 'crm.read')).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('resolveSessionUser', () => {
        let mockRedis;

        beforeEach(() => {
            mockRedis = new MockRedisClient();
        });

        test('returns guest when no token provided', async () => {
            const user = await authHandlers.resolveSessionUser(null, mockRedis);
            expect(user.username).toBe('guest');
            expect(user.permit.allow_all).toBe(false);
        });

        test('returns guest when redis is null', async () => {
            const user = await authHandlers.resolveSessionUser('sometoken', null);
            expect(user.username).toBe('guest');
        });

        test('returns guest when redis is closed', async () => {
            mockRedis.isOpen = false;
            const user = await authHandlers.resolveSessionUser('sometoken', mockRedis);
            expect(user.username).toBe('guest');
        });

        test('returns guest when token not found in redis', async () => {
            const user = await authHandlers.resolveSessionUser('missing-token', mockRedis);
            expect(user.username).toBe('guest');
        });

        test('returns guest and does not throw on corrupted session JSON', async () => {
            await mockRedis.set('session:badtoken', '{{broken json}}');
            const user = await authHandlers.resolveSessionUser('badtoken', mockRedis);
            expect(user.username).toBe('guest');
        });

        test('returns session user when session found in redis (no uid)', async () => {
            const session = { username: 'alice', permit: { allow_all: false, services: { erp: ['*'] } } };
            await mockRedis.set('session:validToken', JSON.stringify(session));
            const user = await authHandlers.resolveSessionUser('validToken', mockRedis);
            expect(user.username).toBe('alice');
            expect(user.permit.services.erp).toContain('*');
        });

        // ── constraints 反序列化（Redis JSON → sessionUser.permit.constraints）─
        test('[constraints] survives JSON round-trip via session path', async () => {
            const constraints = { maxAmount: 5000, region: 'cn', allowedWarehouses: ['WH01', 'WH02'] };
            const session = { username: 'dave', permit: { allow_all: false, services: { erp: ['*'] }, constraints } };
            await mockRedis.set('session:consTok', JSON.stringify(session));
            const user = await authHandlers.resolveSessionUser('consTok', mockRedis);
            expect(user.permit.constraints).toEqual(constraints);
        });

        test('[constraints] absent in session defaults to missing (not injected)', async () => {
            const session = { username: 'eve', permit: { allow_all: false, services: {} } };
            await mockRedis.set('session:noConsTok', JSON.stringify(session));
            const user = await authHandlers.resolveSessionUser('noConsTok', mockRedis);
            // constraints 不存在时不应被注入为 {}，保持原样
            expect(user.permit.constraints).toBeUndefined();
        });

        // ── Scheme F hot-refresh for BOTS (user:bot:{uid}) ──────────────────
        // Humans live at user:{uid} and were always hot-refreshed; bots kept their
        // issuance-time permit snapshot until token TTL. Now the bot key is
        // consulted too — permit edits and suspension bite live sessions.

        test('[Scheme F bot] bot session hot-refreshes its permit from user:bot:{uid}', async () => {
            const stale = { uid: 'system.worker', username: 'system.worker', permit: { allow_all: false, services: { collection: ['*'] } } };
            await mockRedis.set('session:botToken', JSON.stringify(stale));
            await mockRedis.set('user:bot:system.worker', JSON.stringify({
                id: 'system.worker', type: 'bot', status: 'ACTIVE',
                permit: { allow_all: false, services: { notification: ['notification.send'] } },
            }));

            const user = await authHandlers.resolveSessionUser('botToken', mockRedis);
            // live session sees the CURRENT permit, not the issuance snapshot
            expect(user.permit.services.notification).toContain('notification.send');
            expect(user.permit.services.collection).toBeUndefined();
        });

        test('[Scheme F bot] suspended bot resolves to guest even with a live session token', async () => {
            const session = { uid: 'system.paused', username: 'system.paused', permit: { allow_all: false, services: { collection: ['*'] } } };
            await mockRedis.set('session:pausedToken', JSON.stringify(session));
            await mockRedis.set('user:bot:system.paused', JSON.stringify({
                id: 'system.paused', type: 'bot', status: 'SUSPENDED',
                permit: { allow_all: false, services: { collection: ['*'] } },
            }));

            const user = await authHandlers.resolveSessionUser('pausedToken', mockRedis);
            expect(user.username).toBe('guest');
            expect(user.permit.allow_all).toBe(false);
        });

        test('[Scheme F bot] bot with no bot record keeps its session permit (no false rejection)', async () => {
            const session = { uid: 'system.legacy', username: 'system.legacy', permit: { allow_all: false, services: { planner: ['*'] } } };
            await mockRedis.set('session:legacyToken', JSON.stringify(session));

            const user = await authHandlers.resolveSessionUser('legacyToken', mockRedis);
            expect(user.permit.services.planner).toContain('*');
        });

        // ── Scheme F: Dynamic Permission Loading ───────────────────────────
        test('[Scheme F] loads fresh permit from user record when uid present', async () => {
            const oldPermit = { allow_all: false, services: { erp: ['erp.stock.query'] } };
            const newPermit = { allow_all: false, services: { erp: ['*'] } };
            await mockRedis.set('session:tok', JSON.stringify({ uid: '42', username: 'bob', permit: oldPermit }));
            await mockRedis.set('user:42', JSON.stringify({ permit: newPermit }));
            const user = await authHandlers.resolveSessionUser('tok', mockRedis);
            expect(user.permit.services.erp).toContain('*');
        });

        test('[Scheme F] constraints in user record override session constraints', async () => {
            const sessionConstraints = { maxAmount: 1000 };
            const userConstraints = { maxAmount: 9999, region: 'global' };
            await mockRedis.set('session:schFConsTok', JSON.stringify({
                uid: 'cf1', username: 'frank',
                permit: { allow_all: false, services: {}, constraints: sessionConstraints }
            }));
            await mockRedis.set('user:cf1', JSON.stringify({
                permit: { allow_all: false, services: {}, constraints: userConstraints }
            }));
            const user = await authHandlers.resolveSessionUser('schFConsTok', mockRedis);
            // Scheme F 整体替换 permit，user record 的 constraints 优先
            expect(user.permit.constraints).toEqual(userConstraints);
        });

        test('[Scheme F] falls back to session permit when user record missing', async () => {
            const sessionPermit = { allow_all: false, services: { erp: ['erp.stock.query'] } };
            await mockRedis.set('session:tok2', JSON.stringify({ uid: '99', username: 'bob', permit: sessionPermit }));
            // user:99 not set
            const user = await authHandlers.resolveSessionUser('tok2', mockRedis);
            expect(user.permit.services.erp).not.toContain('*');
            expect(user.permit.services.erp).toContain('erp.stock.query');
        });

        test('[Scheme F] falls back to session permit when user record JSON is corrupted', async () => {
            const sessionPermit = { allow_all: false, services: { erp: ['erp.stock.query'] } };
            await mockRedis.set('session:tok3', JSON.stringify({ uid: '77', username: 'carol', permit: sessionPermit }));
            await mockRedis.set('user:77', '{{broken}}');
            const user = await authHandlers.resolveSessionUser('tok3', mockRedis);
            expect(user.username).toBe('carol');
            expect(user.permit.services.erp).toContain('erp.stock.query');
        });

        // ── Session TTL (Sliding Expiration) ───────────────────────────────
        test('admin role triggers session TTL renewal', async () => {
            await mockRedis.set('session:adminTok', JSON.stringify({ username: 'admin', role: 'admin' }));
            await authHandlers.resolveSessionUser('adminTok', mockRedis);
            expect(mockRedis.expireCalls.length).toBeGreaterThan(0);
        });

        test('operator role triggers session TTL renewal', async () => {
            await mockRedis.set('session:opTok', JSON.stringify({ username: 'op', role: 'operator' }));
            await authHandlers.resolveSessionUser('opTok', mockRedis);
            expect(mockRedis.expireCalls.length).toBeGreaterThan(0);
        });

        test('regular user role does NOT trigger TTL renewal', async () => {
            const session = { username: 'user1', role: 'user', permit: { allow_all: false, services: {} } };
            await mockRedis.set('session:userTok', JSON.stringify(session));
            await authHandlers.resolveSessionUser('userTok', mockRedis);
            expect(mockRedis.expireCalls.length).toBe(0);
        });

        // ── Permit Normalization ───────────────────────────────────────────
        test('normalizes string permit "admin" to allow_all object', async () => {
            await mockRedis.set('session:strAdm', JSON.stringify({ username: 'a', permit: 'admin' }));
            const user = await authHandlers.resolveSessionUser('strAdm', mockRedis);
            expect(user.permit.allow_all).toBe(true);
        });

        test('normalizes missing permit + admin role to allow_all true', async () => {
            await mockRedis.set('session:noPermAdm', JSON.stringify({ username: 'a', role: 'admin' }));
            const user = await authHandlers.resolveSessionUser('noPermAdm', mockRedis);
            expect(user.permit.allow_all).toBe(true);
        });

        test('normalizes missing permit + user role to allow_all false', async () => {
            await mockRedis.set('session:noPermUsr', JSON.stringify({ username: 'u', role: 'user' }));
            const user = await authHandlers.resolveSessionUser('noPermUsr', mockRedis);
            expect(user.permit.allow_all).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('resolveTargetService', () => {
        const SERVICES = {
            'crm': { methods: [{ name: 'crm.create', params: [] }] },
            'user': { methods: [{ name: 'user.login', params: [] }] }
        };

        test('finds service by method name', () => {
            const result = authHandlers.resolveTargetService('crm.create', SERVICES);
            expect(result).not.toBeNull();
            expect(result.serviceName).toBe('crm');
        });

        test('returns null if method not registered in any service', () => {
            const result = authHandlers.resolveTargetService('unknown.method', SERVICES);
            expect(result).toBeNull();
        });
    });

});
