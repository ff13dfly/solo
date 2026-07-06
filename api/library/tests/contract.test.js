/**
 * contract.test.js — the return-contract engine (library/contract.js) + a repo-wide
 * well-formedness sweep over every service's introspection `returns_schema`.
 *
 * Hermetic: pure functions + require()'ing the (data-only) introspection arrays. No Redis,
 * no stack. Set LOG_DIR before requires in case an introspection module transitively pulls
 * in a logger-bearing dep.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-contract-test-${process.pid}`);

const { returnSchema, checkReturn, lintReturnContract, checkPickPath } = require('../contract');

describe('contract.returnSchema — declaration normalization', () => {
    test('prefers returns_schema (rule items) over legacy returns', () => {
        const m = { name: 'x', returns: ['a'], returns_schema: [{ name: 'b', type: 'number' }] };
        expect(returnSchema(m)).toEqual([{ name: 'b', type: 'number' }]);
    });
    test('maps legacy returns string array to required rule items', () => {
        expect(returnSchema({ name: 'x', returns: ['a', 'b'] })).toEqual([
            { name: 'a', required: true },
            { name: 'b', required: true },
        ]);
    });
    test('no declaration → empty (no contract)', () => {
        expect(returnSchema({ name: 'x' })).toEqual([]);
    });
    test('empty returns_schema does NOT shadow a legacy returns contract', () => {
        expect(returnSchema({ name: 'x', returns: ['id'], returns_schema: [] })).toEqual([{ name: 'id', required: true }]);
    });
});

describe('contract.checkReturn — actual vs declared', () => {
    test('subset semantics: extra keys are fine, declared keys must be present', () => {
        const m = { name: 'x', returns: ['id', 'status'] };
        expect(checkReturn(m, { id: '1', status: 'A', extra: true })).toEqual([]);
        expect(checkReturn(m, { id: '1' })).toEqual(["'status' is required"]);
    });

    test('THE bug class: a bare-array result against object-key contract fails clearly', () => {
        // This is exactly nexus.schedule.list before the fix (declared ['items'], returns []).
        const m = { name: 'nexus.schedule.list', returns: ['items'] };
        const errs = checkReturn(m, [{ schedule_id: 's1' }, { schedule_id: 's2' }]);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatch(/returns an array but declares object keys/);
    });

    test('null / non-object result against object-key contract fails', () => {
        const m = { name: 'x', returns: ['id'] };
        expect(checkReturn(m, null)).toHaveLength(1);
        expect(checkReturn(m, 'oops')).toHaveLength(1);
    });

    test('sentinel.broadcast: old ["ok"] would fail, fixed ["id","broadcasted"] passes', () => {
        const actual = { id: 'a1', broadcasted: true, channel: 'webhook' };
        expect(checkReturn({ name: 'b', returns: ['ok'] }, actual)).toEqual(["'ok' is required"]);
        expect(checkReturn({ name: 'b', returns: ['id', 'broadcasted'] }, actual)).toEqual([]);
    });

    test('returns_schema enforces types', () => {
        const m = { name: 'x', returns_schema: [{ name: 'amount', type: 'number', required: true }] };
        expect(checkReturn(m, { amount: 100 })).toEqual([]);
        expect(checkReturn(m, { amount: '100' })).toEqual(["'amount' must be number (got string)"]);
    });

    test('no contract → never complains', () => {
        expect(checkReturn({ name: 'x' }, [1, 2, 3])).toEqual([]);
        expect(checkReturn({ name: 'x' }, null)).toEqual([]);
    });
});

describe('contract.lintReturnContract — schema well-formedness', () => {
    test('flags invalid type, unknown pattern, missing + duplicate name', () => {
        const m = {
            name: 'x',
            returns_schema: [
                { name: 'a', type: 'integer' },          // invalid type
                { name: 'b', pattern: 'creditcard' },    // unknown pattern
                { type: 'string' },                       // missing name
                { name: 'a', type: 'string' },           // duplicate
            ],
        };
        const errs = lintReturnContract(m);
        expect(errs.join('\n')).toMatch(/invalid type 'integer'/);
        expect(errs.join('\n')).toMatch(/unknown pattern 'creditcard'/);
        expect(errs.join('\n')).toMatch(/missing 'name'/);
        expect(errs.join('\n')).toMatch(/duplicate key 'a'/);
    });
    test('flags returns⊄returns_schema drift', () => {
        const m = { name: 'x', returns: ['id', 'ghost'], returns_schema: [{ name: 'id', type: 'string' }] };
        expect(lintReturnContract(m).join('\n')).toMatch(/legacy returns key 'ghost' is not present in returns_schema/);
    });
    test('well-formed schema → no errors', () => {
        const m = { name: 'x', returns: ['id'], returns_schema: [{ name: 'id', type: 'string', pattern: 'id' }] };
        expect(lintReturnContract(m)).toEqual([]);
    });
});

describe('contract.checkPickPath — fulfillment source.pick verifiability', () => {
    const m = { name: 'collection.payment.get', returns_schema: [{ name: 'amount', type: 'number' }, { name: 'state', type: 'string' }] };
    test('declared top-level key → ok', () => {
        expect(checkPickPath(m, 'amount').status).toBe('ok');
    });
    test('undeclared key → missing (a real bug)', () => {
        expect(checkPickPath(m, 'paid_amount').status).toBe('missing');
    });
    test('nested path into a SCALAR head → missing (provably broken at runtime)', () => {
        // state is type:'string'; ('RECEIVED').code is undefined → the condition mis-branches.
        expect(checkPickPath(m, 'state.code').status).toBe('missing');
    });
    test('nested path under an object/untyped head → unverifiable (flat dialect cannot follow)', () => {
        const obj = { name: 'y', returns_schema: [{ name: 'ctx', type: 'object' }, { name: 'untyped' }] };
        expect(checkPickPath(obj, 'ctx.a').status).toBe('unverifiable');
        expect(checkPickPath(obj, 'untyped.a').status).toBe('unverifiable');
    });
    test('no contract → unverifiable', () => {
        expect(checkPickPath({ name: 'y' }, 'amount').status).toBe('unverifiable');
    });
});

// ── Regression guard for the two nexus declaration fixes (couples to the REAL edited file,
//    not synthetic fixtures — so a revert fails loudly). ─────────────────────────────────
describe('nexus introspection declaration fixes (real file)', () => {
    const nexus = require('../../core/nexus/handlers/introspection');
    const find = (n) => nexus.find((m) => m.name === n);

    test('sentinel.broadcast declares id+broadcasted (always) + conditional channel/reason, not the old [ok]', () => {
        const broadcast = find('nexus.sentinel.broadcast');
        expect(broadcast).toBeTruthy();
        const names = returnSchema(broadcast).map((s) => s.name);
        // The lie this fix removed: 'ok' is never returned by the handler.
        expect(names).not.toContain('ok');
        // Always-present keys (required on every non-throwing path).
        const required = returnSchema(broadcast).filter((s) => s.required).map((s) => s.name);
        expect(required).toEqual(['id', 'broadcasted']);
        // Conditional keys the handler returns per path (channel on webhook, reason on no-config).
        expect(names).toEqual(expect.arrayContaining(['id', 'broadcasted', 'channel', 'reason']));
    });
    test('schedule.list declares no object-key returns (handler returns a bare array)', () => {
        const list = find('nexus.schedule.list');
        expect(list).toBeTruthy();
        expect(list.returns).toBeUndefined();
        expect(returnSchema(list)).toEqual([]);
    });
});

// ── Repo-wide sweep: ANY declared returns_schema must be well-formed. (lintReturnContract is
//    a no-op for methods without returns_schema — so this guards correctness of declared
//    schemas, plus a coverage floor below so the sweep can't silently go all-vacuous.) ──────
describe('declared returns_schema is well-formed across the repo', () => {
    const API_ROOT = path.join(__dirname, '..', '..');
    function introspectionFiles() {
        const out = [];
        for (const tier of ['core', 'apps']) {
            const tierDir = path.join(API_ROOT, tier);
            if (!fs.existsSync(tierDir)) continue;
            for (const svc of fs.readdirSync(tierDir)) {
                const f = path.join(tierDir, svc, 'handlers', 'introspection.js');
                if (fs.existsSync(f)) out.push(f);
            }
        }
        return out;
    }

    const files = introspectionFiles();
    test('found introspection files across services', () => {
        expect(files.length).toBeGreaterThan(8);
    });

    // Coverage floor: the repo-wide sweep declares typed return contracts (≈234 after the
    // full sweep) — if this collapses, the well-formedness assertions go vacuous.
    test('the repo declares typed returns_schema at scale', () => {
        const declaring = files
            .flatMap((f) => require(f))
            .filter((m) => Array.isArray(m.returns_schema) && m.returns_schema.length);
        expect(declaring.length).toBeGreaterThanOrEqual(100);
        expect(declaring.some((m) => m.name === 'collection.payment.get')).toBe(true);
    });

    test.each(files.map((f) => [path.relative(API_ROOT, f), f]))('%s', (_rel, file) => {
        const methods = require(file);
        expect(Array.isArray(methods)).toBe(true);
        const allErrs = [];
        for (const m of methods) {
            const errs = lintReturnContract(m);
            if (errs.length) allErrs.push(...errs);
        }
        expect(allErrs).toEqual([]);
    });
});

// ── Coverage GUARD: every ai:true (orchestration/AI-callable) method must declare a typed
//    returns_schema, so a new method can't silently ship with no contract. The only exemptions
//    are methods that return a BARE top-level array — the flat object-key dialect literally
//    cannot express those (a known limitation; see the audit). Keep this allowlist tight and
//    justified; do NOT add a method here to dodge writing a schema. ──────────────────────────
describe('ai-callable coverage guard', () => {
    const API_ROOT = path.join(__dirname, '..', '..');
    // Methods whose handler returns a BARE top-level array (no object keys to contract).
    const BARE_ARRAY_ALLOWLIST = new Set([
        'setting.config.list',
        'agent.stats.hourly',
        'agent.stats.range',
        'nexus.schedule.list',
        'orchestrator.run.list',
        'orchestrator.workflow.categories',
        'orchestrator.category.list',
        'user.category.list',
    ]);

    const files = [];
    for (const tier of ['core', 'apps']) {
        const tierDir = path.join(API_ROOT, tier);
        if (!fs.existsSync(tierDir)) continue;
        for (const svc of fs.readdirSync(tierDir)) {
            const f = path.join(tierDir, svc, 'handlers', 'introspection.js');
            if (fs.existsSync(f)) files.push(f);
        }
    }
    const allMethods = files.flatMap((f) => require(f));

    test('every ai:true method declares a returns_schema (or is a known bare-array exemption)', () => {
        const uncovered = allMethods
            .filter((m) => m.ai === true && !['ping', 'methods', 'entities'].includes(m.name))
            .filter((m) => !(Array.isArray(m.returns_schema) && m.returns_schema.length))
            .filter((m) => !BARE_ARRAY_ALLOWLIST.has(m.name))
            .map((m) => m.name);
        expect(uncovered).toEqual([]);
    });
});

// ── Branch closure: nameless-method placeholders, malformed schema items, and the empty /
//    no-contract pick-path paths. Each asserts the exact diagnostic the branch produces. ────
describe('contract — diagnostic branch closure', () => {
    test("checkReturn uses the '(method)' placeholder when the method has no name", () => {
        // Schema present (passes the empty-schema short-circuit) but no `name` → the violation
        // message must fall back to '(method)'.
        const errs = checkReturn({ returns: ['id'] }, [1, 2]);
        expect(errs).toEqual(["'(method)' returns an array but declares object keys [id]"]);
    });

    test("lintReturnContract uses the '(unnamed)' placeholder when the method has no name", () => {
        const errs = lintReturnContract({ returns_schema: [{ name: 'a', type: 'integer' }] });
        expect(errs).toEqual(["(unnamed).returns_schema['a'] invalid type 'integer'"]);
    });

    test('lintReturnContract flags non-rule-object schema items (null / primitive / array)', () => {
        // null → !item; 'str'/42 → typeof !== 'object'; [] → Array.isArray; the trailing
        // valid item must NOT error (proves the bad-item `return` continues the loop).
        const errs = lintReturnContract({ name: 'x', returns_schema: [null, 'str', [], 42, { name: 'ok' }] });
        expect(errs).toEqual([
            'x.returns_schema[0] is not a rule object',
            'x.returns_schema[1] is not a rule object',
            'x.returns_schema[2] is not a rule object',
            'x.returns_schema[3] is not a rule object',
        ]);
    });

    test('checkPickPath treats a null/empty dot-path as a missing (empty) pick path', () => {
        const m = { name: 'x', returns_schema: [{ name: 'amount', type: 'number' }] };
        // null/undefined hit the `dotPath == null ? '' : dotPath` consequent; '' hits the
        // alternate — both collapse to an empty head → 'missing'.
        expect(checkPickPath(m, null)).toEqual({ status: 'missing', reason: 'empty pick path' });
        expect(checkPickPath(m, undefined)).toEqual({ status: 'missing', reason: 'empty pick path' });
        expect(checkPickPath(m, '')).toEqual({ status: 'missing', reason: 'empty pick path' });
    });

    test("checkPickPath on a no-contract, no-name method → unverifiable with the '?' placeholder", () => {
        const res = checkPickPath({}, 'amount');
        expect(res).toEqual({ status: 'unverifiable', reason: "'?' declares no return contract" });
    });
});
