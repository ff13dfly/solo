/**
 * Hermetic unit test for library/pagination.js — the two-dialect paging normalizer.
 *
 * The cases that matter are the ones a service silently gets wrong when it hand-rolls
 * the换算: cursor:null must survive (it selects the bounded path), limit must beat
 * pageSize when both arrive, and limit:0 must not produce an empty page.
 */
const { resolvePaging } = require('../pagination');

describe('resolvePaging — legacy page/pageSize dialect', () => {
    test('page/pageSize converts to limit/offset', () => {
        expect(resolvePaging({ page: 3, pageSize: 20 })).toEqual({ limit: 20, offset: 40 });
    });

    test('page 1 is offset 0', () => {
        expect(resolvePaging({ page: 1, pageSize: 50 })).toEqual({ limit: 50, offset: 0 });
    });

    test('page below 1 clamps to the first page rather than a negative offset', () => {
        expect(resolvePaging({ page: 0, pageSize: 10 })).toEqual({ limit: 10, offset: 0 });
        expect(resolvePaging({ page: -5, pageSize: 10 })).toEqual({ limit: 10, offset: 0 });
    });
});

describe('resolvePaging — fleet-standard limit/offset dialect', () => {
    test('limit/offset passes through untouched', () => {
        expect(resolvePaging({ limit: 25, offset: 75 })).toEqual({ limit: 25, offset: 75 });
    });

    test('negative offset clamps to 0', () => {
        expect(resolvePaging({ limit: 10, offset: -3 })).toEqual({ limit: 10, offset: 0 });
    });

    test('offset without limit uses the service default', () => {
        expect(resolvePaging({ offset: 5 }, { defaultLimit: 30 })).toEqual({ limit: 30, offset: 5 });
    });
});

describe('resolvePaging — precedence when both dialects arrive', () => {
    // portal/operator's useEntityQuery sends page + pageSize + limit + offset together.
    test('limit/offset wins over page/pageSize', () => {
        const both = { page: 2, pageSize: 12, offset: 12, limit: 12 };
        expect(resolvePaging(both)).toEqual({ limit: 12, offset: 12 });
    });

    test('limit wins even when it disagrees with pageSize', () => {
        expect(resolvePaging({ page: 2, pageSize: 10, limit: 100 })).toEqual({ limit: 100, offset: 100 });
    });
});

describe('resolvePaging — cursor mode', () => {
    test('cursor:null selects cursor mode (first page) and emits no offset', () => {
        const out = resolvePaging({ cursor: null, limit: 50 });
        expect(out).toEqual({ limit: 50, cursor: null });
        expect('offset' in out).toBe(false);
    });

    test('a cursor string is passed through verbatim', () => {
        expect(resolvePaging({ cursor: '1734' })).toEqual({ limit: 20, cursor: '1734' });
    });

    test('cursor mode ignores page/offset entirely', () => {
        expect(resolvePaging({ cursor: null, page: 5, offset: 200, limit: 10 }))
            .toEqual({ limit: 10, cursor: null });
    });

    test('omitting the cursor key stays in offset mode', () => {
        expect('cursor' in resolvePaging({ limit: 10 })).toBe(false);
    });
});

describe('resolvePaging — defaults and junk input', () => {
    test('empty params fall back to defaultLimit at offset 0', () => {
        expect(resolvePaging()).toEqual({ limit: 20, offset: 0 });
        expect(resolvePaging({}, { defaultLimit: 100 })).toEqual({ limit: 100, offset: 0 });
    });

    test('limit 0 / negative is treated as "not sent", never an empty page', () => {
        expect(resolvePaging({ limit: 0 }, { defaultLimit: 20 })).toEqual({ limit: 20, offset: 0 });
        expect(resolvePaging({ pageSize: -1 }, { defaultLimit: 20 })).toEqual({ limit: 20, offset: 0 });
    });

    test('numeric strings coerce (internal callers bypass the Router type check)', () => {
        expect(resolvePaging({ page: '3', pageSize: '10' })).toEqual({ limit: 10, offset: 20 });
    });

    test('non-numeric junk falls back to defaults instead of NaN', () => {
        expect(resolvePaging({ page: 'abc', pageSize: {} }, { defaultLimit: 15 }))
            .toEqual({ limit: 15, offset: 0 });
    });

    test('fractional values floor rather than producing fractional offsets', () => {
        expect(resolvePaging({ page: 2.9, pageSize: 10.7 })).toEqual({ limit: 10, offset: 10 });
    });

    test('null params object is tolerated', () => {
        expect(resolvePaging(null)).toEqual({ limit: 20, offset: 0 });
    });
});
