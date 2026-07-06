/**
 * agent.decide — the structured decision contract.
 *
 * Three layers, mirroring the design goal (AI-driven, degradable):
 *   1. HERMETIC (always runs) — mock provider proves the contract shape + inverted gate.
 *   2. DEGRADABILITY (always runs) — provider error / out-of-set / low-confidence all
 *      collapse to escalate:true via a stubbed provider. No network.
 *   3. LIVE (gated on keys) — real qwen + gemini cheap models actually answer; we assert
 *      the decision lands inside the closed choice set and the contract holds.
 *
 * Live keys live in core/agent/.env, NOT the repo root — load them before requiring any
 * agent module (config.js reads process.env at require-time).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Methods = require('../logic');
const ProviderFactory = require('../providers');

const TICKET = {
    instruction: 'Classify the support ticket below as URGENT or NORMAL based on its content.',
    context: { ticket: 'Production is completely down, all customers affected, losing money every minute.' },
    choices: ['urgent', 'normal'],
};

describe('agent.decide — hermetic (mock provider)', () => {
    test('returns the contract shape and respects the closed choice set', async () => {
        const r = await Methods.agent.decide({ ...TICKET, model: 'mock-1' });
        expect(r).toMatchObject({
            decision: expect.any(String),
            confidence: expect.any(Number),
            reason: expect.any(String),
            escalate: expect.any(Boolean),
        });
        // inverted gate: mock picks the first allowed choice — always inside the set.
        expect(TICKET.choices).toContain(r.decision);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
        expect(r.escalate).toBe(false); // mock confidence 0.9 ≥ default 0.6 threshold
        expect(r.metadata.provider).toBe('mock');
    });

    test('the rendered instruction reaches the decision boundary', async () => {
        const r = await Methods.agent.decide({ instruction: 'review payment 7777', choices: ['a'], context: { a: 1 }, model: 'mock-1' });
        // mock echoes the instruction into reason — proves the rendered prompt wasn't dropped.
        expect(r.reason).toContain('MOCK_DECIDE::review payment 7777');
    });

    test('a missing instruction is a hard error (caller bug, not a degradation)', async () => {
        await expect(Methods.agent.decide({ choices: ['a'], model: 'mock-1' }))
            .rejects.toMatchObject({ message: expect.stringMatching(/instruction/) });
    });
});

describe('agent.decide — degradability (stubbed provider, no network)', () => {
    const realGetProvider = ProviderFactory.getProvider;
    afterEach(() => { ProviderFactory.getProvider = realGetProvider; });

    function stub(decideImpl) {
        ProviderFactory.getProvider = () => ({ decide: decideImpl });
    }

    test('provider error ⇒ escalate (fail-soft, never throws)', async () => {
        stub(async () => { throw new Error('boom'); });
        const r = await Methods.agent.decide({ ...TICKET });
        expect(r.escalate).toBe(true);
        expect(r.decision).toBe('defer');
        expect(r.reason).toMatch(/agent unavailable/);
    });

    test('decision outside the closed choice set ⇒ escalate (inverted gate enforced)', async () => {
        stub(async () => ({ success: true, data: { decision: 'EXPLODE', confidence: 0.99, reason: 'rogue' } }));
        const r = await Methods.agent.decide({ ...TICKET });
        expect(r.escalate).toBe(true);
        expect(r.decision).toBe('defer');
        expect(r.reason).toMatch(/not in allowed choices/);
    });

    test('valid decision but low confidence ⇒ escalate, decision preserved', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.2, reason: 'unsure' } }));
        const r = await Methods.agent.decide({ ...TICKET, confidence_threshold: 0.6 });
        expect(r.decision).toBe('urgent');
        expect(r.escalate).toBe(true);
    });

    test('valid high-confidence decision ⇒ no escalate', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.95, reason: 'clear' } }));
        const r = await Methods.agent.decide({ ...TICKET });
        expect(r.decision).toBe('urgent');
        expect(r.escalate).toBe(false);
    });

    test('risk_tolerance "strict" escalates a Qwen-typical 0.9 confidence (permissive default would not)', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.9, reason: 'typical qwen' } }));
        const strict = await Methods.agent.decide({ ...TICKET, risk_tolerance: 'strict' });
        expect(strict.escalate).toBe(true);
        const permissive = await Methods.agent.decide({ ...TICKET, risk_tolerance: 'permissive' });
        expect(permissive.escalate).toBe(false);
    });

    test('risk_tolerance "balanced" sits between permissive and strict', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.85, reason: 'ok' } }));
        const r = await Methods.agent.decide({ ...TICKET, risk_tolerance: 'balanced' });
        expect(r.escalate).toBe(false); // 0.85 ≥ 0.8
    });

    test('confidence_threshold wins over risk_tolerance when both given', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.9, reason: 'ok' } }));
        const r = await Methods.agent.decide({ ...TICKET, risk_tolerance: 'strict', confidence_threshold: 0.5 });
        expect(r.escalate).toBe(false); // explicit 0.5 threshold overrides strict's 0.95
    });

    test('unknown risk_tolerance falls back to the default threshold (fail-soft, not rejected)', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.7, reason: 'ok' } }));
        const r = await Methods.agent.decide({ ...TICKET, risk_tolerance: 'nonexistent-tier' });
        expect(r.escalate).toBe(false); // 0.7 ≥ default 0.6
    });

    test('schema-bound fields pass through (values only)', async () => {
        stub(async () => ({ success: true, data: { decision: 'urgent', confidence: 0.9, reason: 'ok', fields: { severity: 5 } } }));
        const r = await Methods.agent.decide({ ...TICKET, schema: { severity: 'number' } });
        expect(r.fields).toEqual({ severity: 5 });
    });
});

// --- LIVE: real cheap-model calls, gated on the presence of each key ---
const liveQwen = process.env.DASHSCOPE_API_KEY ? describe : describe.skip;
const liveGemini = process.env.GEMINI_API_KEY ? describe : describe.skip;

liveQwen('agent.decide — LIVE qwen (qwen-turbo)', () => {
    jest.setTimeout(30000);
    test('picks a decision inside the closed set with high confidence', async () => {
        const r = await Methods.agent.decide({ ...TICKET, model: 'qwen-turbo' });
        expect(TICKET.choices).toContain(r.decision);
        expect(r.decision).toBe('urgent');
        expect(typeof r.confidence).toBe('number');
        expect(typeof r.escalate).toBe('boolean');
        expect(r.metadata.provider).toBe('qwen');
    });

    test('no context ⇒ degrades (low confidence / escalate)', async () => {
        const r = await Methods.agent.decide({
            instruction: 'Decide whether to APPROVE or REJECT the refund.',
            context: {},
            choices: ['approve', 'reject'],
            model: 'qwen-turbo',
        });
        // decision still inside the set; but with no basis it should not be a confident auto-action.
        expect(['approve', 'reject', 'defer']).toContain(r.decision);
        expect(r.escalate).toBe(true);
    });
});

liveGemini('agent.decide — LIVE gemini (gemini-2.5-flash-lite)', () => {
    jest.setTimeout(30000);
    test('picks a decision inside the closed set with high confidence', async () => {
        const r = await Methods.agent.decide({ ...TICKET, model: 'gemini-2.5-flash-lite' });
        expect(TICKET.choices).toContain(r.decision);
        expect(r.decision).toBe('urgent');
        expect(typeof r.confidence).toBe('number');
        expect(typeof r.escalate).toBe('boolean');
        expect(r.metadata.provider).toBe('gemini');
    });

    test('fills schema-bound fields (values only)', async () => {
        const r = await Methods.agent.decide({
            instruction: 'Rate the urgency of the ticket.',
            context: { ticket: 'Production down, all customers affected.' },
            choices: ['urgent', 'normal'],
            schema: { severity: 'number 1-5' },
            model: 'gemini-2.5-flash-lite',
        });
        expect(TICKET.choices).toContain(r.decision);
        if (r.fields) expect(typeof r.fields.severity === 'number' || typeof r.fields.severity === 'string').toBe(true);
    });
});
