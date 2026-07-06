/**
 * Hermetic unit test for library/ports.js — the port/URL resolver for Solo
 * internal services. Pure module: no redis, no network, no filesystem, no time.
 *
 * Resolution order asserted here (highest priority first):
 *   1. process.env.PORT            — single-service standalone invocation
 *   2. global.__SOLO_PORTS__[name] — bundle mode
 *   3. fallback argument           — hardcoded default in config.js
 *
 * Both process.env.PORT and global.__SOLO_PORTS__ are global mutable state, so
 * every test saves and restores them to stay order-independent and deterministic.
 */
const P = require('../ports');

describe('ports — setup/teardown isolates global state', () => {
    let savedPort;
    let savedMap;

    beforeEach(() => {
        savedPort = process.env.PORT;
        savedMap = global.__SOLO_PORTS__;
        delete process.env.PORT;
        delete global.__SOLO_PORTS__;
    });

    afterEach(() => {
        if (savedPort === undefined) delete process.env.PORT;
        else process.env.PORT = savedPort;
        if (savedMap === undefined) delete global.__SOLO_PORTS__;
        else global.__SOLO_PORTS__ = savedMap;
    });

    describe('portFor — fallback (dev mode, nothing set)', () => {
        test('returns the fallback when no env and no map', () => {
            expect(P.portFor('router', 8600)).toBe(8600);
        });
        test('fallback passes through untouched (even undefined)', () => {
            expect(P.portFor('router')).toBeUndefined();
        });
        test('non-numeric fallback is returned as-is', () => {
            expect(P.portFor('router', 'nope')).toBe('nope');
            expect(P.portFor('router', null)).toBeNull();
        });
    });

    describe('portFor — global.__SOLO_PORTS__ (bundle mode)', () => {
        test('map value overrides fallback', () => {
            global.__SOLO_PORTS__ = { router: 9600 };
            expect(P.portFor('router', 8600)).toBe(9600);
        });
        test('map value is coerced to Number', () => {
            global.__SOLO_PORTS__ = { router: '9600' };
            const got = P.portFor('router', 8600);
            expect(got).toBe(9600);
            expect(typeof got).toBe('number');
        });
        test('unknown name in map falls through to fallback', () => {
            global.__SOLO_PORTS__ = { router: 9600 };
            expect(P.portFor('gateway', 8020)).toBe(8020);
        });
        test('map present but empty falls through to fallback', () => {
            global.__SOLO_PORTS__ = {};
            expect(P.portFor('router', 8600)).toBe(8600);
        });
        test('null map value (== null) falls through to fallback', () => {
            global.__SOLO_PORTS__ = { router: null };
            expect(P.portFor('router', 8600)).toBe(8600);
        });
        test('undefined map value falls through to fallback', () => {
            global.__SOLO_PORTS__ = { router: undefined };
            expect(P.portFor('router', 8600)).toBe(8600);
        });
        test('map value 0 is NOT null so it is taken and Number-coerced to 0', () => {
            global.__SOLO_PORTS__ = { router: 0 };
            expect(P.portFor('router', 8600)).toBe(0);
        });
    });

    describe('portFor — process.env.PORT (standalone, highest priority)', () => {
        test('env wins over fallback', () => {
            process.env.PORT = '7777';
            expect(P.portFor('router', 8600)).toBe(7777);
        });
        test('env wins over map', () => {
            process.env.PORT = '7777';
            global.__SOLO_PORTS__ = { router: 9600 };
            expect(P.portFor('router', 8600)).toBe(7777);
        });
        test('env is coerced to Number', () => {
            process.env.PORT = '7777';
            const got = P.portFor('router', 8600);
            expect(got).toBe(7777);
            expect(typeof got).toBe('number');
        });
        test('env="0" is falsy → ignored, falls through to map then fallback', () => {
            process.env.PORT = '0';
            global.__SOLO_PORTS__ = { router: 9600 };
            expect(P.portFor('router', 8600)).toBe(9600);
        });
        test('env="" (empty string) is falsy → ignored, uses fallback', () => {
            process.env.PORT = '';
            expect(P.portFor('router', 8600)).toBe(8600);
        });
        test('non-numeric env string → Number(x) is NaN (falsy) → ignored', () => {
            process.env.PORT = 'abc';
            expect(P.portFor('router', 8600)).toBe(8600);
        });
    });

    describe('urlFor — builds localhost URL from resolved port', () => {
        test('uses fallback port when nothing else set', () => {
            expect(P.urlFor('router', 8600)).toBe('http://localhost:8600');
        });
        test('IGNORES process.env.PORT (foreign lookup must not use this process own port)', () => {
            process.env.PORT = '7777';
            // urlFor resolves a PEER's address; the current process's PORT is irrelevant
            // (honoring it made the Router resolve every peer to itself — the admin-routing bug).
            expect(P.urlFor('router', 8600)).toBe('http://localhost:8600');
        });
        test('reflects map override', () => {
            global.__SOLO_PORTS__ = { router: 9600 };
            expect(P.urlFor('router', 8600)).toBe('http://localhost:9600');
        });
        test('returns null when resolved port is falsy (no fallback)', () => {
            expect(P.urlFor('router')).toBeNull();
        });
        test('returns null when resolved port is 0', () => {
            global.__SOLO_PORTS__ = { router: 0 };
            expect(P.urlFor('router', 8600)).toBeNull();
        });
    });
});

describe('ports — module shape', () => {
    test('exports exactly portFor and urlFor as functions', () => {
        expect(typeof P.portFor).toBe('function');
        expect(typeof P.urlFor).toBe('function');
        expect(Object.keys(P).sort()).toEqual(['portFor', 'urlFor']);
    });
});
