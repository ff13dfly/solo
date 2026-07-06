/**
 * In-memory search utility for Redis-backed entities.
 *
 * @why Redis SET index stores only IDs — there are no secondary indexes on field values.
 *      All field-level filtering must happen after a full fetch. This utility standardizes
 *      the fetch-all → keyword → filter → sort → paginate pipeline so each microservice
 *      doesn't reimplement it.
 *
 * @usage
 *   const { applySearch } = require('../../library/search');
 *
 *   entity.list = async (params = {}) => {
 *       const { limit, offset, keyword, ...rest } = params;
 *       const all = await baseList({ ...rest, limit: 9999, offset: 0 });
 *       return applySearch(all.items, {
 *           keyword,
 *           searchFields: ['id', 'targetId', 'meta.booth'],
 *           match: { id: params.id },            // exact match — id / targetType / etc.
 *           filters: [item => !item.targetType],  // predicate — complex conditions
 *           sortBy: 'createdAt',
 *           sortDir: 'desc',
 *           limit,
 *           offset,
 *       });
 *   };
 */

/**
 * Resolve a dot-notation path on an object.
 * e.g. getPath({ meta: { booth: 'B1' } }, 'meta.booth') → 'B1'
 */
function getPath(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Apply keyword search, custom filters, sort, and pagination to an in-memory item array.
 *
 * @param {object[]} items - Full array of records (already fetched from Redis).
 * @param {object}   opts
 * @param {string}   [opts.keyword]      - Case-insensitive substring to match against searchFields.
 * @param {string[]} [opts.searchFields] - Dot-notation field paths to search with keyword.
 * @param {object}   [opts.match]        - Exact-match field conditions (AND logic).
 *                                         e.g. { id: 'abc', targetType: 'product' }
 *                                         Dot-notation supported: { 'meta.booth': 'B012' }
 *                                         null/undefined value → matches items where field is null/undefined.
 * @param {Function[]} [opts.filters]    - Additional predicate functions (AND logic).
 * @param {string}   [opts.sortBy]       - Dot-notation field path to sort by.
 * @param {'asc'|'desc'} [opts.sortDir='desc'] - Sort direction.
 * @param {number}   [opts.limit]        - Page size.
 * @param {number}   [opts.offset=0]     - Page offset.
 * @returns {{ items: object[], total: number }}
 */
function applySearch(items, { keyword, searchFields, match, filters, sortBy, sortDir = 'desc', limit, offset = 0 } = {}) {
    let result = items;

    // Exact-match filter (most selective — run first)
    if (match && Object.keys(match).length > 0) {
        result = result.filter(item =>
            Object.entries(match).every(([field, expected]) => {
                const actual = getPath(item, field);
                return actual === expected;
            })
        );
    }

    // Keyword filter (substring, case-insensitive)
    if (keyword && searchFields?.length) {
        const kw = keyword.trim().toLowerCase();
        if (kw) {
            result = result.filter(item =>
                searchFields.some(field => {
                    const val = getPath(item, field);
                    return val != null && String(val).toLowerCase().includes(kw);
                })
            );
        }
    }

    // Custom predicate filters (AND)
    if (filters?.length) {
        for (const fn of filters) {
            result = result.filter(fn);
        }
    }

    // Sort
    if (sortBy) {
        result = [...result].sort((a, b) => {
            const av = getPath(a, sortBy) ?? 0;
            const bv = getPath(b, sortBy) ?? 0;
            return sortDir === 'asc' ? (av > bv ? 1 : av < bv ? -1 : 0)
                                     : (bv > av ? 1 : bv < av ? -1 : 0);
        });
    }

    const total = result.length;
    const start = offset;
    const end = limit != null ? start + limit : result.length;

    return { items: result.slice(start, end), total };
}

/**
 * Escape special characters for RediSearch TAG queries.
 * Use this when building FT.SEARCH queries with user-supplied values.
 */
function escapeTag(val) {
    return String(val).replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~|/\\]/g, '\\$&');
}

/**
 * Strip RediSearch schema alias fields from a document returned by ft.search.
 *
 * @why When ft.search returns ON JSON documents, node-redis appends the schema's
 *      AS-aliased fields (snake_case) alongside the original JSON fields (camelCase),
 *      causing duplicate keys with different naming conventions in the API response.
 *      Call this on every d.value before returning to callers.
 *
 * @param {object}   doc     - Raw document from result.documents[i].value
 * @param {string[]} aliases - RediSearch alias names to remove (the AS '...' values)
 * @returns {object}
 */
function stripAliases(doc, aliases) {
    const r = { ...doc };
    for (const k of aliases) delete r[k];
    return r;
}

module.exports = { applySearch, getPath, escapeTag, stripAliases };
