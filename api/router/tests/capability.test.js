const axios = require('axios');
const { updateCapabilityMap, CAPABILITY_MAP } = require('../handlers/capability');

jest.mock('axios');

class MockRedisClient {
    constructor() { this.store = new Map(); this.isOpen = true; }
    async set(key, val) { this.store.set(key, val); }
}

describe('Capability Handler', () => {

    let SERVICES;
    let mockRedis;

    beforeEach(() => {
        SERVICES = {
            's1': { url: 'http://s1' },
            's2': { url: 'http://s2' } // This will fail
        };
        mockRedis = new MockRedisClient();
        jest.clearAllMocks();
        
        // Reset Global Map
        Object.keys(CAPABILITY_MAP).forEach(k => delete CAPABILITY_MAP[k]);
    });

    test('should update capability map from services', async () => {
         axios.post.mockImplementation((url) => {
             if (url === 'http://s1') {
                 return Promise.resolve({
                     data: {
                         result: {
                             methods: [{ name: 's1.foo', description: 'foo' }],
                             description: { en: 'Service 1' }
                         }
                     }
                 });
             }
             if (url === 'http://s2') {
                 return Promise.reject(new Error('Down'));
             }
         });

         await updateCapabilityMap(SERVICES, mockRedis);

         // Check Map
         expect(CAPABILITY_MAP['s1.foo']).toBeDefined();
         expect(CAPABILITY_MAP['s1.foo'].service).toBe('s1');
         expect(CAPABILITY_MAP['s1.foo'].desc).toBe('foo');
         
         // s2 should not be there (failed)
         expect(Object.keys(CAPABILITY_MAP).length).toBe(1);

         // Check Redis
         expect(mockRedis.store.get('system:capability:list')).toContain('s1.foo');
    });

    test('should handle flat array response from service', async () => {
         axios.post.mockResolvedValue({
             data: { result: [{ name: 's1.bar' }] }
         });

         await updateCapabilityMap({ 's1': SERVICES['s1'] }, mockRedis);
         
         expect(CAPABILITY_MAP['s1.bar']).toBeDefined();
    });

    test('should clear old capabilities', async () => {
         CAPABILITY_MAP['old.method'] = { service: 'old' };
         
         axios.post.mockResolvedValue({ data: { result: [] } }); // No methods

         await updateCapabilityMap({ 's1': SERVICES['s1'] }, mockRedis);
         
         expect(CAPABILITY_MAP['old.method']).toBeUndefined();
    });
});
