/**
 * forwardRequest — 签名构造 + Header 透传测试
 *
 * 重点验证：
 * 1. authPayload 构造（isAdmin 决定下游收到的 permit 字符串）
 * 2. X-Router-Token / X-Router-Signature 总是存在
 * 3. authorization / x-admin-token header 透传
 * 4. constraints / meta 原样传递
 */

jest.mock('axios');
const axios = require('axios');
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { forwardRequest, extractTasks } = require('../handlers/forward');

// 生成测试用 keypair
const keypair = tweetnacl.sign.keyPair();

const targetService = { url: 'http://localhost:9999/jsonrpc' };

function makeCall(overrides = {}) {
    return forwardRequest({
        targetService,
        method: 'erp.stock.query',
        params: {},
        jsonrpc: '2.0',
        id: 1,
        sessionUser: { username: 'alice', permit: { allow_all: false }, meta: {} },
        isAdmin: false,
        keypair,
        debug: false,
        sourceHeaders: {},
        ...overrides
    });
}

beforeEach(() => {
    axios.post.mockResolvedValue({ data: { jsonrpc: '2.0', result: { items: [] }, id: 1 } });
});

afterEach(() => {
    jest.clearAllMocks();
});

describe('forwardRequest — authPayload 构造', () => {

    test('non-admin user: downstream receives permit="user"', async () => {
        await makeCall({ isAdmin: false });
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const payload = JSON.parse(tokenStr);
        expect(payload.permit).toBe('user');
    });

    test('admin user: downstream receives permit="admin"', async () => {
        await makeCall({ isAdmin: true, sessionUser: { username: 'admin', permit: { allow_all: true }, meta: {} } });
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const payload = JSON.parse(tokenStr);
        expect(payload.permit).toBe('admin');
    });

    test('payload contains iss="router"', async () => {
        await makeCall();
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const payload = JSON.parse(tokenStr);
        expect(payload.iss).toBe('router');
    });

    test('payload contains iat (timestamp)', async () => {
        const before = Date.now();
        await makeCall();
        const after = Date.now();
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const payload = JSON.parse(tokenStr);
        expect(payload.iat).toBeGreaterThanOrEqual(before);
        expect(payload.iat).toBeLessThanOrEqual(after);
    });

    test('payload carries constraints from sessionUser.permit', async () => {
        const constraints = { maxAmount: 1000, region: 'cn' };
        await makeCall({ sessionUser: { username: 'bob', permit: { allow_all: false, constraints }, meta: {} } });
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const payload = JSON.parse(tokenStr);
        expect(payload.constraints).toEqual(constraints);
    });

    test('payload carries meta from sessionUser', async () => {
        const meta = { region: 'cn', org: '' };
        await makeCall({ sessionUser: { username: 'carol', permit: { allow_all: false }, meta } });
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const payload = JSON.parse(tokenStr);
        expect(payload.meta).toEqual(meta);
    });
});

describe('forwardRequest — 签名验证', () => {

    test('X-Router-Token header is always present', async () => {
        await makeCall();
        const [, , options] = axios.post.mock.calls[0];
        expect(options.headers['X-Router-Token']).toBeDefined();
    });

    test('X-Router-Signature header is always present', async () => {
        await makeCall();
        const [, , options] = axios.post.mock.calls[0];
        expect(options.headers['X-Router-Signature']).toBeDefined();
    });

    test('signature is valid Ed25519 over the token payload', async () => {
        await makeCall();
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        const sigBytes = bs58.decode(options.headers['X-Router-Signature']);
        const msgBytes = new TextEncoder().encode(tokenStr);
        const valid = tweetnacl.sign.detached.verify(msgBytes, sigBytes, keypair.publicKey);
        expect(valid).toBe(true);
    });
});

describe('forwardRequest — Header 透传', () => {

    test('propagates authorization header to downstream', async () => {
        await makeCall({ sourceHeaders: { 'authorization': 'Bearer user-token-xyz' } });
        const [, , options] = axios.post.mock.calls[0];
        expect(options.headers['authorization']).toBe('Bearer user-token-xyz');
    });

    test('propagates x-admin-token header to downstream', async () => {
        await makeCall({ sourceHeaders: { 'x-admin-token': 'admin-secret' } });
        const [, , options] = axios.post.mock.calls[0];
        expect(options.headers['x-admin-token']).toBe('admin-secret');
    });

    test('does NOT include authorization when not in sourceHeaders', async () => {
        await makeCall({ sourceHeaders: {} });
        const [, , options] = axios.post.mock.calls[0];
        expect(options.headers['authorization']).toBeUndefined();
    });

    test('forwards to correct service URL', async () => {
        await makeCall();
        const [url] = axios.post.mock.calls[0];
        expect(url).toBe(targetService.url);
    });
});

describe('forwardRequest — 返回值', () => {

    test('returns the upstream service response data directly', async () => {
        const mockResult = { jsonrpc: '2.0', result: { items: [1, 2, 3] }, id: 1 };
        axios.post.mockResolvedValueOnce({ data: mockResult });
        const result = await makeCall();
        expect(result).toEqual(mockResult);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('forwardRequest — constraints 完整链路（Redis → authPayload）', () => {
    /**
     * 验证 constraints 从 Redis 反序列化到最终透传的完整路径：
     * Redis JSON → resolveSessionUser → forwardRequest → X-Router-Token payload
     */
    const authHandlers = require('../handlers/auth');

    class MockRedisClient {
        constructor() { this.data = new Map(); this.isOpen = true; }
        async get(key) { return this.data.get(key) || null; }
        async set(key, val) { this.data.set(key, val); }
        async expire() { }
    }

    async function resolveAndForward(redisData, token, isAdmin = false) {
        const redis = new MockRedisClient();
        for (const [k, v] of Object.entries(redisData)) {
            await redis.set(k, JSON.stringify(v));
        }
        const sessionUser = await authHandlers.resolveSessionUser(token, redis);
        await forwardRequest({ targetService, method: 'erp.stock.query', params: {}, jsonrpc: '2.0', id: 1, sessionUser, isAdmin, keypair, debug: false, sourceHeaders: {} });
        const [, , options] = axios.post.mock.calls[0];
        const tokenStr = Buffer.from(bs58.decode(options.headers['X-Router-Token'])).toString('utf8');
        return JSON.parse(tokenStr);
    }

    beforeEach(() => {
        axios.post.mockResolvedValue({ data: { jsonrpc: '2.0', result: {}, id: 1 } });
    });

    afterEach(() => jest.clearAllMocks());

    test('session 携带 constraints → 完整传递到下游 authPayload', async () => {
        const constraints = { maxAmount: 5000, region: 'cn' };
        const payload = await resolveAndForward({
            'session:tok-a': { username: 'alice', permit: { allow_all: false, services: {}, constraints } }
        }, 'tok-a');
        expect(payload.constraints).toEqual(constraints);
    });

    test('[Scheme F] user record constraints → 经动态加载后传递到下游', async () => {
        const userConstraints = { maxAmount: 9999, allowedWarehouses: ['WH01'] };
        const payload = await resolveAndForward({
            'session:tok-b': { uid: 'u1', username: 'bob', permit: { allow_all: false, services: {}, constraints: { maxAmount: 1 } } },
            'user:u1': { permit: { allow_all: false, services: {}, constraints: userConstraints } }
        }, 'tok-b');
        // Scheme F 替换 permit，下游收到 user record 的 constraints
        expect(payload.constraints).toEqual(userConstraints);
    });

    test('constraints 缺失时下游收到空对象 {}', async () => {
        const payload = await resolveAndForward({
            'session:tok-c': { username: 'carol', permit: { allow_all: false, services: {} } }
        }, 'tok-c');
        // forwardRequest 中 constraints: sessionUser.permit?.constraints || {}
        expect(payload.constraints).toEqual({});
    });

    test('嵌套 constraints 结构完整保留', async () => {
        const constraints = { limits: { daily: 1000, monthly: 20000 }, tags: ['vip', 'export'] };
        const payload = await resolveAndForward({
            'session:tok-d': { username: 'dave', permit: { allow_all: false, services: {}, constraints } }
        }, 'tok-d');
        expect(payload.constraints).toEqual(constraints);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('extractTasks', () => {

    test('returns null when no _tasks in result', () => {
        expect(extractTasks({ jsonrpc: '2.0', result: { items: [] }, id: 1 })).toBeNull();
    });

    test('returns null when responseData is null', () => {
        expect(extractTasks(null)).toBeNull();
    });

    test('extracts _tasks array from result', () => {
        const tasks = [{ type: 'log', data: {} }];
        const response = { result: { items: [], _tasks: tasks } };
        const extracted = extractTasks(response);
        expect(extracted).toEqual(tasks);
    });

    test('removes _tasks from result after extraction (sanitization)', () => {
        const response = { result: { items: [1], _tasks: [{ type: 'log' }] } };
        extractTasks(response);
        expect(response.result._tasks).toBeUndefined();
    });

    test('preserves other result fields after task extraction', () => {
        const response = { result: { items: [42], _tasks: [{ type: 'log' }] } };
        extractTasks(response);
        expect(response.result.items).toEqual([42]);
    });
});
