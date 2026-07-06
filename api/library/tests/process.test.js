/**
 * Hermetic unit test for library/process.js — the shared Business Process
 * definition store (Process Protocol v1.1.0). The module is a factory:
 *   module.exports = (redis, { serviceName }) => ({ save, get, list, delete, validate })
 * and touches Redis only through the string ops get/set/keys/del.
 *
 * Everything here runs against a Map-backed fake Redis (the makeFakeRedis
 * pattern from core/user/tests/returns-contract.test.js, trimmed to the four
 * string commands this module uses, with a `*`-glob keys()). Time is frozen
 * with a Date.now spy where createdAt/updatedAt are asserted.
 *
 * Thrown errors are PLAIN jsonrpc error objects (throw jsonrpc.NOT_FOUND(...)),
 * not Error instances, so we capture them with try/catch helpers and assert the
 * { code, message } shape directly (see library/jsonrpc.js for the catalog).
 */
const makeProcess = require('../process');
const { STATUS } = require('../constants');

// ── Map-backed fake Redis — only get/set/del/keys (all string ops) ──────────
function makeFakeRedis() {
    const kv = new Map();
    return {
        kv, // exposed so tests can inject "ghost" entries (null / empty values)
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async del(k) { return kv.delete(k) ? 1 : 0; },
        async keys(pattern) {
            const re = new RegExp(
                '^' + pattern.split('*')
                    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('.*') + '$'
            );
            return [...kv.keys()].filter((k) => re.test(k));
        },
    };
}

// ── throw / reject capture (jsonrpc errors are plain objects) ────────────────
function grab(fn) {
    try { fn(); } catch (e) { return e; }
    throw new Error('expected the call to throw, but it did not');
}
async function grabAsync(promise) {
    try { await promise; } catch (e) { return e; }
    throw new Error('expected the promise to reject, but it did not');
}

const SERVICE = 'orchestrator';
const UPPER = 'ORCHESTRATOR';
const keyOf = (id) => `${UPPER}:PROCESS:${id}`;

// Minimal fully-valid Process definition. Its single action deliberately exercises:
//  - a string param NOT containing a forbidden var ('note') → forbiddenVars.some() === false
//  - a non-string param (count) → typeof !== 'string' short-circuit
//  - a valid action.type (PRIMARY)
const validDef = (over = {}) => ({
    id: 'p-1',
    flows: {
        DRAFT: {
            ui: {
                title: 'Draft',
                actions: [
                    {
                        id: 'submit',
                        text: 'Submit',
                        rpc: 'orchestrator.run.submit',
                        type: 'PRIMARY',
                        params: { note: 'hello', count: 3 },
                    },
                ],
            },
        },
    },
    ...over,
});

let redis;
let lib;
beforeEach(() => {
    redis = makeFakeRedis();
    lib = makeProcess(redis, { serviceName: SERVICE });
});
afterEach(() => {
    jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('validate — structural guards', () => {
    test('missing id → INVALID_PARAM', () => {
        const err = grab(() => lib.validate({}));
        expect(err).toEqual({ code: -32602, message: 'Process ID required' });
    });

    test('flows absent → INVALID_PARAM', () => {
        const err = grab(() => lib.validate({ id: 'p-1' }));
        expect(err).toEqual({
            code: -32602,
            message: 'Flows must be an object (Record<status, Flow>)',
        });
    });

    test('flows not an object (string) → INVALID_PARAM', () => {
        const err = grab(() => lib.validate({ id: 'p-1', flows: 'nope' }));
        expect(err.code).toBe(-32602);
        expect(err.message).toMatch(/Flows must be an object/);
    });

    test('flow missing ui → INVALID_PARAM (names the status)', () => {
        const err = grab(() => lib.validate({ id: 'p-1', flows: { DRAFT: {} } }));
        expect(err).toEqual({ code: -32602, message: 'Flow "DRAFT" missing ui definition' });
    });

    test('flow.ui not an object (string) → INVALID_PARAM', () => {
        const err = grab(() => lib.validate({ id: 'p-1', flows: { DRAFT: { ui: 'x' } } }));
        expect(err).toEqual({ code: -32602, message: 'Flow "DRAFT" missing ui definition' });
    });

    test('ui missing title → INVALID_PARAM', () => {
        const err = grab(() => lib.validate({ id: 'p-1', flows: { DRAFT: { ui: {} } } }));
        expect(err).toEqual({ code: -32602, message: 'Flow "DRAFT" missing ui.title' });
    });

    test('ui.actions present but not an array → INVALID_PARAM', () => {
        const err = grab(() => lib.validate({
            id: 'p-1', flows: { DRAFT: { ui: { title: 'T', actions: 'x' } } },
        }));
        expect(err).toEqual({ code: -32602, message: 'Flow "DRAFT" ui.actions must be an array' });
    });

    test('flow with NO actions key is valid (actions branch skipped) → true', () => {
        expect(lib.validate({ id: 'p-1', flows: { DRAFT: { ui: { title: 'T' } } } })).toBe(true);
    });
});

describe('validate — per-action required fields', () => {
    const withAction = (action) => ({
        id: 'p-1', flows: { DRAFT: { ui: { title: 'T', actions: [action] } } },
    });

    test('action missing id → INVALID_PARAM', () => {
        const err = grab(() => lib.validate(withAction({})));
        expect(err).toEqual({ code: -32602, message: 'Action in "DRAFT" missing id' });
    });

    test('action missing text → INVALID_PARAM (names the action id)', () => {
        const err = grab(() => lib.validate(withAction({ id: 'a1' })));
        expect(err).toEqual({ code: -32602, message: 'Action "a1" missing text' });
    });

    test('action missing rpc → INVALID_PARAM', () => {
        const err = grab(() => lib.validate(withAction({ id: 'a1', text: 'Go' })));
        expect(err).toEqual({ code: -32602, message: 'Action "a1" missing rpc method' });
    });
});

describe('validate — identity-field SECURITY check', () => {
    const withParams = (params) => ({
        id: 'p-1',
        flows: { DRAFT: { ui: { title: 'T', actions: [
            { id: 'act', text: 'Go', rpc: 'svc.do.it', params },
        ] } } },
    });

    // forbidden $user.* var × identity key → Security Error
    test.each([
        ['userId', '$user.id'],
        ['operatorId', '$user.uid'],
        ['approvedBy', '$user.name'],
        ['uid', '$user.username'],
    ])('identity key %s set to %s → Security Error', (key, val) => {
        const err = grab(() => lib.validate(withParams({ [key]: val })));
        expect(err.code).toBe(-32602);
        expect(err.message).toBe(
            `Security Error: Identity field "${key}" cannot be set via dynamic variable in action "act"`
        );
    });

    test('forbidden var EMBEDDED in a larger string still trips the identity check', () => {
        const err = grab(() => lib.validate(withParams({ userId: 'prefix-$user.id-suffix' })));
        expect(err.message).toMatch(/Security Error: Identity field "userId"/);
    });

    test('SAME forbidden var in a NON-identity key is allowed → true', () => {
        expect(lib.validate(withParams({ note: '$user.id' }))).toBe(true);
    });

    test('identity key with a non-forbidden value is allowed → true', () => {
        // 'userId' is an identity key, but the value carries no $user.* var, so
        // forbiddenVars.some() is false and the identity-key check is never reached.
        expect(lib.validate(withParams({ userId: '$order.id' }))).toBe(true);
        expect(lib.validate(withParams({ userId: 'static-uid-123' }))).toBe(true);
    });

    test('non-string identity value is ignored (typeof short-circuit) → true', () => {
        expect(lib.validate(withParams({ userId: 42 }))).toBe(true);
    });

    test('action with no params at all skips the security block → true', () => {
        const def = {
            id: 'p-1', flows: { DRAFT: { ui: { title: 'T', actions: [
                { id: 'act', text: 'Go', rpc: 'svc.do.it' },
            ] } } },
        };
        expect(lib.validate(def)).toBe(true);
    });
});

describe('validate — action.type', () => {
    const withType = (type) => ({
        id: 'p-1', flows: { DRAFT: { ui: { title: 'T', actions: [
            { id: 'act', text: 'Go', rpc: 'svc.do.it', type },
        ] } } },
    });

    test('invalid type → INVALID_PARAM', () => {
        const err = grab(() => lib.validate(withType('WEIRD')));
        expect(err).toEqual({ code: -32602, message: 'Action "act" has invalid type: WEIRD' });
    });

    test.each(['PRIMARY', 'SUCCESS', 'DANGER', 'GHOST'])(
        'valid type %s → true', (type) => {
            expect(lib.validate(withType(type))).toBe(true);
        });

    test('fully valid definition → true', () => {
        expect(lib.validate(validDef())).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('save', () => {
    test('new record: status defaults ACTIVE, createdAt/updatedAt set, JSON persisted', async () => {
        const T = 1_700_000_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(T);

        const rec = await lib.save(validDef());

        expect(rec.status).toBe(STATUS.ACTIVE);
        expect(rec.createdAt).toBe(T);
        expect(rec.updatedAt).toBe(T);
        expect(rec.id).toBe('p-1');

        // Persisted under SERVICE_UPPER:PROCESS:<id> as JSON of the record.
        const raw = await redis.get(keyOf('p-1'));
        expect(typeof raw).toBe('string');
        expect(JSON.parse(raw)).toEqual(rec);
    });

    test('existing createdAt is preserved; updatedAt advances; explicit status kept', async () => {
        const T = 1_700_000_500_000;
        jest.spyOn(Date, 'now').mockReturnValue(T);

        const rec = await lib.save(validDef({ createdAt: 12345, status: STATUS.DORMANT }));
        expect(rec.createdAt).toBe(12345);   // preserved (data.createdAt || now → left)
        expect(rec.updatedAt).toBe(T);       // always refreshed
        expect(rec.status).toBe(STATUS.DORMANT); // data.status || ACTIVE → left
    });

    test('invalid data is rejected before any write', async () => {
        const err = await grabAsync(lib.save({ id: 'bad' })); // no flows
        expect(err.code).toBe(-32602);
        expect(await redis.get(keyOf('bad'))).toBeNull(); // nothing persisted
    });
});

describe('get', () => {
    test('hardcoded hit short-circuits Redis', async () => {
        const baked = { id: 'h1', source: 'hardcoded' };
        const out = await lib.get({ id: 'h1', hardcoded: { h1: baked } });
        expect(out).toBe(baked);
        // and nothing was written/needed in redis
        expect(await redis.get(keyOf('h1'))).toBeNull();
    });

    test('redis hit returns the stored record', async () => {
        const saved = await lib.save(validDef());
        const out = await lib.get({ id: 'p-1' });
        expect(out).toEqual(saved);
    });

    test('missing id → MISSING_PARAM', async () => {
        const err = await grabAsync(lib.get({}));
        expect(err).toEqual({ code: -32602, message: 'Missing parameter: id' });
    });

    test('no record → NOT_FOUND', async () => {
        const err = await grabAsync(lib.get({ id: 'nope' }));
        expect(err).toEqual({ code: -32002, message: 'Process "nope" not found' });
    });

    test('record marked DELETED → NOT_FOUND (Deleted)', async () => {
        await redis.set(keyOf('gone'), JSON.stringify({ id: 'gone', status: STATUS.DELETED }));
        const err = await grabAsync(lib.get({ id: 'gone' }));
        expect(err).toEqual({ code: -32002, message: 'Process "gone" (Deleted) not found' });
    });
});

describe('list', () => {
    test('default returns ACTIVE only; includeDeleted returns all', async () => {
        await lib.save(validDef({ id: 'a' }));
        await lib.save(validDef({ id: 'b' }));
        await redis.set(keyOf('d'), JSON.stringify({ id: 'd', status: STATUS.DELETED }));

        const active = await lib.list(); // default arg {} → includeDeleted false
        expect(active.map((p) => p.id).sort()).toEqual(['a', 'b']);

        const all = await lib.list({ includeDeleted: true });
        expect(all.map((p) => p.id).sort()).toEqual(['a', 'b', 'd']);
    });

    test('skips keys whose value is null/empty (deleted-between-keys-and-get race)', async () => {
        await lib.save(validDef({ id: 'real' }));
        redis.kv.set(keyOf('empty'), '');     // get → '' falsy → skipped
        redis.kv.set(keyOf('null'), null);    // get → null → skipped

        const out = await lib.list({ includeDeleted: true });
        expect(out.map((p) => p.id)).toEqual(['real']);
    });

    test('empty store → []', async () => {
        expect(await lib.list()).toEqual([]);
    });
});

describe('delete', () => {
    test('missing id → MISSING_PARAM', async () => {
        const err = await grabAsync(lib.delete({}));
        expect(err).toEqual({ code: -32602, message: 'Missing parameter: id' });
    });

    test('hard delete removes the key and reports { success, hard }', async () => {
        await lib.save(validDef({ id: 'h' }));
        const res = await lib.delete({ id: 'h', hard: true });
        expect(res).toEqual({ success: true, hard: true });
        expect(await redis.get(keyOf('h'))).toBeNull();
    });

    test('soft delete marks DELETED, bumps updatedAt, reports { success, soft }', async () => {
        const T = 1_700_111_111_111;
        jest.spyOn(Date, 'now').mockReturnValue(T);
        await lib.save(validDef({ id: 's', createdAt: 1 }));

        const res = await lib.delete({ id: 's' }); // hard defaults false
        expect(res).toEqual({ success: true, soft: true });

        const rec = JSON.parse(await redis.get(keyOf('s')));
        expect(rec.status).toBe(STATUS.DELETED);
        expect(rec.updatedAt).toBe(T);
    });

    test('soft delete of a missing record → NOT_FOUND', async () => {
        const err = await grabAsync(lib.delete({ id: 'ghost' }));
        expect(err).toEqual({ code: -32002, message: 'Process "ghost" not found' });
    });
});

describe('exported standalone validate', () => {
    test('is exposed and behaves identically to the internal validator', () => {
        expect(typeof lib.validate).toBe('function');
        expect(lib.validate(validDef())).toBe(true);
        const err = grab(() => lib.validate({}));
        expect(err.code).toBe(-32602);
    });
});
