/**
 * Hermetic unit test for nexus context assembly (context.md v1).
 * No Redis, no live mesh — validateContext is pure; assemble() uses a fake relay.
 */
const { validateContext, createAssembler, interpolate } = require('../logic/context');
const jsonlogic = require('../../../library/jsonlogic');

describe('validateContext (config-time static gate)', () => {
    test('null / undefined context is allowed (raw-event agents)', () => {
        expect(() => validateContext(null)).not.toThrow();
        expect(() => validateContext(undefined)).not.toThrow();
    });

    test('rejects a write-method fetcher (read-only suffix gate)', () => {
        expect(() => validateContext({
            data_fetchers: [{ key: 'p', method: 'collection.payment.record' }],
        })).toThrow(/read-only/);
    });

    test.each(['get', 'list', 'query', 'search', 'count', 'resolve', 'info'])(
        'accepts read-only suffix "%s"',
        (suffix) => {
            expect(() => validateContext({
                data_fetchers: [{ key: 'k', method: `svc.entity.${suffix}` }],
            })).not.toThrow();
        },
    );

    test('rejects a cyclic depends_on DAG', () => {
        expect(() => validateContext({
            data_fetchers: [
                { key: 'a', method: 'svc.e.get', depends_on: ['b'] },
                { key: 'b', method: 'svc.e.get', depends_on: ['a'] },
            ],
        })).toThrow(/cyclic/);
    });

    test('rejects depends_on referencing an unknown key', () => {
        expect(() => validateContext({
            data_fetchers: [{ key: 'a', method: 'svc.e.get', depends_on: ['ghost'] }],
        })).toThrow(/unknown key/);
    });

    test('rejects duplicate fetcher keys', () => {
        expect(() => validateContext({
            data_fetchers: [
                { key: 'a', method: 'svc.e.get' },
                { key: 'a', method: 'svc.e.list' },
            ],
        })).toThrow(/duplicate/);
    });

    test('rejects malformed guard / system_prompt_template / on_error', () => {
        expect(() => validateContext({ guard: 'not-an-object' })).toThrow(/guard/);
        expect(() => validateContext({ system_prompt_template: 123 })).toThrow(/system_prompt_template/);
        expect(() => validateContext({
            data_fetchers: [{ key: 'a', method: 'svc.e.get', on_error: 'explode' }],
        })).toThrow(/on_error/);
    });

    test('autorun must be a boolean or a decision-config object', () => {
        expect(() => validateContext({ autorun: 'yes' })).toThrow(/autorun/);
        expect(() => validateContext({ autorun: true })).not.toThrow();
        expect(() => validateContext({ autorun: false })).not.toThrow();
        // object form (agent.decide config) — inverted gate fixed here at config time
        expect(() => validateContext({ autorun: { choices: ['a', 'b'] } })).not.toThrow();
        expect(() => validateContext({ autorun: { choices: ['a'], schema: { sev: 'number' }, confidence_threshold: 0.7 } })).not.toThrow();
        expect(() => validateContext({ autorun: { choices: 'a' } })).toThrow(/choices/);
        expect(() => validateContext({ autorun: { choices: [1, 2] } })).toThrow(/choices/);
        expect(() => validateContext({ autorun: { schema: [] } })).toThrow(/schema/);
        expect(() => validateContext({ autorun: { confidence_threshold: 'high' } })).toThrow(/confidence_threshold/);
        // risk_tolerance: named tier alternative to confidence_threshold (agent.decide owns the enum)
        expect(() => validateContext({ autorun: { choices: ['a'], risk_tolerance: 'strict' } })).not.toThrow();
        expect(() => validateContext({ autorun: { risk_tolerance: 0.9 } })).toThrow(/risk_tolerance/);
    });

    test('emit: requires string stream + type; validates emit_when / payload_template shapes', () => {
        expect(() => validateContext({ emit: 'nope' })).toThrow(/emit/);
        expect(() => validateContext({ emit: {} })).toThrow(/stream/);
        expect(() => validateContext({ emit: { stream: 'EVENT:X' } })).toThrow(/type/);
        expect(() => validateContext({ emit: { stream: 'EVENT:X', type: 'T' } })).not.toThrow();
        expect(() => validateContext({ emit: { stream: 'EVENT:X', type: 'T', emit_when: 'bad' } })).toThrow(/emit_when/);
        expect(() => validateContext({ emit: { stream: 'EVENT:X', type: 'T', payload_template: [] } })).toThrow(/payload_template/);
        expect(() => validateContext({
            emit: { stream: 'EVENT:X', type: 'T', emit_when: { '==': [1, 1] }, payload_template: { a: '{{event.id}}' } },
        })).not.toThrow();
    });
});

describe('interpolate ({{namespace.path}})', () => {
    const bag = { event: { id: 'pay9', amount: 42 }, fetch: { p: { name: '张三' } }, agent: { name: 'Auditor' } };

    test('whole-string single placeholder preserves the raw value type', () => {
        expect(interpolate('{{event.amount}}', bag)).toBe(42);          // number, not "42"
        expect(interpolate('{{event.id}}', bag)).toBe('pay9');
    });

    test('embedded placeholders render to a string; objects JSON-serialized', () => {
        expect(interpolate('付款 {{event.id}} = {{event.amount}}', bag)).toBe('付款 pay9 = 42');
        expect(interpolate('客户 {{fetch.p}}', bag)).toBe('客户 {"name":"张三"}');
    });

    test('missing paths render empty (embedded) / empty-string (whole)', () => {
        expect(interpolate('x{{event.nope}}y', bag)).toBe('xy');
        expect(interpolate('{{event.nope}}', bag)).toBe('');
    });

    test('recurses into objects/arrays (fetcher params)', () => {
        expect(interpolate({ id: '{{event.id}}', n: ['{{event.amount}}'] }, bag))
            .toEqual({ id: 'pay9', n: [42] });
    });
});

describe('createAssembler.assemble (runtime)', () => {
    const agentBase = { id: 'ag1', name: 'Auditor', authorityRole: 'test:ctx' };

    test('trigger guard not satisfied → { skip: true } (no fetch)', async () => {
        const relay = { call: jest.fn() };
        const { assemble } = createAssembler({ relay });
        const agent = { ...agentBase, context: { guard: { '==': [{ var: 'event.tag' }, 'T'] } } };
        const out = await assemble(agent, { tag: 'NOPE' }, 'EVENT:X');
        expect(out).toEqual({ skip: true });
        expect(relay.call).not.toHaveBeenCalled();
    });

    test('fetch + render → Context Payload (context.md §6 shape)', async () => {
        const relay = { call: async (method, params) => ({ id: params.id, amount: 4242, currency: 'CNY' }) };
        const { assemble } = createAssembler({ relay });
        const agent = {
            ...agentBase,
            context: {
                guard: { '==': [{ var: 'event.tag' }, 'T'] },
                data_fetchers: [{ key: 'payment', method: 'collection.payment.get', params: { id: '{{event.paymentId}}' } }],
                system_prompt_template: '审核 {{event.paymentId}} 金额 {{fetch.payment.amount}} {{fetch.payment.currency}}',
            },
        };
        const out = await assemble(agent, { tag: 'T', paymentId: 'pay9' }, 'EVENT:WORKFLOW:STATUS');
        expect(out.payload.event).toEqual({ type: 'EVENT:WORKFLOW:STATUS', payload: { tag: 'T', paymentId: 'pay9' } });
        expect(out.payload.context.data.payment).toEqual({ id: 'pay9', amount: 4242, currency: 'CNY' });
        expect(out.payload.context.system_prompt).toBe('审核 pay9 金额 4242 CNY');
        expect(out.payload.context.sentinel).toEqual({ id: 'ag1', name: 'Auditor', authorityRole: 'test:ctx' });
    });

    test('depends_on chains: later fetcher reads earlier result via {{fetch}}', async () => {
        const calls = [];
        const relay = {
            call: async (method, params) => {
                calls.push({ method, params });
                if (method === 'svc.workflow.get') return { created_by: 'u_001' };
                if (method === 'svc.user.get') return { name: '张三' };
                return null;
            },
        };
        const { assemble } = createAssembler({ relay });
        const agent = {
            ...agentBase,
            context: {
                data_fetchers: [
                    { key: 'wf', method: 'svc.workflow.get', params: { id: '{{event.wfId}}' } },
                    { key: 'submitter', method: 'svc.user.get', params: { userId: '{{fetch.wf.created_by}}' }, depends_on: ['wf'] },
                ],
            },
        };
        const out = await assemble(agent, { wfId: 'wf1' }, 'EVENT:X');
        expect(out.payload.context.data.submitter).toEqual({ name: '张三' });
        // submitter resolved its param from wf's result (proves DAG ordering + cross-fetch interpolation)
        expect(calls.find((c) => c.method === 'svc.user.get').params).toEqual({ userId: 'u_001' });
    });

    test('on_error: fallback → degraded value when the RPC throws (no abort)', async () => {
        const relay = { call: async () => { throw new Error('boom'); } };
        const { assemble } = createAssembler({ relay });
        const agent = {
            ...agentBase,
            context: {
                data_fetchers: [{ key: 'x', method: 'svc.e.get', params: {}, on_error: 'fallback', fallback: { name: '未知' } }],
            },
        };
        const out = await assemble(agent, {}, 'EVENT:X');
        expect(out.payload.context.data.x).toEqual({ name: '未知' });
    });

    test('on_error: abort (default) → assemble rejects', async () => {
        const relay = { call: async () => { throw new Error('boom'); } };
        const { assemble } = createAssembler({ relay });
        const agent = { ...agentBase, context: { data_fetchers: [{ key: 'x', method: 'svc.e.get', params: {} }] } };
        await expect(assemble(agent, {}, 'EVENT:X')).rejects.toThrow();
    });

    // A hung upstream must NOT stall the single consumer for the relay's ~90s socket timeout.
    const withFetcherTimeout = async (ms, fn) => {
        const prev = process.env.NEXUS_FETCHER_TIMEOUT_MS;
        process.env.NEXUS_FETCHER_TIMEOUT_MS = String(ms);
        try { return await fn(); }
        finally { if (prev === undefined) delete process.env.NEXUS_FETCHER_TIMEOUT_MS; else process.env.NEXUS_FETCHER_TIMEOUT_MS = prev; }
    };

    test('a hung fetcher is bounded by the per-fetcher timeout, then handled by on_error (fallback)', async () => {
        await withFetcherTimeout(50, async () => {
            const relay = { call: () => new Promise(() => {}) };   // never resolves
            const { assemble } = createAssembler({ relay });
            const agent = { ...agentBase, context: { data_fetchers: [{ key: 'x', method: 'svc.e.get', params: {}, on_error: 'fallback', fallback: { name: '未知' } }] } };
            const t0 = Date.now();
            const out = await assemble(agent, {}, 'EVENT:X');
            expect(Date.now() - t0).toBeLessThan(2000);            // bounded ~50ms — nowhere near relay's ~90s
            expect(out.payload.context.data.x).toEqual({ name: '未知' });  // timeout → on_error fallback
        });
    });

    test('a hung fetcher with default on_error aborts AT the timeout bound (not ~90s)', async () => {
        await withFetcherTimeout(50, async () => {
            const relay = { call: () => new Promise(() => {}) };
            const { assemble } = createAssembler({ relay });
            const agent = { ...agentBase, context: { data_fetchers: [{ key: 'x', method: 'svc.e.get', params: {} }] } };
            const t0 = Date.now();
            // a forever-hung relay that rejects in well under the relay's ~90s can ONLY be the bound.
            // (jsonrpc errors aren't Error instances → assert rejection, not toThrow.)
            await expect(assemble(agent, {}, 'EVENT:X')).rejects.toBeTruthy();
            expect(Date.now() - t0).toBeLessThan(2000);
        });
    });
});

describe('createAssembler.buildEmit (context.emit action loop)', () => {
    const { buildEmit } = createAssembler({});
    const withEmit = (emit) => ({ id: 'ag1', name: 'Auditor', context: { emit } });
    const assembled = {
        event: { type: 'EVENT:TRIGGER', payload: { paymentId: 'pay9', tag: 'T' } },
        context: { data: { payment: { amount: 4242 } }, output: 'APPROVE', sentinel: { id: 'ag1', name: 'Auditor' } },
    };

    test('no emit block → null', () => {
        expect(buildEmit({ id: 'x', context: {} }, assembled)).toBeNull();
    });

    test('renders payload_template across {{event/fetch/output/sentinel}}; actor = sentinel:<id>', () => {
        const out = buildEmit(withEmit({
            stream: 'EVENT:SENTINEL:DECISION', type: 'REVIEW',
            payload_template: { decision: '{{output}}', paymentId: '{{event.paymentId}}', amount: '{{fetch.payment.amount}}', by: '{{sentinel.id}}' },
        }), assembled);
        expect(out).toEqual({
            stream: 'EVENT:SENTINEL:DECISION', type: 'REVIEW', actor: 'sentinel:ag1',
            payload: { decision: 'APPROVE', paymentId: 'pay9', amount: 4242, by: 'ag1' }, // amount stays a number (whole-string placeholder)
        });
    });

    test('emit_when false → null (skip), true → emits (empty payload when no template)', () => {
        expect(buildEmit(withEmit({
            stream: 'EVENT:SENTINEL:DECISION', type: 'REVIEW', emit_when: { '==': [{ var: 'event.tag' }, 'NOPE'] },
        }), assembled)).toBeNull();
        expect(buildEmit(withEmit({
            stream: 'EVENT:SENTINEL:DECISION', type: 'REVIEW', emit_when: { '==': [{ var: 'event.tag' }, 'T'] },
        }), assembled)).toMatchObject({ actor: 'sentinel:ag1', payload: {} });
    });
});

describe('library/jsonlogic shared primitive', () => {
    test('evaluateCondition: null rule passes; real rule evaluates', () => {
        expect(jsonlogic.evaluateCondition(null, {})).toBe(true);
        expect(jsonlogic.evaluateCondition({ '>': [{ var: 'x' }, 3] }, { x: 5 })).toBe(true);
        expect(jsonlogic.evaluateCondition({ '>': [{ var: 'x' }, 3] }, { x: 1 })).toBe(false);
    });

    test('resolveParams: evaluates JsonLogic values, recurses, keeps scalars', () => {
        expect(jsonlogic.resolveParams({ a: { var: 'x' }, b: 'lit', c: { d: { var: 'y' } } }, { x: 1, y: 2 }))
            .toEqual({ a: 1, b: 'lit', c: { d: 2 } });
    });
});
