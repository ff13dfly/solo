/**
 * generate.test.js — the NL → profile generate/lint/repair loop (logic/generate.js).
 *
 * Hermetic: real linter + REAL cross-service introspection index, but the LLM is a FAKE
 * (injected callLLM). That's the point — the lint gate, not the model, is what makes a
 * generated profile trustworthy, so the loop must be verifiable without any live LLM.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-generate-${process.pid}`);

const { generateProfile, extractJson, buildPrompt } = require('../logic/generate');
const { buildMethodIndex } = require('../logic/lint');

const API_ROOT = path.join(__dirname, '..', '..', '..');
function methodIndex() {
    const arrs = [];
    for (const tier of ['core', 'apps']) {
        const dir = path.join(API_ROOT, tier);
        if (!fs.existsSync(dir)) continue;
        for (const svc of fs.readdirSync(dir)) {
            const f = path.join(dir, svc, 'handlers', 'introspection.js');
            if (fs.existsSync(f)) arrs.push(require(f));
        }
    }
    return buildMethodIndex(arrs);
}
const IDX = methodIndex();

// A valid order-flow profile (grounded in real methods + the real market.order.get field).
const VALID = {
    name: 'gen', meta_fields: [{ key: 'amount', source: { service: 'market', method: 'order.get', params: { id: { var: 'instance.meta.orderId' } }, pick: 'amount' } }],
    transitions: [
        { event: 'pay', from: 'DRAFT', to: 'PAID', condition: null, actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
    ],
};
// Same profile but with a hallucinated ACTION method (only rule 4 catches it).
const BROKEN = JSON.parse(JSON.stringify(VALID));
BROKEN.transitions[0].actions[0].method = 'market.order.payy';

describe('extractJson', () => {
    test('parses a raw object', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
    test('parses inside ```json fences with prose around', () => {
        expect(extractJson('here you go:\n```json\n{"a":2}\n```\nthanks')).toEqual({ a: 2 });
    });
    test('balances nested braces, ignores trailing junk', () => {
        expect(extractJson('{"a":{"b":1}} trailing')).toEqual({ a: { b: 1 } });
    });
    test('returns null on no JSON', () => expect(extractJson('no json here')).toBeNull());
});

describe('generateProfile — repair loop', () => {
    test('clean on first try → 1 attempt, ok', async () => {
        let calls = 0;
        const callLLM = async () => { calls++; return JSON.stringify(VALID); };
        const r = await generateProfile({ requirement: 'pay then ship', callLLM, methodIndex: IDX });
        expect(r.ok).toBe(true);
        expect(r.attempts).toBe(1);
        expect(r.lintReport.errors).toEqual([]);
        expect(calls).toBe(1);
    });

    test('broken first, fixed on repair → 2 attempts, ok (lint errors drove the fix)', async () => {
        const replies = [JSON.stringify(BROKEN), JSON.stringify(VALID)];
        let i = 0;
        const seenErrors = [];
        const callLLM = async (prompt) => {
            if (i === 1) expect(prompt).toMatch(/VALIDATION ERRORS/);   // repair prompt carries the lint errors
            if (prompt.includes('payy')) seenErrors.push('saw-broken');
            return replies[i++];
        };
        const r = await generateProfile({ requirement: 'pay flow', callLLM, methodIndex: IDX });
        expect(r.attempts).toBe(2);
        expect(r.ok).toBe(true);
        expect(r.lintReport.errors).toEqual([]);
    });

    test('still broken after maxRepairs → ok:false with the lint errors surfaced', async () => {
        const callLLM = async () => JSON.stringify(BROKEN);
        const r = await generateProfile({ requirement: 'x', callLLM, methodIndex: IDX, maxRepairs: 1 });
        expect(r.ok).toBe(false);
        expect(r.attempts).toBe(2);                                    // first + 1 repair
        expect(r.lintReport.errors.join('\n')).toMatch(/action method 'market\.order\.payy' is not a registered API method/);
    });

    test('non-JSON reply → ok:false, surfaced as a generation error (no throw)', async () => {
        const callLLM = async () => 'I cannot do that';
        const r = await generateProfile({ requirement: 'x', callLLM, methodIndex: IDX, maxRepairs: 0 });
        expect(r.ok).toBe(false);
        expect(r.lintReport.errors.join('\n')).toMatch(/did not produce a valid JSON profile/);
    });

    test('stamps profileId onto the candidate', async () => {
        const callLLM = async () => JSON.stringify(VALID);
        const r = await generateProfile({ requirement: 'x', profileId: 'p-123', callLLM, methodIndex: IDX });
        expect(r.profile.id).toBe('p-123');
    });

    test('the prompt grounds the model with real methods, carries the marker, and fits agent.chat 4000-char limit', () => {
        const p = buildPrompt('do a thing', IDX);
        expect(p).toMatch(/AVAILABLE METHODS/);
        expect(p).toMatch(/agent\.chat/);                 // an early-sorted real method made the budget
        expect(p).toMatch(/FULFILLMENT_PROFILE_JSON/);    // the offline-provider marker (kept in the head)
        expect(p.length).toBeLessThanOrEqual(4000);       // never trips the Router param cap
    });

    test('bad inputs throw clearly', async () => {
        await expect(generateProfile({ requirement: '', callLLM: async () => '{}' })).rejects.toThrow(/requirement/);
        await expect(generateProfile({ requirement: 'x' })).rejects.toThrow(/callLLM/);
    });
});
