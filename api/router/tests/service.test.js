const axios = require('axios');
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { createServiceHandlers, addService, ensureAdministratorService } = require('../handlers/service');

jest.mock('axios');

class MockRedisClient {
    constructor() { this.data = new Map(); this.isOpen = true; }
    async set(key, val) { this.data.set(key, val); }
}

class MockResponse {
    constructor() {
        this.sentData = null;
        this.statusCode = 200;
    }
    json(data) { this.sentData = data; return this; }
}

describe('Service Handlers', () => {

    let SERVICES, CAPABILITY_MAP, redisClient;
    const keypair = {
        publicKey: {
            toBase58: () => 'MockPublicKey123'
        },
        secretKey: new Uint8Array(64)
    };

    beforeEach(() => {
        SERVICES = {};
        CAPABILITY_MAP = {};
        redisClient = new MockRedisClient();
        jest.clearAllMocks();
    });

    describe('addService (Handshake)', () => {
        const inputUrl = 'http://test-service';
        const seed = 'randomSeed123';

        test('should successfully handshake and add service', async () => {
            // Mock responses
            axios.get.mockResolvedValue({ data: { seed } });
            axios.post.mockImplementation((url) => {
                if (url.includes('/auth/verify')) return Promise.resolve({ data: { success: true, serviceName: 'test_svc', version: '1.0' } });
                if (url.includes('/jsonrpc')) return Promise.resolve({ data: { result: [{ name: 'test.method' }] } });
                return Promise.reject(new Error('Unknown URL'));
            });

            const result = await addService(inputUrl, SERVICES, redisClient, { publicKey: keypair.publicKey, secretKey: keypair.secretKey }, CAPABILITY_MAP);
            
            expect(result.serviceName).toBe('test_svc');
            expect(SERVICES['test_svc']).toBeDefined();
            expect(SERVICES['test_svc'].url).toContain(inputUrl);
            expect(CAPABILITY_MAP['test.method']).toBeDefined();
        });

        test('should fail if no seed received', async () => {
             axios.get.mockResolvedValue({ data: {} }); // No seed
             await expect(addService(inputUrl, SERVICES, redisClient, keypair, CAPABILITY_MAP))
                .rejects.toThrow('Target service failed to provide a challenge seed');
        });

        test('should fail if verification fails', async () => {
            axios.get.mockResolvedValue({ data: { seed } });
            axios.post.mockResolvedValueOnce({ data: { success: false } }); // Verify fail

            await expect(addService(inputUrl, SERVICES, redisClient, keypair, CAPABILITY_MAP))
                .rejects.toThrow('Handshake verification rejected by target service');
        });
    });

    describe('ensureAdministratorService', () => {
        test('should add administrator if missing', () => {
            ensureAdministratorService(SERVICES, 'http://admin-svc');
            expect(SERVICES.administrator).toBeDefined();
            expect(SERVICES.administrator.url).toBe('http://admin-svc/jsonrpc');
        });

        test('should not overwrite existing administrator', () => {
            SERVICES.administrator = { url: 'old-url' };
            ensureAdministratorService(SERVICES, 'http://new-url');
            expect(SERVICES.administrator.url).toBe('old-url');
        });
    });

    describe('System Handlers', () => {
        let handlers;

        beforeEach(() => {
             SERVICES['svc1'] = { url: 'http://svc1', methods: [] };
             handlers = createServiceHandlers(SERVICES, CAPABILITY_MAP, redisClient);
        });

        test('listServices - should return list', () => {
            const res = new MockResponse();
            handlers.listServices(1, res);
            expect(res.sentData.result).toHaveLength(1);
            expect(res.sentData.result[0].id).toBe('svc1');
        });

        test('capabilities - should return map', () => {
             CAPABILITY_MAP['m1'] = { ai: true };
             const res = new MockResponse();
             handlers.capabilities({}, 1, res);
             expect(res.sentData.result.m1).toBeDefined();
        });

        test('removeService - should remove service and caps', async () => {
             CAPABILITY_MAP['m1'] = { service: 'svc1' };
             const res = new MockResponse();
             
             await handlers.removeService({ serviceId: 'svc1' }, 1, res);
             
             expect(res.sentData.result.success).toBe(true);
             expect(SERVICES['svc1']).toBeUndefined();
             expect(CAPABILITY_MAP['m1']).toBeUndefined();
        });

        test('removeService - error if not found', async () => {
             const res = new MockResponse();
             await handlers.removeService({ serviceId: 'unknown' }, 1, res);
             expect(res.sentData.error).toBeDefined();
        });
        
        test('checkServiceStatus - success', async () => {
            axios.post.mockResolvedValue({ data: { result: [] } });
            const res = new MockResponse();
            
            await handlers.checkServiceStatus({ serviceId: 'svc1' }, 1, res);
            
            expect(res.sentData.result.status).toBe('online');
            expect(SERVICES['svc1'].available).toBe(true);
        });

        test('checkServiceStatus - offline', async () => {
             axios.post.mockRejectedValue(new Error('Network Error'));
             const res = new MockResponse();
             
             await handlers.checkServiceStatus({ serviceId: 'svc1' }, 1, res);
             
             expect(res.sentData.result.status).toBe('offline');
             expect(SERVICES['svc1'].available).toBe(false);
        });
    });

});
