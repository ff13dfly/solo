const { createCategoryHandlers } = require('../handlers/category');

// --- Mock Infrastructure ---
class MockRedisClient {
    constructor() {
        this.storage = new Map(); // key -> field -> value
    }

    async hGet(key, field) {
        if (!this.storage.has(key)) return null;
        return this.storage.get(key).get(field) || null;
    }

    async hSet(key, field, value) {
        if (!this.storage.has(key)) {
            this.storage.set(key, new Map());
        }
        this.storage.get(key).set(field, value);
    }

    async hGetAll(key) {
        if (!this.storage.has(key)) return {};
        // Return a plain object like Redis client would
        return Object.fromEntries(this.storage.get(key) || new Map());
    }
}

class MockResponse {
    constructor() {
        this.sentData = null;
        this.statusCode = 200;
    }

    json(data) {
        this.sentData = data;
        return this;
    }
    
    status(code) {
        this.statusCode = code;
        return this;
    }
}

// --- Test Suite ---
describe('Router Category Protocol', () => {
    let mockRedis;
    let handlers;
    let REGISTRY_KEY = 'SYSTEM:REGISTRY:CATEGORIES';
    const mockServices = {
        'crm': { url: 'http://crm' }
    };

    beforeEach(() => {
        mockRedis = new MockRedisClient();
        handlers = createCategoryHandlers(mockRedis, mockServices);
    });

    test('TestCase 1: Enforce Uppercase Storage', async () => {
        const res = new MockResponse();
        await handlers.reserve({
            key: 'role',
            service: 'crm',
            type: 'LIST',
            scope: 'GLOBAL'
        }, 1, res);

        expect(res.sentData.result.key).toBe('ROLE');
        expect(res.sentData.result.success).toBe(true);
        
        // Check storage
        const stored = await mockRedis.hGet(REGISTRY_KEY, 'ROLE');
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored).owner).toBe('crm');

        // Check lowercase key does NOT exist
        const storedLower = await mockRedis.hGet(REGISTRY_KEY, 'role');
        expect(storedLower).toBeNull();
    });

    test('TestCase 2: Case Insensitive Conflict Detection', async () => {
        // First, reserve ROLE
        let res = new MockResponse();
        await handlers.reserve({ key: 'ROLE', service: 'crm' }, 1, res);
        
        // Try to reserve Role (should fail)
        res = new MockResponse();
        await handlers.reserve({ key: 'Role', service: 'crm' }, 2, res);

        expect(res.sentData.error).toBeTruthy();
        expect(res.sentData.error.code).toBe(-32010); // CONFLICT
    });

    test('TestCase 3: Case Insensitive Locate', async () => {
        // Reserve ROLE
        await handlers.reserve({ key: 'ROLE', service: 'crm' }, 1, new MockResponse());

        const res = new MockResponse();
        await handlers.locate({ key: 'Role' }, 2, res);

        expect(res.sentData.result.key).toBe('ROLE');
        expect(res.sentData.result.ownerService).toBe('crm');
    });

    test('TestCase 4: Case Insensitive Delete', async () => {
         // Reserve ROLE
         await handlers.reserve({ key: 'ROLE', service: 'crm' }, 1, new MockResponse());
         
         const res = new MockResponse();
         await handlers.delete({ key: 'roLe', service: 'crm' }, 2, res);

         expect(res.sentData.result.success).toBe(true);

         const stored = await mockRedis.hGet(REGISTRY_KEY, 'ROLE');
         expect(JSON.parse(stored).status).toBe('DELETED');
    });

    test('TestCase 5: Case Insensitive Reclaim', async () => {
        // 1. Reserve & Delete ROLE
        const h = createCategoryHandlers(mockRedis, mockServices);
        await h.reserve({ key: 'ROLE', service: 'crm' }, 1, new MockResponse());
        await h.delete({ key: 'ROLE', service: 'crm' }, 2, new MockResponse());

        // 2. Reclaim using 'Role'
        const res = new MockResponse();
        await h.reserve({ key: 'Role', service: 'crm' }, 3, res);
        
        expect(res.sentData.result.success).toBe(true);
        
        const stored = await mockRedis.hGet(REGISTRY_KEY, 'ROLE');
        expect(JSON.parse(stored).status).toBe('ACTIVE');
    });
});
