/**
 * E2E 权限系统集成测试
 *
 * 前提：Router 运行在 localhost:8600，Redis 可用
 * 运行：npx jest tests/security/e2e-permission.test.js --no-coverage
 *
 * 覆盖场景：
 * 1. 匿名访问（public vs private）
 * 2. admin token 全通
 * 3. 受限用户精确 RBAC
 * 4. Scheme F 实时权限感知
 * 5. OOM 参数保护
 */

const http = require('http');
const { createClient } = require('redis');

const ROUTER_URL = 'http://localhost:8600';
const ADMIN_TOKEN = 'e2e-admin-token';
const USER_TOKEN = 'e2e-user-token';
const USER_UID = 'test-2';

// ─── helpers ────────────────────────────────────────────────────────────────

function rpc(method, params = {}, token = null) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(ROUTER_URL, { method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Invalid JSON: ${data}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── setup & teardown ────────────────────────────────────────────────────────

let redis;

beforeAll(async () => {
    redis = createClient({ url: 'redis://localhost:6699' });
    await redis.connect();

    // 确保测试 session 存在
    await redis.set('session:' + ADMIN_TOKEN,
        JSON.stringify({ uid: 'test-1', username: 'e2e-admin', role: 'admin', permit: { allow_all: true } }),
        { EX: 600 }
    );
    await redis.set('session:' + USER_TOKEN,
        JSON.stringify({ uid: USER_UID, username: 'e2e-user', role: 'user', permit: { allow_all: false, services: { erp: ['erp.stock.query', 'erp.warehouse.query'] } } }),
        { EX: 600 }
    );
    await redis.set('user:' + USER_UID,
        JSON.stringify({ permit: { allow_all: false, services: { erp: ['erp.stock.query', 'erp.warehouse.query'] } } }),
        { EX: 600 }
    );
});

afterAll(async () => {
    await redis.del('session:' + ADMIN_TOKEN);
    await redis.del('session:' + USER_TOKEN);
    await redis.del('user:' + USER_UID);
    await redis.quit();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2E — 1. Router 基础', () => {

    test('ping 无需 token，正常响应', async () => {
        const res = await rpc('ping');
        expect(res.result.status).toBe('ok');
        expect(res.error).toBeUndefined();
    });

    test('格式错误的请求返回 INVALID_REQUEST', async () => {
        const res = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ method: 'ping' }); // 缺少 jsonrpc 字段
            const req = http.request(ROUTER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (r) => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => resolve(JSON.parse(d)));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        expect(res.error).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2E — 2. 匿名访问', () => {

    test('未知方法返回 METHOD_NOT_FOUND', async () => {
        const res = await rpc('nonexistent.method');
        expect(res.error).toBeDefined();
        expect(res.error.code).toBe(-32601);
    });

    test('无 token 访问私有方法返回 FORBIDDEN (-32604 或 METHOD_NOT_FOUND)', async () => {
        // erp 服务若已注册：-32604；未注册：-32601
        const res = await rpc('erp.sale_order.create', { payload: {} });
        expect(res.error).toBeDefined();
        expect([-32604, -32601]).toContain(res.error.code);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2E — 3. Admin Token 全通', () => {

    test('admin token 访问 system.service.list 成功', async () => {
        const res = await rpc('system.service.list', {}, ADMIN_TOKEN);
        expect(res.error).toBeUndefined();
        expect(Array.isArray(res.result)).toBe(true);
    });

    test('admin token 访问 system.capability.list 成功', async () => {
        const res = await rpc('system.capability.list', {}, ADMIN_TOKEN);
        expect(res.error).toBeUndefined();
    });

    test('admin 访问受限的 admin.log.debug 不返回 FORBIDDEN', async () => {
        const res = await rpc('admin.log.debug', {}, ADMIN_TOKEN);
        // 可能返回 result 或其他错误，但不应该是 FORBIDDEN
        expect(res.error?.code).not.toBe(-32604);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2E — 4. 受限用户 RBAC', () => {

    test('普通用户访问 system.service.list 不被 FORBIDDEN（本地方法绕过 checkAccess）', async () => {
        const res = await rpc('system.service.list', {}, USER_TOKEN);
        // system.service.list 在本地 METHODS 表中处理，不经过 checkAccess
        expect(res.error?.code).not.toBe(-32604);
    });

    test('普通用户访问 admin.log.debug 返回 FORBIDDEN 或非法访问拒绝', async () => {
        const res = await rpc('admin.log.debug', {}, USER_TOKEN);
        // admin.log.debug 在本地 METHODS 表中有 isAdmin 内联检查
        expect(res.error).toBeDefined();
    });

    test('无效 token 等同于匿名（Redis miss → guest）', async () => {
        const res = await rpc('erp.sale_order.create', { payload: {} }, 'not-a-real-token');
        expect(res.error).toBeDefined();
        expect([-32604, -32601]).toContain(res.error.code);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2E — 5. Scheme F 实时权限感知', () => {

    test('修改 Redis user permit 后，旧 token 立即感知新权限', async () => {
        // 初始状态：user 只有 erp.stock.query 权限
        // 步骤 1：升级为 allow_all（模拟管理员改权限）
        await redis.set('user:' + USER_UID,
            JSON.stringify({ permit: { allow_all: true } }),
            { EX: 600 }
        );

        // 步骤 2：用原 token 访问 admin.log.debug（原来被拒绝）
        const res = await rpc('admin.log.debug', {}, USER_TOKEN);

        // 步骤 3：恢复原始权限
        await redis.set('user:' + USER_UID,
            JSON.stringify({ permit: { allow_all: false, services: { erp: ['erp.stock.query', 'erp.warehouse.query'] } } }),
            { EX: 600 }
        );

        // admin.log.debug 的内联 isAdmin 检查用的是 resolveSessionUser 返回的 permit
        // Scheme F 生效时，用 user:test-2 的 allow_all:true，isAdmin = true，不返回 FORBIDDEN
        expect(res.error?.code).not.toBe(-32604);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2E — 6. OOM 参数保护', () => {

    test('超大字符串参数被拒绝（validateGlobalConstraints）', async () => {
        const res = await rpc('ping', { data: 'x'.repeat(102401) });
        expect(res.error).toBeDefined();
        expect(res.error.code).toBe(-32602);
    });

    test('超大数组参数被拒绝', async () => {
        const res = await rpc('ping', { ids: new Array(1001).fill(0) });
        expect(res.error).toBeDefined();
        expect(res.error.code).toBe(-32602);
    });
});
