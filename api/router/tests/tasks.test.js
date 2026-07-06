const axios = require('axios');
const tweetnacl = require('tweetnacl');
const { processTasks } = require('../handlers/tasks');
const config = require('../config');

jest.mock('axios');

class MockRedisClient {
    constructor() { this.store = []; this.isOpen = true; }
    async rPush(key, val) { this.store.push(val); }
    async get() { return null; }   // no Redis whitelist override → config defaults apply
}

describe('Tasks Handler', () => {

    let SERVICES;
    let mockRedis;
    const keypair = {
        publicKey: { toBase58: () => 'pk' },
        secretKey: new Uint8Array(64)
    };

    beforeEach(() => {
        mockRedis = new MockRedisClient();
        SERVICES = {
            'gateway': { url: 'http://gateway' },
            'notification': { url: 'http://notification' },
            'finance': { url: 'http://finance' }
        };
        jest.clearAllMocks();
        // Speed up retry backoff in tests (production default stays 200ms — see config.js).
        config.tasks.retryBaseMs = 1;
    });

    // Default whitelist (router/config.js): notification/gateway, allowFrom
    // ['fulfillment'] only — the wildcard and the stale authority/log entries are gone.

    test('executes a whitelisted task from an allowed source', async () => {
         const tasks = [
             { service: 'gateway', method: 'gateway.email.send', params: { to: 'a@b.c' } }
         ];

         axios.post.mockResolvedValueOnce({});

         await processTasks(tasks, 'user1', false, SERVICES, keypair, mockRedis, 'fulfillment');

         expect(axios.post).toHaveBeenCalledTimes(1);
         expect(axios.post).toHaveBeenCalledWith(
             'http://gateway',
             expect.objectContaining({ method: 'gateway.email.send' }),
             expect.any(Object)
         );
    });

    test('blocks a source not in allowFrom (wildcard removed)', async () => {
         const tasks = [
             { service: 'notification', method: 'notification.send', params: {} }
         ];

         // 'collection' is not an allowed _tasks producer for notification
         await processTasks(tasks, 'user1', false, SERVICES, keypair, mockRedis, 'collection');

         expect(axios.post).not.toHaveBeenCalled();
    });

    test('blocks services outside the whitelist entirely', async () => {
         const tasks = [
             { service: 'finance', method: 'pay', params: { amt: 100 } }
         ];

         await processTasks(tasks, 'user1', true, SERVICES, keypair, mockRedis, 'fulfillment');

         expect(axios.post).not.toHaveBeenCalled();
    });

    test('blocks methods not in allowMethods', async () => {
         const tasks = [
             { service: 'gateway', method: 'gateway.smtp.delete', params: { id: 'x' } }
         ];

         await processTasks(tasks, 'user1', false, SERVICES, keypair, mockRedis, 'fulfillment');

         expect(axios.post).not.toHaveBeenCalled();
    });

    test('carries the trace context into the signed task token meta', async () => {
         const bs58 = require('bs58').default || require('bs58');
         const tasks = [
             { service: 'notification', method: 'notification.send', params: {} }
         ];
         axios.post.mockResolvedValueOnce({});

         await processTasks(tasks, 'user1', false, SERVICES, keypair, mockRedis, 'fulfillment', null,
             { trace: 'chain-task', depth: 2 });

         const headers = axios.post.mock.calls[0][2].headers;
         const payload = JSON.parse(Buffer.from(bs58.decode(headers['X-Router-Token'])).toString('utf8'));
         expect(payload.meta.trace).toBe('chain-task');
         expect(payload.meta.depth).toBe(2);
         expect(payload.context).toBe('task');
    });

    test('logs execution errors to redis after exhausting retries', async () => {
         const tasks = [
             { service: 'notification', method: 'notification.send', params: {} }
         ];

         axios.post.mockRejectedValue(new Error('Connect failed'));

         await processTasks(tasks, 'user1', false, SERVICES, keypair, mockRedis, 'fulfillment');

         expect(axios.post).toHaveBeenCalledTimes(config.tasks.maxAttempts);
         expect(mockRedis.store.length).toBe(1);
         const log = JSON.parse(mockRedis.store[0]);
         expect(log.code).toBe('TASK_ERROR');
         expect(log.error).toBe('Connect failed');
         expect(log.attempts).toBe(config.tasks.maxAttempts);
    });

    test('retries a transient failure and succeeds without logging an error (P0, 2026-07-05)', async () => {
         const tasks = [
             { service: 'gateway', method: 'gateway.email.send', params: { to: 'a@b.c' } }
         ];

         axios.post
             .mockRejectedValueOnce(new Error('ECONNRESET'))
             .mockResolvedValueOnce({});

         await processTasks(tasks, 'user1', false, SERVICES, keypair, mockRedis, 'fulfillment');

         expect(axios.post).toHaveBeenCalledTimes(2);
         expect(mockRedis.store.length).toBe(0);
    });

    test('invalidate: bust 缓存 → 下次 processTasks 立即用新白名单(不等 60s TTL)', async () => {
        const { invalidate } = require('../handlers/tasks');
        const config = require('../config');
        let wl = {};   // 空白名单 = 全部 block
        const redis = {
            isOpen: true, store: [],
            async rPush(k, v) { this.store.push(v); },
            async get(k) { return k === config.redis.taskWhitelistKey ? JSON.stringify(wl) : null; },
        };
        const tasks = [{ service: 'gateway', method: 'gateway.email.send', params: { to: 'a@b.c' } }];
        axios.post.mockResolvedValue({});

        invalidate();   // 清掉前面用例遗留的模块级缓存
        await processTasks(tasks, 'u', false, SERVICES, keypair, redis, 'fulfillment');
        expect(axios.post).not.toHaveBeenCalled();   // 空白名单 → block（缓存了空白名单）

        wl = { gateway: { allowFrom: ['fulfillment'], allowMethods: ['gateway.email.send'] } };   // 底层放开
        await processTasks(tasks, 'u', false, SERVICES, keypair, redis, 'fulfillment');
        expect(axios.post).not.toHaveBeenCalled();   // TTL 内仍走缓存的空白名单 → 还是 block

        invalidate();
        await processTasks(tasks, 'u', false, SERVICES, keypair, redis, 'fulfillment');
        expect(axios.post).toHaveBeenCalledTimes(1); // bust 后重读 → 放行
        invalidate();                                // 收尾
    });

});
