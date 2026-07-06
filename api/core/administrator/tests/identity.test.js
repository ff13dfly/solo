const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Mock Redis
const mockRedisClient = {
    connect: jest.fn(),
    on: jest.fn(),
    set: jest.fn(),
    get: jest.fn(),
    setEx: jest.fn(),
    disconnect: jest.fn(),
    isOpen: true
};

jest.mock('redis', () => ({
    createClient: () => mockRedisClient
}));

// Mock fs for self-destruct test
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    unlinkSync: jest.fn()
}));

const config = require('../config');
const createLogic = require('../logic');

const Logic = createLogic(mockRedisClient, config);
const Identity = Logic.identity;

describe('Administrator Identity (Single Admin Model)', () => {

    beforeEach(async () => {
        jest.clearAllMocks();
        await Identity.init(mockRedisClient);
        
        // Default fs mocks
        fs.existsSync.mockReturnValue(false);
    });

    test('loginRequest should use seed.json if redis is empty', async () => {
        const username = 'admin';
        const seedData = {
            username: 'admin',
            salt: 'seed_salt',
            iterations: 200000,
            login_hash: 'seed_hash'
        };

        mockRedisClient.get.mockResolvedValue(null);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(seedData));

        const res = await Identity.loginRequest({ username });
        
        expect(res.salt).toBe('seed_salt');
        expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('saveAdmin should save to redis and delete seed.json if username matches', async () => {
        const username = 'admin';
        const password = 'new_password';
        const seedData = { username: 'admin' };
        
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(seedData));

        const res = await Identity.saveAdmin({ username, password });
        
        expect(res.success).toBe(true);
        expect(mockRedisClient.set).toHaveBeenCalled();
        expect(fs.unlinkSync).toHaveBeenCalled(); // Self-destruct!
    });

    test('loginVerify should fail if seed.json is gone and redis is empty', async () => {
        mockRedisClient.get.mockResolvedValue(null);
        fs.existsSync.mockReturnValue(false);

        await expect(Identity.loginVerify({
            username: 'admin',
            challenge: 'any',
            response: 'any'
        })).rejects.toThrow();
    });

    test('loginVerify should work for Redis-stored admin', async () => {
        const username = 'admin';
        const challenge = 'ch1';
        const userData = {
            username: 'admin',
            salt: 's1',
            iterations: 10,
            login_hash: 'h1'
        };

        mockRedisClient.get.mockResolvedValue(JSON.stringify(userData));
        
        // Setup challenge in memory (loginRequest does this)
        await Identity.loginRequest({ username }); 
        
        // We need to bypass the Map or use real implementation. 
        // Our identity.js uses a Map, so we can't easily mock it unless we exported it.
        // Let's just use a real flow.
        
        const req = await Identity.loginRequest({ username: 'admin' });
        
        const response = crypto.createHash('sha256')
            .update(req.challenge + 'h1')
            .digest('hex');
            
        const verifyRes = await Identity.loginVerify({
            username: 'admin',
            challenge: req.challenge,
            response
        });
        
        expect(verifyRes.success).toBe(true);
        expect(mockRedisClient.setEx).toHaveBeenCalled();
    });
});
