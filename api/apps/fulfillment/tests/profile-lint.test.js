/**
 * profile-lint.test.js — the fulfillment profile linter (logic/lint.js)
 * resolving meta_fields[].source.pick against the REAL cross-service introspection index.
 *
 * This is the layer that directly serves the goal: a profile cannot silently feed a
 * state-machine condition from a field the source API does not return. Hermetic: builds
 * the method index by require()'ing every service's (data-only) introspection array.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-profile-lint-${process.pid}`);

const { lintProfile, buildMethodIndex, metaVarsInCondition } = require('../logic/lint');

const API_ROOT = path.join(__dirname, '..', '..', '..'); // api/
function allIntrospections() {
    const arrs = [];
    for (const tier of ['core', 'apps']) {
        const tierDir = path.join(API_ROOT, tier);
        if (!fs.existsSync(tierDir)) continue;
        for (const svc of fs.readdirSync(tierDir)) {
            const f = path.join(tierDir, svc, 'handlers', 'introspection.js');
            if (fs.existsSync(f)) arrs.push(require(f));
        }
    }
    return arrs;
}

const methodIndex = buildMethodIndex(allIntrospections());

describe('method index', () => {
    test('includes the real fulfillment source target collection.payment.get', () => {
        expect(methodIndex['collection.payment.get']).toBeTruthy();
    });
});

describe('metaVarsInCondition', () => {
    test('extracts instance.meta.<key> first segments from nested JsonLogic', () => {
        const cond = { and: [{ '==': [{ var: 'instance.meta.payment_status' }, 'SUCCESS'] }, { '>=': [{ var: 'instance.meta.amount_received.cents' }, 0] }] };
        expect([...metaVarsInCondition(cond)].sort()).toEqual(['amount_received', 'payment_status']);
    });
    test('handles the {var:[path, default]} array-operand form', () => {
        expect([...metaVarsInCondition({ '==': [{ var: ['instance.meta.foo'] }, 1] })]).toEqual(['foo']);
    });
    test('handles the missing / missing_some bare-string var form (the "did it arrive?" gate)', () => {
        expect([...metaVarsInCondition({ missing: ['instance.meta.ghost'] })]).toEqual(['ghost']);
        expect([...metaVarsInCondition({ missing_some: [1, ['instance.meta.a', 'instance.meta.b']] })].sort()).toEqual(['a', 'b']);
    });
    test('does NOT treat a literal string operand of a normal op as a var', () => {
        // right-hand 'instance.meta.b' is a comparison VALUE, not a variable reference
        expect([...metaVarsInCondition({ '==': [{ var: 'instance.meta.a' }, 'instance.meta.b'] })]).toEqual(['a']);
    });
    test('ignores a malformed trailing-dot var (no empty-string key)', () => {
        expect([...metaVarsInCondition({ var: 'instance.meta.' })]).toEqual([]);
    });
});

describe('lintProfile — GOOD profile (sourced field picks a real return key)', () => {
    const good = {
        id: 'standard_trade',
        meta_fields: [
            { key: 'paidAmount', label: 'Paid', source: { service: 'collection', method: 'payment.get', params: { id: { var: 'instance.sourceId' } }, pick: 'amount' } },
            { key: 'dueAmount', label: 'Due' }, // supplied via metaUpdate, no source
        ],
        transitions: [
            { event: 'pay_confirmed', from: 'DRAFT', to: 'READY', condition: { '>=': [{ var: 'instance.meta.paidAmount' }, { var: 'instance.meta.dueAmount' }] } },
        ],
    };
    const r = lintProfile(good, methodIndex);
    test('no errors', () => expect(r.errors).toEqual([]));
    test('warns that dueAmount (no source) must come via metaUpdate', () => {
        expect(r.warnings.join('\n')).toMatch(/meta_field 'dueAmount' has no source/);
    });
});

describe('lintProfile — BAD profile (the silent-drift bugs this layer exists to catch)', () => {
    const bad = {
        id: 'broken_trade',
        meta_fields: [
            // picks a field collection.payment.get does NOT return (the status-vs-state trap, or a typo)
            { key: 'paidAmount', label: 'Paid', source: { service: 'collection', method: 'payment.get', pick: 'paid_amount' } },
            // points at a method that does not exist
            { key: 'shipped', label: 'Shipped', source: { service: 'collection', method: 'payment.ghost', pick: 'state' } },
            // uses the deprecated `field` alias (still resolves, but drift)
            { key: 'curr', label: 'Currency', source: { service: 'collection', method: 'payment.get', field: 'currency' } },
        ],
        transitions: [
            { event: 'go', from: 'A', to: 'B', condition: { '==': [{ var: 'instance.meta.unbacked' }, 1] } },
        ],
    };
    const r = lintProfile(bad, methodIndex);

    test('ERROR: pick path not in the source return contract', () => {
        expect(r.errors.join('\n')).toMatch(/picks 'paid_amount' from collection\.payment\.get but .* not a declared return key/);
    });
    test('ERROR: source method is not registered', () => {
        expect(r.errors.join('\n')).toMatch(/source method 'collection\.payment\.ghost' is not a registered API method/);
    });
    test('WARNING: deprecated source.field alias', () => {
        expect(r.warnings.join('\n')).toMatch(/uses deprecated source\.field/);
    });
    test('WARNING: condition reads an unbacked instance.meta var', () => {
        expect(r.warnings.join('\n')).toMatch(/reads instance\.meta\.unbacked with no declared meta_field/);
    });
    test('the valid `field`:currency pick is NOT an error (currency is a real return key)', () => {
        expect(r.errors.join('\n')).not.toMatch(/'curr'/);
    });
});

describe('lintProfile — hardening (silent-drift gaps closed after adversarial review)', () => {
    test('ERROR: nested pick into a SCALAR return field (state is a string)', () => {
        const p = { id: 'nested', meta_fields: [{ key: 'sc', source: { service: 'collection', method: 'payment.get', pick: 'state.code' } }] };
        expect(lintProfile(p, methodIndex).errors.join('\n')).toMatch(/picks 'state\.code'.*indexes into it/);
    });
    test('ERROR: a sourced meta_field with no key (would cache under instance.meta[undefined])', () => {
        const p = { id: 'nokey', meta_fields: [{ source: { service: 'collection', method: 'payment.get', pick: 'amount' } }] };
        expect(lintProfile(p, methodIndex).errors.join('\n')).toMatch(/sourced meta_field is missing its 'key'/);
    });
    test('WARNING: condition gates on missing(instance.meta.X) with no backing meta_field', () => {
        const p = { id: 'miss', meta_fields: [], transitions: [{ event: 'g', from: 'A', to: 'B', condition: { if: [{ missing: ['instance.meta.ghost_key'] }, false, true] } }] };
        expect(lintProfile(p, methodIndex).warnings.join('\n')).toMatch(/instance\.meta\.ghost_key with no declared meta_field/);
    });
    test('WARNING: source.params reference an unbacked instance.meta var (cross-instance pattern)', () => {
        const p = { id: 'pv', meta_fields: [{ key: 'procState', source: { service: 'collection', method: 'payment.get', params: { id: { var: 'instance.meta.procurement_instance_id' } }, pick: 'state' } }] };
        expect(lintProfile(p, methodIndex).warnings.join('\n')).toMatch(/source params reference instance\.meta\.procurement_instance_id with no declared meta_field/);
    });
    test('WARNING: both source.pick and source.field present (field is dead config)', () => {
        const p = { id: 'both', meta_fields: [{ key: 'a', source: { service: 'collection', method: 'payment.get', pick: 'amount', field: 'currency' } }] };
        expect(lintProfile(p, methodIndex).warnings.join('\n')).toMatch(/declares both source\.pick and source\.field/);
    });
});

describe('lintProfile — action methods (rule 4: a TASK action must dispatch to a real method)', () => {
    test('no error when a task action targets a registered method', () => {
        const p = { id: 'act-ok', transitions: [
            { event: 'pay', from: 'DRAFT', to: 'PAID', actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
        ] };
        expect(lintProfile(p, methodIndex).errors).toEqual([]);
    });
    test('ERROR: a task action targets a hallucinated/renamed method', () => {
        const p = { id: 'act-bad', transitions: [
            { event: 'pay', from: 'DRAFT', to: 'PAID', actions: [{ type: 'task', method: 'market.order.payy' }] },
        ] };
        expect(lintProfile(p, methodIndex).errors.join('\n')).toMatch(/action method 'market\.order\.payy' is not a registered API method/);
    });
    test('ERROR: a task action with no method', () => {
        const p = { id: 'act-nomethod', transitions: [{ event: 'go', from: 'A', to: 'B', actions: [{ type: 'task' }] }] };
        expect(lintProfile(p, methodIndex).errors.join('\n')).toMatch(/has a task action with no method/);
    });
    test('workflow-type actions are NOT method-checked (they target an orchestrator workflow id)', () => {
        const p = { id: 'act-wf', transitions: [{ event: 'go', from: 'DRAFT', to: 'B', actions: [{ type: 'workflow', method: 'some-workflow-id' }] }] };
        expect(lintProfile(p, methodIndex).errors).toEqual([]);
    });
    test('WARNING: action params reference an unbacked instance.meta var', () => {
        const p = { id: 'act-pv', transitions: [
            { event: 'pay', from: 'DRAFT', to: 'PAID', actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
        ] };
        expect(lintProfile(p, methodIndex).warnings.join('\n')).toMatch(/action 'market\.order\.pay' params reference instance\.meta\.orderId with no declared meta_field/);
    });
});

describe('lintProfile — state graph (rule 5: must leave DRAFT; no dead branches)', () => {
    test('clean: DRAFT→PAID→DONE reachable chain has no graph errors/warnings', () => {
        const p = { id: 'g-ok', transitions: [
            { event: 'pay', from: 'DRAFT', to: 'PAID' },
            { event: 'done', from: 'PAID', to: 'DONE' },
        ] };
        const r = lintProfile(p, methodIndex);
        expect(r.errors).toEqual([]);
        expect(r.warnings.join('\n')).not.toMatch(/unreachable/);
    });
    test('ERROR: no transition leaves the initial state DRAFT (instances stuck on create)', () => {
        const p = { id: 'g-stuck', transitions: [{ event: 'go', from: 'PENDING', to: 'READY' }] };
        expect(lintProfile(p, methodIndex).errors.join('\n')).toMatch(/no transition leaves the initial state DRAFT/);
    });
    test('WARNING: a state unreachable from DRAFT is a dead branch', () => {
        const p = { id: 'g-dead', transitions: [
            { event: 'pay', from: 'DRAFT', to: 'PAID' },
            { event: 'x', from: 'GHOST', to: 'DONE' },
        ] };
        const r = lintProfile(p, methodIndex);
        expect(r.errors).toEqual([]);                                   // the reachable part is fine
        expect(r.warnings.join('\n')).toMatch(/state 'GHOST' is unreachable from DRAFT/);
    });
    test('no transitions → no graph check (back-compat for meta-only fixtures)', () => {
        expect(lintProfile({ id: 'g-empty', meta_fields: [] }, methodIndex).errors).toEqual([]);
    });
});

describe('lintProfile — action policy (rule 6: opt-in allow-list, mirrors workflow H6)', () => {
    const p = { id: 'pol', transitions: [
        { event: 'pay', from: 'DRAFT', to: 'PAID', actions: [{ type: 'task', method: 'market.order.pay' }] },
        { event: 'hold', from: 'PAID', to: 'HELD', actions: [{ type: 'task', method: 'market.order.hold' }] },
    ] };
    test('no allow-list supplied → no policy check (back-compat)', () => {
        expect(lintProfile(p, methodIndex).errors).toEqual([]);
    });
    test('all actions within the allow-list → clean', () => {
        const r = lintProfile(p, methodIndex, { allowedActions: ['market.order.pay', 'market.order.hold'] });
        expect(r.errors).toEqual([]);
    });
    test('ERROR: an action outside the allow-list is rejected', () => {
        const r = lintProfile(p, methodIndex, { allowedActions: new Set(['market.order.pay']) });
        expect(r.errors.join('\n')).toMatch(/action 'market\.order\.hold' is not in the allowed-action policy/);
    });
});

describe('lintProfile — robustness', () => {
    test('empty / malformed profiles never throw', () => {
        expect(() => lintProfile(null, methodIndex)).not.toThrow();
        expect(() => lintProfile({}, methodIndex)).not.toThrow();
        expect(lintProfile({ meta_fields: 'nope', transitions: 5 }, methodIndex)).toEqual({ errors: [], warnings: [] });
    });
});
