/**
 * Hermetic unit test for library/bootstrap.js — the initializeRedis() + internal
 * persistSemantic() paths that the sibling bootstrap.test.js intentionally leaves
 * out (it covers ensureDefaultCategories + the no-URL guard with an injected fake
 * redis, never a "real" connect).
 *
 * This file mocks the three module-level deps so we can drive every connect /
 * reconnect / error / WAL-archiver branch with zero network, zero sleeps:
 *   - redis           → createClient returns a controllable fake client
 *   - ../logger       → createLogger returns spy {info,warn,error}
 *   - ../walarchiver  → createWalArchiver returns a controllable fake archiver
 *
 * Per the test harness contract, LOG_DIR / WAL_DIR are pinned to os.tmpdir() so
 * nothing ever escapes to the repo even if a real dep slipped through.
 */
const os = require('os');
process.env.LOG_DIR = os.tmpdir();
process.env.WAL_DIR = os.tmpdir();

jest.mock('redis', () => ({ createClient: jest.fn() }));
jest.mock('../logger', () => ({ createLogger: jest.fn() }));
jest.mock('../walarchiver', () => ({ createWalArchiver: jest.fn() }));

const redis = require('redis');
const { createLogger } = require('../logger');
const { createWalArchiver } = require('../walarchiver');
const { createBootstrap } = require('../bootstrap');

// Minimal node-redis-shaped client. `on` records handlers on _handlers so a test
// can fire the 'error' event the same way the real emitter would.
function makeClient({ connect, jsonSet } = {}) {
    const handlers = {};
    const client = {
        _handlers: handlers,
        on: jest.fn((event, h) => { handlers[event] = h; return client; }),
        connect: jest.fn(connect || (() => Promise.resolve())),
        json: { set: jest.fn(jsonSet || (() => Promise.resolve('OK'))) },
    };
    return client;
}

const ORIG_WAL = process.env.WAL_ARCHIVER;
let logger;

beforeEach(() => {
    jest.clearAllMocks();
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    createLogger.mockReturnValue(logger);
});

afterEach(() => {
    if (ORIG_WAL === undefined) delete process.env.WAL_ARCHIVER;
    else process.env.WAL_ARCHIVER = ORIG_WAL;
});

describe('library/bootstrap — createBootstrap (logger wiring)', () => {
    test('defaults serviceName to "service" for the logger when config omits it', () => {
        createBootstrap({});
        expect(createLogger).toHaveBeenCalledWith('service');
    });

    test('uses config.serviceName for the logger when present', () => {
        createBootstrap({ serviceName: 'planner' });
        expect(createLogger).toHaveBeenCalledWith('planner');
    });
});

describe('library/bootstrap — initializeRedis (config guard)', () => {
    test('throws FATAL and never creates a client when redisUrl is missing', async () => {
        const { initializeRedis } = createBootstrap({ serviceName: 'planner' });
        await expect(initializeRedis('planner')).rejects.toThrow(/FATAL: Redis URL not configured/);
        expect(redis.createClient).not.toHaveBeenCalled();
    });
});

describe('library/bootstrap — initializeRedis (happy path)', () => {
    test('creates client with url, registers error handler, connects, persists semantic, starts WAL, returns client', async () => {
        delete process.env.WAL_ARCHIVER;
        const client = makeClient();
        redis.createClient.mockReturnValue(client);
        const archiver = { start: jest.fn().mockResolvedValue(undefined) };
        createWalArchiver.mockReturnValue(archiver);

        const config = {
            serviceName: 'planner',
            redisUrl: 'redis://localhost:6379',
            description: { kind: 'apps' },
        };
        const { initializeRedis } = createBootstrap(config);

        const result = await initializeRedis('planner');

        expect(redis.createClient).toHaveBeenCalledWith({ url: 'redis://localhost:6379' });
        expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('Redis connected');

        // persistSemantic wrote the semantic doc under the DEFAULT prefix, merging description
        expect(client.json.set).toHaveBeenCalledWith(
            'SYSTEM:SEMANTIC:planner', '$', { source: 'config', kind: 'apps' },
        );
        expect(logger.info).toHaveBeenCalledWith('Semantic description persisted');

        // WAL archiver wired with the per-service consumer name and started
        expect(createWalArchiver).toHaveBeenCalledWith(client, { consumer: `planner:${process.pid}` });
        expect(archiver.start).toHaveBeenCalledTimes(1);

        expect(result).toBe(client);
    });

    test('the registered redis "error" handler routes to logger.error', async () => {
        const client = makeClient();
        redis.createClient.mockReturnValue(client);
        createWalArchiver.mockReturnValue({ start: jest.fn().mockResolvedValue() });

        const { initializeRedis } = createBootstrap({ serviceName: 's', redisUrl: 'redis://x' });
        await initializeRedis('s');

        const err = new Error('redis down');
        client._handlers.error(err); // fire the event the emitter would emit
        expect(logger.error).toHaveBeenCalledWith('Redis Client Error', err);
    });

    test('connect() rejection propagates and short-circuits semantic + WAL steps', async () => {
        const client = makeClient({ connect: () => Promise.reject(new Error('no connect')) });
        redis.createClient.mockReturnValue(client);

        const { initializeRedis } = createBootstrap({ serviceName: 's', redisUrl: 'redis://x' });
        await expect(initializeRedis('s')).rejects.toThrow('no connect');

        expect(client.json.set).not.toHaveBeenCalled();
        expect(createWalArchiver).not.toHaveBeenCalled();
    });
});

describe('library/bootstrap — persistSemantic (prefix + description branches)', () => {
    test('honors config.redis.semanticPrefix and tolerates a missing description', async () => {
        const client = makeClient();
        redis.createClient.mockReturnValue(client);
        createWalArchiver.mockReturnValue({ start: jest.fn().mockResolvedValue() });

        const { initializeRedis } = createBootstrap({
            serviceName: 'core-svc',
            redisUrl: 'redis://x',
            redis: { semanticPrefix: 'CUSTOM:SEM:' },
            // no description → spread of undefined → payload is just { source }
        });
        await initializeRedis('core-svc');

        expect(client.json.set).toHaveBeenCalledWith('CUSTOM:SEM:core-svc', '$', { source: 'config' });
    });

    test('empty config.redis.semanticPrefix falls back to the default prefix', async () => {
        const client = makeClient();
        redis.createClient.mockReturnValue(client);
        createWalArchiver.mockReturnValue({ start: jest.fn().mockResolvedValue() });

        const { initializeRedis } = createBootstrap({
            serviceName: 's', redisUrl: 'redis://x', redis: { semanticPrefix: '' },
        });
        await initializeRedis('s');

        expect(client.json.set).toHaveBeenCalledWith('SYSTEM:SEMANTIC:s', '$', expect.any(Object));
    });

    test('a json.set failure is swallowed (logged, not thrown) and init still resolves', async () => {
        const client = makeClient({ jsonSet: () => Promise.reject(new Error('json boom')) });
        redis.createClient.mockReturnValue(client);
        createWalArchiver.mockReturnValue({ start: jest.fn().mockResolvedValue() });

        const { initializeRedis } = createBootstrap({ serviceName: 's', redisUrl: 'redis://x' });
        await expect(initializeRedis('s')).resolves.toBe(client);

        expect(logger.error).toHaveBeenCalledWith('Failed to persist semantic:', 'json boom');
        expect(logger.info).not.toHaveBeenCalledWith('Semantic description persisted');
    });
});

describe('library/bootstrap — WAL archiver branches', () => {
    test('WAL_ARCHIVER=off skips the archiver entirely', async () => {
        process.env.WAL_ARCHIVER = 'off';
        const client = makeClient();
        redis.createClient.mockReturnValue(client);

        const { initializeRedis } = createBootstrap({ serviceName: 's', redisUrl: 'redis://x' });
        const result = await initializeRedis('s');

        expect(createWalArchiver).not.toHaveBeenCalled();
        expect(result).toBe(client);
    });

    test('archiver.start() rejection is caught and logged (fire-and-forget) without failing init', async () => {
        delete process.env.WAL_ARCHIVER;
        const client = makeClient();
        redis.createClient.mockReturnValue(client);
        createWalArchiver.mockReturnValue({ start: jest.fn().mockRejectedValue(new Error('start fail')) });

        const { initializeRedis } = createBootstrap({ serviceName: 's', redisUrl: 'redis://x' });
        await expect(initializeRedis('s')).resolves.toBe(client);

        // flush the detached .catch() microtask
        await new Promise((r) => setImmediate(r));
        expect(logger.error).toHaveBeenCalledWith('WAL archiver failed to start:', 'start fail');
    });

    test('a synchronous createWalArchiver throw is caught and logged without failing init', async () => {
        delete process.env.WAL_ARCHIVER;
        const client = makeClient();
        redis.createClient.mockReturnValue(client);
        createWalArchiver.mockImplementation(() => { throw new Error('init blow'); });

        const { initializeRedis } = createBootstrap({ serviceName: 's', redisUrl: 'redis://x' });
        await expect(initializeRedis('s')).resolves.toBe(client);

        expect(logger.error).toHaveBeenCalledWith('WAL archiver init error:', 'init blow');
    });
});
