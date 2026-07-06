const config = require('../config');
const ErrorLogic = require('../logic/error');

// Mock Redis
const mockRedisClient = {
    lRange: jest.fn(),
    del: jest.fn(),
    keys: jest.fn()
};

describe('Administrator System Handlers', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisClient.keys.mockResolvedValue([]);
    });

    describe('errorList', () => {
        test('should list errors for service', async () => {
            const logs = [JSON.stringify({ msg: 'err1' }), JSON.stringify({ msg: 'err2' })];
            mockRedisClient.lRange.mockResolvedValue(logs);

            const res = await ErrorLogic.list(mockRedisClient, { service: 'router' });
            
            expect(res.service).toBe('router');
            expect(res.logs).toHaveLength(2);
            expect(res.logs[0].msg).toBe('err1');
        });

        test('should list all errors if service name is missing', async () => {
             const res = await ErrorLogic.list(mockRedisClient, {});
             expect(res.logs).toBeDefined();
             expect(res.logs).toBeInstanceOf(Array);
        });
    });

    describe('errorClear', () => {
        test('should clear errors if admin', async () => {
            mockRedisClient.del.mockResolvedValue(1);
            
            const res = await ErrorLogic.clear(mockRedisClient, { 
                service: 'router', 
                isAdmin: true 
            });
            
            expect(res.success).toBe(true);
            expect(mockRedisClient.del).toHaveBeenCalledWith(`${config.redis.errorQueuePrefix}router`);
        });

        test('should deny if not admin', async () => {
             await expect(ErrorLogic.clear(mockRedisClient, { 
                 service: 'router', 
                 isAdmin: false 
             })).rejects.toEqual(expect.objectContaining({ code: -403 }));
        });
    });

});
