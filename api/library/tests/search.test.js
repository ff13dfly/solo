/**
 * Hermetic unit test for library/search.js.
 *
 * NOTE ON THE FAKE-REDIS BRIEF: the task brief assumed this module issues
 * RediSearch FT.SEARCH/FT.AGGREGATE via redis.sendCommand and that we'd need a
 * canned-reply fake. It does NOT. search.js is a PURE in-memory utility: it
 * fetch-nothing, takes an already-materialized array and applies
 * keyword/match/filter/sort/paginate, plus two string helpers (escapeTag for
 * building RediSearch TAG fragments elsewhere, and stripAliases for cleaning
 * documents). No redis, no network, no clock, no fs. So behavior is asserted
 * directly. The four exports are getPath, applySearch, escapeTag, stripAliases.
 */
const S = require('../search');
const { applySearch, getPath, escapeTag, stripAliases } = S;

describe('search — getPath (dot-notation resolver)', () => {
    test('resolves a nested path', () => {
        expect(getPath({ meta: { booth: 'B1' } }, 'meta.booth')).toBe('B1');
    });
    test('resolves a single top-level key', () => {
        expect(getPath({ id: 'x' }, 'id')).toBe('x');
    });
    test('missing leaf → undefined', () => {
        expect(getPath({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    });
    test('short-circuits on a null intermediate (?. branch)', () => {
        // a is null → a?.b is undefined, no throw
        expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    });
    test('null/undefined root object short-circuits (?. on initial accumulator)', () => {
        expect(getPath(null, 'a')).toBeUndefined();
        expect(getPath(undefined, 'a.b')).toBeUndefined();
    });
    test('falsy-but-defined leaf values are returned verbatim', () => {
        expect(getPath({ n: 0 }, 'n')).toBe(0);
        expect(getPath({ b: false }, 'b')).toBe(false);
        expect(getPath({ s: '' }, 's')).toBe('');
    });
});

describe('search — applySearch: defaults / empty opts', () => {
    test('no opts at all (default = {}) returns every item, total = length, no pagination', () => {
        const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const r = applySearch(items);
        expect(r.items).toEqual(items);
        expect(r.total).toBe(3);
        // returns a sliced copy, never the same array reference
        expect(r.items).not.toBe(items);
    });
    test('empty match object is ignored (length 0 guard)', () => {
        const items = [{ id: 'a' }, { id: 'b' }];
        const r = applySearch(items, { match: {} });
        expect(r.items).toEqual(items);
        expect(r.total).toBe(2);
    });
    test('empty searchFields / empty filters arrays are ignored (?.length guards)', () => {
        const items = [{ id: 'a' }];
        expect(applySearch(items, { keyword: 'a', searchFields: [] }).items).toEqual(items);
        expect(applySearch(items, { filters: [] }).items).toEqual(items);
    });
});

describe('search — applySearch: exact match (opts.match)', () => {
    const items = [
        { id: '1', targetType: 'product', meta: { booth: 'B012' } },
        { id: '2', targetType: 'order', meta: { booth: 'B999' } },
        { id: '3', targetType: 'product', meta: { booth: 'B012' } },
    ];

    test('single-field exact match keeps only equal rows', () => {
        const r = applySearch(items, { match: { targetType: 'product' } });
        expect(r.items.map(i => i.id)).toEqual(['1', '3']);
        expect(r.total).toBe(2);
    });
    test('multi-field match is AND (every must hold)', () => {
        const r = applySearch(items, { match: { targetType: 'product', id: '1' } });
        expect(r.items.map(i => i.id)).toEqual(['1']);
    });
    test('one mismatching field excludes the row (every short-circuits false)', () => {
        const r = applySearch(items, { match: { targetType: 'product', id: 'nope' } });
        expect(r.items).toEqual([]);
        expect(r.total).toBe(0);
    });
    test('dot-notation field path is supported', () => {
        const r = applySearch(items, { match: { 'meta.booth': 'B999' } });
        expect(r.items.map(i => i.id)).toEqual(['2']);
    });
    test('undefined expected value matches rows where the field is absent/undefined', () => {
        const data = [
            { id: 'has', targetType: 'product' },
            { id: 'missing' }, // no targetType → getPath === undefined
        ];
        const r = applySearch(data, { match: { targetType: undefined } });
        expect(r.items.map(i => i.id)).toEqual(['missing']);
    });
});

describe('search — applySearch: keyword (substring, case-insensitive)', () => {
    const items = [
        { id: '1', name: 'Alpha Widget', targetId: 'T-100' },
        { id: '2', name: 'beta gadget', targetId: 'T-200' },
        { id: '3', name: null, targetId: 'T-300' }, // null field → val != null false branch
        { id: '4', name: 'Gamma', code: 4242 },      // numeric field → String(val) path
    ];

    test('case-insensitive substring across multiple searchFields', () => {
        const r = applySearch(items, { keyword: 'WIDGET', searchFields: ['name', 'targetId'] });
        expect(r.items.map(i => i.id)).toEqual(['1']);
    });
    test('matches on a secondary field when the first is null (some + val!=null)', () => {
        const r = applySearch(items, { keyword: 't-300', searchFields: ['name', 'targetId'] });
        expect(r.items.map(i => i.id)).toEqual(['3']);
    });
    test('numeric field values are stringified before matching', () => {
        const r = applySearch(items, { keyword: '4242', searchFields: ['code'] });
        expect(r.items.map(i => i.id)).toEqual(['4']);
    });
    test('no field matches → row dropped (some returns false)', () => {
        const r = applySearch(items, { keyword: 'zzz', searchFields: ['name', 'targetId'] });
        expect(r.items).toEqual([]);
    });
    test('keyword is trimmed before matching', () => {
        const r = applySearch(items, { keyword: '  alpha  ', searchFields: ['name'] });
        expect(r.items.map(i => i.id)).toEqual(['1']);
    });
    test('whitespace-only keyword is a no-op (kw falsy after trim)', () => {
        const r = applySearch(items, { keyword: '   ', searchFields: ['name'] });
        expect(r.items.map(i => i.id)).toEqual(['1', '2', '3', '4']);
    });
    test('keyword present but searchFields omitted → no-op (?.length guard)', () => {
        const r = applySearch(items, { keyword: 'alpha' });
        expect(r.total).toBe(4);
    });
    test('empty-string keyword → no-op (keyword falsy guard)', () => {
        const r = applySearch(items, { keyword: '', searchFields: ['name'] });
        expect(r.total).toBe(4);
    });
});

describe('search — applySearch: custom predicate filters', () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];

    test('single predicate filters the list', () => {
        const r = applySearch(items, { filters: [it => it.n % 2 === 0] });
        expect(r.items.map(i => i.n)).toEqual([2, 4]);
    });
    test('multiple predicates AND together (applied in sequence)', () => {
        const r = applySearch(items, { filters: [it => it.n >= 2, it => it.n <= 3] });
        expect(r.items.map(i => i.n)).toEqual([2, 3]);
    });
});

describe('search — applySearch: sort', () => {
    test('ascending: hits av<bv and av>bv leaves', () => {
        expect(applySearch([{ n: 1 }, { n: 2 }], { sortBy: 'n', sortDir: 'asc' }).items.map(i => i.n)).toEqual([1, 2]);
        expect(applySearch([{ n: 2 }, { n: 1 }], { sortBy: 'n', sortDir: 'asc' }).items.map(i => i.n)).toEqual([1, 2]);
    });
    test('descending (default sortDir): hits bv>av and bv<av leaves', () => {
        expect(applySearch([{ n: 1 }, { n: 2 }], { sortBy: 'n' }).items.map(i => i.n)).toEqual([2, 1]);
        expect(applySearch([{ n: 2 }, { n: 1 }], { sortBy: 'n' }).items.map(i => i.n)).toEqual([2, 1]);
    });
    test('equal values yield comparator 0 (stable) — asc and desc leaves', () => {
        const eqAsc = applySearch([{ id: 'a', n: 5 }, { id: 'b', n: 5 }], { sortBy: 'n', sortDir: 'asc' });
        expect(eqAsc.items.map(i => i.id)).toEqual(['a', 'b']);
        const eqDesc = applySearch([{ id: 'a', n: 5 }, { id: 'b', n: 5 }], { sortBy: 'n', sortDir: 'desc' });
        expect(eqDesc.items.map(i => i.id)).toEqual(['a', 'b']);
    });
    test('missing sort field coalesces to 0 — covers both av ?? 0 and bv ?? 0 sides', () => {
        // a 4-element array forces multiple comparisons so the {} (missing `n`)
        // appears as BOTH the left (a) and right (b) operand of the comparator.
        const r = applySearch([{ id: 'x', n: 3 }, { id: 'z' }, { id: 'y', n: 1 }, { id: 'w', n: 2 }],
            { sortBy: 'n', sortDir: 'asc' });
        expect(r.items.map(i => i.id)).toEqual(['z', 'y', 'w', 'x']); // z→0, then 1,2,3
    });
    test('sort by dot-notation path', () => {
        const r = applySearch(
            [{ id: 'a', meta: { rank: 3 } }, { id: 'b', meta: { rank: 1 } }],
            { sortBy: 'meta.rank', sortDir: 'asc' },
        );
        expect(r.items.map(i => i.id)).toEqual(['b', 'a']);
    });
    test('sort returns a new array (does not mutate input)', () => {
        const items = [{ n: 2 }, { n: 1 }];
        const r = applySearch(items, { sortBy: 'n', sortDir: 'asc' });
        expect(items.map(i => i.n)).toEqual([2, 1]); // original untouched
        expect(r.items).not.toBe(items);
    });
});

describe('search — applySearch: pagination & total', () => {
    const items = [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];

    test('limit + offset slices a window; total is the pre-pagination count', () => {
        const r = applySearch(items, { limit: 2, offset: 1 });
        expect(r.items.map(i => i.n)).toEqual([1, 2]);
        expect(r.total).toBe(5);
    });
    test('limit omitted → returns from offset to end (end = result.length branch)', () => {
        const r = applySearch(items, { offset: 3 });
        expect(r.items.map(i => i.n)).toEqual([3, 4]);
        expect(r.total).toBe(5);
    });
    test('offset omitted (default 0) with limit', () => {
        const r = applySearch(items, { limit: 2 });
        expect(r.items.map(i => i.n)).toEqual([0, 1]);
    });
    test('offset past the end → empty page, total still full', () => {
        const r = applySearch(items, { limit: 10, offset: 99 });
        expect(r.items).toEqual([]);
        expect(r.total).toBe(5);
    });
    test('limit 0 → empty page (limit != null is true for 0)', () => {
        const r = applySearch(items, { limit: 0 });
        expect(r.items).toEqual([]);
        expect(r.total).toBe(5);
    });
    test('total reflects filtering, computed before slice', () => {
        const r = applySearch(items, { filters: [it => it.n >= 2], limit: 1 });
        expect(r.total).toBe(3);          // 2,3,4 pass the filter
        expect(r.items.map(i => i.n)).toEqual([2]);
    });
});

describe('search — applySearch: full pipeline ordering (match → keyword → filters → sort → paginate)', () => {
    test('all stages compose correctly', () => {
        const items = [
            { id: '1', type: 'p', name: 'Red Apple', qty: 3 },
            { id: '2', type: 'p', name: 'Green Apple', qty: 1 },
            { id: '3', type: 'o', name: 'Red Apple', qty: 9 },
            { id: '4', type: 'p', name: 'Red Apple', qty: 2 },
        ];
        const r = applySearch(items, {
            match: { type: 'p' },                 // → 1,2,4
            keyword: 'red', searchFields: ['name'], // → 1,4
            filters: [it => it.qty >= 2],          // → 1,4
            sortBy: 'qty', sortDir: 'asc',         // → 4 (2), 1 (3)
            limit: 1, offset: 0,                   // → 4
        });
        expect(r.items.map(i => i.id)).toEqual(['4']);
        expect(r.total).toBe(2);
    });
});

describe('search — escapeTag', () => {
    test('escapes every RediSearch TAG special char with a backslash', () => {
        expect(escapeTag('user@host.com')).toBe('user\\@host\\.com');
        expect(escapeTag('a,b;c:d')).toBe('a\\,b\\;c\\:d');
        expect(escapeTag('a-b+c=d')).toBe('a\\-b\\+c\\=d');
    });
    test('escapes braces, brackets, slashes and backslash', () => {
        expect(escapeTag('{x}[y]')).toBe('\\{x\\}\\[y\\]');
        expect(escapeTag('a/b\\c')).toBe('a\\/b\\\\c');
    });
    test('plain alphanumeric string is returned unchanged (no replacement branch)', () => {
        expect(escapeTag('plainTag123')).toBe('plainTag123');
    });
    test('non-string values are coerced via String() first', () => {
        expect(escapeTag(42)).toBe('42');
        expect(escapeTag(3.5)).toBe('3\\.5'); // the dot gets escaped
        expect(escapeTag(true)).toBe('true');
    });
});

describe('search — stripAliases', () => {
    test('removes listed alias keys, keeps the rest', () => {
        const doc = { id: 'x', createdAt: 1, created_at: 1, fooBar: 2, foo_bar: 2 };
        expect(stripAliases(doc, ['created_at', 'foo_bar'])).toEqual({ id: 'x', createdAt: 1, fooBar: 2 });
    });
    test('empty alias list → shallow copy, nothing removed', () => {
        const doc = { a: 1, b: 2 };
        const out = stripAliases(doc, []);
        expect(out).toEqual(doc);
        expect(out).not.toBe(doc); // a copy, not the same ref
    });
    test('alias not present in doc is a harmless no-op', () => {
        expect(stripAliases({ a: 1 }, ['missing'])).toEqual({ a: 1 });
    });
    test('does not mutate the original document', () => {
        const doc = { a: 1, drop_me: 9 };
        stripAliases(doc, ['drop_me']);
        expect(doc).toEqual({ a: 1, drop_me: 9 });
    });
});

describe('search — exported surface', () => {
    test('all four helpers are exported as functions', () => {
        for (const n of ['applySearch', 'getPath', 'escapeTag', 'stripAliases']) {
            expect(typeof S[n]).toBe('function');
        }
    });
});
