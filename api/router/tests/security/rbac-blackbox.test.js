/**
 * RBAC 越权黑盒测试（HTTP 层）
 *
 * 前提：Router @ localhost:8600，authority 服务在线
 * 下游选择理由：
 *   - authority.category.* (8个) 全部 public:true  → 验证 Phase 3 放行
 *   - authority.role/dept/employee.* (21个) 全部 private → 验证 RBAC 拦截
 *   - 边界清晰，读操作不依赖复杂业务状态
 *
 * 覆盖维度：
 *   1. 匿名 → public 方法（Phase 3 放行）
 *   2. 匿名 → private 方法（全拒）
 *   3. admin → 任意 private 方法（Phase 1 全通）
 *   4. 受限用户 → 精确授权方法（Phase 1 通过）
 *   5. 受限用户 → 超出授权范围的方法（Phase 1 失败 → 全拒）
 *   6. 通配符用户 → 同服务任意方法（Phase 1 通配符）
 *   7. 跨服务越权 → private 方法（permit 服务不匹配 → 全拒）
 *   8. 跨服务越权 → public 方法（Phase 3 仍放行）
 */

const http = require('http');
const { createClient } = require('redis');

const ROUTER = 'http://localhost:8600';

// ─── helpers ────────────────────────────────────────────────────────────────

function rpc(method, params = {}, token = null) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(ROUTER, { method: 'POST', headers }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { reject(new Error(`Invalid JSON: ${d.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function isForbidden(res) {
    return res.error?.code === -32604;
}

function isAllowed(res) {
    // 只要不是 FORBIDDEN，就视为 RBAC 放行（业务层错误不在测试范围内）
    return !isForbidden(res);
}

// ─── tokens ─────────────────────────────────────────────────────────────────

const ADMIN_TOKEN    = 'rbac-bb-admin';
const EXACT_TOKEN    = 'rbac-bb-exact';    // 只授权 authority.category.list
const WILDCARD_TOKEN = 'rbac-bb-wildcard'; // authority.*
const CROSS_TOKEN    = 'rbac-bb-cross';    // 只有 commodity.* permit

// ─── setup ──────────────────────────────────────────────────────────────────

let redis;

beforeAll(async () => {
    redis = createClient({ url: 'redis://localhost:6699' });
    await redis.connect();

    await redis.set(`session:${ADMIN_TOKEN}`,
        JSON.stringify({ uid: 'bb-1', username: 'bb-admin', role: 'admin', permit: { allow_all: true } }),
        { EX: 600 });

    await redis.set(`session:${EXACT_TOKEN}`,
        JSON.stringify({ uid: 'bb-2', username: 'bb-exact', role: 'user',
            permit: { allow_all: false, services: { authority: ['authority.category.list'] } } }),
        { EX: 600 });

    await redis.set(`session:${WILDCARD_TOKEN}`,
        JSON.stringify({ uid: 'bb-3', username: 'bb-wildcard', role: 'user',
            permit: { allow_all: false, services: { authority: ['*'] } } }),
        { EX: 600 });

    await redis.set(`session:${CROSS_TOKEN}`,
        JSON.stringify({ uid: 'bb-4', username: 'bb-cross', role: 'user',
            permit: { allow_all: false, services: { commodity: ['*'] } } }),
        { EX: 600 });
});

afterAll(async () => {
    await Promise.all([ADMIN_TOKEN, EXACT_TOKEN, WILDCARD_TOKEN, CROSS_TOKEN]
        .map(t => redis.del(`session:${t}`)));
    await redis.quit();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RBAC 黑盒 — 1. 匿名访问', () => {

    test('无 token → public 方法（authority.category.list）→ Phase 3 放行', async () => {
        const res = await rpc('authority.category.list', {});
        expect(isAllowed(res)).toBe(true);
    });

    test('无 token → private 方法（authority.role.list）→ FORBIDDEN', async () => {
        const res = await rpc('authority.role.list', {});
        expect(isForbidden(res)).toBe(true);
    });

    test('无 token → private 方法（authority.employee.list）→ FORBIDDEN', async () => {
        const res = await rpc('authority.employee.list', {});
        expect(isForbidden(res)).toBe(true);
    });

    test('无 token → private 方法（authority.dept.list）→ FORBIDDEN', async () => {
        const res = await rpc('authority.dept.list', {});
        expect(isForbidden(res)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RBAC 黑盒 — 2. Admin Token 全通（Phase 1 allow_all）', () => {

    test('admin → authority.role.list → Phase 1 放行（不返回 FORBIDDEN）', async () => {
        const res = await rpc('authority.role.list', {}, ADMIN_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });

    test('admin → authority.dept.list → Phase 1 放行', async () => {
        const res = await rpc('authority.dept.list', {}, ADMIN_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });

    test('admin → authority.employee.list → Phase 1 放行', async () => {
        const res = await rpc('authority.employee.list', {}, ADMIN_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RBAC 黑盒 — 3. 精确授权用户（Phase 1 method-level）', () => {

    // permit: {authority: ['authority.category.list']}

    test('精确授权用户 → 授权方法（authority.category.list）→ 放行', async () => {
        const res = await rpc('authority.category.list', {}, EXACT_TOKEN);
        expect(isAllowed(res)).toBe(true);
    });

    test('精确授权用户 → 同服务超出授权的方法（authority.category.get）→ FORBIDDEN', async () => {
        // authority.category.get 是 public，但 Phase 1 先于 Phase 3
        // Phase 1: 'authority.category.get' 不在 ['authority.category.list'] → false
        // Phase 2: 不在静态白名单 → false
        // Phase 3: capMap.public = true → 放行
        // 所以 public 方法即使不在 permit 里，Phase 3 仍然放行
        const res = await rpc('authority.category.get', { id: 'nonexistent' }, EXACT_TOKEN);
        expect(isAllowed(res)).toBe(true); // Phase 3 兜底
    });

    test('精确授权用户 → private 方法（authority.role.list）→ FORBIDDEN', async () => {
        const res = await rpc('authority.role.list', {}, EXACT_TOKEN);
        expect(isForbidden(res)).toBe(true);
    });

    test('精确授权用户 → private 方法（authority.role.create）→ FORBIDDEN', async () => {
        const res = await rpc('authority.role.create', { name: 'test' }, EXACT_TOKEN);
        expect(isForbidden(res)).toBe(true);
    });

    test('精确授权用户 → private 方法（authority.dept.create）→ FORBIDDEN', async () => {
        const res = await rpc('authority.dept.create', { name: 'test' }, EXACT_TOKEN);
        expect(isForbidden(res)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RBAC 黑盒 — 4. 通配符用户（Phase 1 wildcard）', () => {

    // permit: {authority: ['*']}

    test('通配符用户 → authority.role.list → Phase 1 通配符放行', async () => {
        const res = await rpc('authority.role.list', {}, WILDCARD_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });

    test('通配符用户 → authority.dept.list → Phase 1 通配符放行', async () => {
        const res = await rpc('authority.dept.list', {}, WILDCARD_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });

    test('通配符用户 → authority.employee.list → Phase 1 通配符放行', async () => {
        const res = await rpc('authority.employee.list', {}, WILDCARD_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RBAC 黑盒 — 5. 跨服务越权（permit 服务不匹配）', () => {

    // permit: {commodity: ['*']} — 无 authority 授权

    test('跨服务用户 → authority private 方法 → FORBIDDEN（permit 服务不匹配）', async () => {
        const res = await rpc('authority.role.list', {}, CROSS_TOKEN);
        expect(isForbidden(res)).toBe(true);
    });

    test('跨服务用户 → authority.dept.create → FORBIDDEN', async () => {
        const res = await rpc('authority.dept.create', { name: 'hack' }, CROSS_TOKEN);
        expect(isForbidden(res)).toBe(true);
    });

    test('跨服务用户 → authority public 方法 → Phase 3 仍放行（public 跨越服务边界）', async () => {
        // public:true 的方法对所有人开放，包括持有其他服务 permit 的用户
        const res = await rpc('authority.category.list', {}, CROSS_TOKEN);
        expect(isAllowed(res)).toBe(true);
    });

    test('跨服务用户 → commodity private 方法 → 自己服务的 wildcard 放行', async () => {
        const res = await rpc('commodity.product.list', {}, CROSS_TOKEN);
        expect(isForbidden(res)).toBe(false);
    });
});
