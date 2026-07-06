/**
 * Hermetic unit test for library/constants.js — the shared global system constants.
 * Pure module: no I/O, no redis, no clock. Assertions verify the exact exported
 * STATUS enum (keys + string values) and the module's structural shape.
 */
const C = require('../constants');

describe('constants — module shape', () => {
    test('exports exactly the STATUS and WAL keys', () => {
        expect(Object.keys(C)).toEqual(['STATUS', 'WAL']);
    });
    test('STATUS is a plain object', () => {
        expect(typeof C.STATUS).toBe('object');
        expect(C.STATUS).not.toBeNull();
        expect(Array.isArray(C.STATUS)).toBe(false);
    });
});

describe('constants — WAL ledger config', () => {
    test('has stream/group names and sane numeric bounds', () => {
        expect(typeof C.WAL.STREAM).toBe('string');
        expect(C.WAL.STREAM.length).toBeGreaterThan(0);
        expect(C.WAL.GROUP).toBe('wal-archiver');
        expect(C.WAL.MAXLEN).toBeGreaterThan(0);
        expect(C.WAL.MAX_SNAPSHOT).toBe(32 * 1024);
    });
});

describe('constants — STATUS enum values', () => {
    test('contains exactly the four lifecycle states', () => {
        expect(Object.keys(C.STATUS).sort()).toEqual(
            ['ACTIVE', 'DELETED', 'DORMANT', 'EXPIRED']
        );
    });
    test('each value is a string equal to its key (canonical enum convention)', () => {
        expect(C.STATUS.ACTIVE).toBe('ACTIVE');
        expect(C.STATUS.DELETED).toBe('DELETED');
        expect(C.STATUS.DORMANT).toBe('DORMANT');
        expect(C.STATUS.EXPIRED).toBe('EXPIRED');
    });
    test('all values are non-empty strings', () => {
        for (const v of Object.values(C.STATUS)) {
            expect(typeof v).toBe('string');
            expect(v.length).toBeGreaterThan(0);
        }
    });
    test('snapshot of the full enum (guards accidental drift)', () => {
        expect(C.STATUS).toEqual({
            ACTIVE: 'ACTIVE',
            DELETED: 'DELETED',
            DORMANT: 'DORMANT',
            EXPIRED: 'EXPIRED'
        });
    });
});

describe('constants — edge cases / absent keys', () => {
    test('unknown status keys are undefined', () => {
        expect(C.STATUS.PENDING).toBeUndefined();
        expect(C.STATUS.active).toBeUndefined();   // case-sensitive
        expect(C.STATUS['']).toBeUndefined();
    });
    test('no extra top-level exports leak in', () => {
        expect(C.PATTERNS).toBeUndefined();
        expect(C.default).toBeUndefined();
    });
});

describe('constants — stability across requires', () => {
    test('repeated require returns the same cached singleton', () => {
        // Same module instance => same object identity (Node module cache).
        const again = require('../constants');
        expect(again).toBe(C);
        expect(again.STATUS).toBe(C.STATUS);
    });
    test('STATUS is currently a mutable object (not Object.freeze-d)', () => {
        // Documents ACTUAL behavior: the module does not freeze its exports.
        expect(Object.isFrozen(C.STATUS)).toBe(false);
        expect(Object.isFrozen(C)).toBe(false);
    });
});
