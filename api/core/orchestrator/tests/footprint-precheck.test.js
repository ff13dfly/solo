/**
 * H6 — Footprint pre-check tests (AUDIT H6)
 *
 * Verifies that orchestrator.workflow.run enforces permit coverage over the
 * ENTIRE method footprint (all steps + resolvers) BEFORE any step executes.
 *
 * All downstream methods (ledger.transfer, mail.send, bank.dispatch, …) are
 * fictitious — MockRouter stubs them. No real services required. The critical
 * assertion is always: "how many downstream calls were made before the 403?"
 * Answer must be zero — the pre-check fires before any step.
 *
 * Permit structure tested (Router full object, fetched via user.permit.get):
 *   { allow_all: bool, services: { [svc]: [method|'*'] } }
 */
const { createHarness } = require('./utils/harness');
const workflow        = require('./cases/footprint-workflow.json');
const branchWorkflow  = require('./cases/footprint-branching-workflow.json');

// Permit helpers — mirrors Router's checkPermission contract (see library/permit.js)
const ADMIN_PERMIT       = { allow_all: true };
const FULL_PERMIT        = { allow_all: false, services: { ledger: ['ledger.transfer'], mail: ['mail.send'] } };
const PARTIAL_PERMIT     = { allow_all: false, services: { ledger: ['ledger.transfer'] } }; // missing mail
const EMPTY_PERMIT       = { allow_all: false, services: {} };
const BRANCH_FULL_PERMIT = { allow_all: false, services: { ledger: ['ledger.transfer'], bank: ['bank.dispatch'] } };
const BRANCH_PARTIAL     = { allow_all: false, services: { ledger: ['ledger.transfer'] } }; // missing bank

const CALLER = 'uid-test-caller';

describe('H6 — footprint pre-check', () => {
    let h;

    beforeEach(async () => {
        h = await createHarness();
        // Stub business steps so execution can succeed when permit is sufficient
        h.mock.on('ledger.transfer', () => ({ approved: true, txId: 'tx-1' }));
        h.mock.on('mail.send',       () => ({ delivered: true }));
        h.mock.on('bank.dispatch',   () => ({ ref: 'abc' }));
    });
    afterEach(() => h.stop());

    // ── 1. Rejection paths (security-critical) ─────────────────────────────

    test('partial permit → 403 BEFORE any step executes', async () => {
        h.mock.on('user.permit.get', () => PARTIAL_PERMIT);
        await h.seedWorkflow(workflow);

        await expect(h.run(workflow.id, {}, {}, CALLER))
            .rejects.toMatchObject({ code: -32005 });

        // user.permit.get was called; no business step was touched
        expect(h.mock.count('user.permit.get')).toBe(1);
        expect(h.mock.count('ledger.transfer')).toBe(0);
        expect(h.mock.count('mail.send')).toBe(0);
    });

    test('empty permit → 403 BEFORE any step executes', async () => {
        h.mock.on('user.permit.get', () => EMPTY_PERMIT);
        await h.seedWorkflow(workflow);

        await expect(h.run(workflow.id, {}, {}, CALLER))
            .rejects.toMatchObject({ code: -32005 });

        expect(h.mock.count('ledger.transfer')).toBe(0);
        expect(h.mock.count('mail.send')).toBe(0);
    });

    test('403 error message lists the missing methods', async () => {
        h.mock.on('user.permit.get', () => PARTIAL_PERMIT); // mail.send missing
        await h.seedWorkflow(workflow);

        const err = await h.run(workflow.id, {}, {}, CALLER).catch(e => e);
        expect(err.message).toMatch(/mail\.send/);
        expect(err.message).toMatch(/footprint/i);
    });

    test('branch-conditional method is in footprint even if condition never triggers', async () => {
        // s2 (bank.dispatch) runs only when s1.approved === true.
        // The pre-check must include it anyway — richer footprint is the safe choice.
        h.mock.on('user.permit.get', () => BRANCH_PARTIAL); // bank missing
        await h.seedWorkflow(branchWorkflow);

        await expect(h.run(branchWorkflow.id, {}, {}, CALLER))
            .rejects.toMatchObject({ code: -32005 });

        expect(h.mock.count('ledger.transfer')).toBe(0);
        expect(h.mock.count('bank.dispatch')).toBe(0);
    });

    // ── 2. Pass-through paths ──────────────────────────────────────────────

    test('full permit → pre-check passes, all steps execute', async () => {
        h.mock.on('user.permit.get', () => FULL_PERMIT);
        await h.seedWorkflow(workflow);

        const res = await h.run(workflow.id, {}, {}, CALLER);
        expect(res.status).toBe('completed');
        expect(res.trace.map(t => t.status)).toEqual(['success', 'success']);
    });

    test('admin permit (allow_all:true) → pre-check skipped, all steps execute', async () => {
        h.mock.on('user.permit.get', () => ADMIN_PERMIT);
        await h.seedWorkflow(workflow);

        const res = await h.run(workflow.id, {}, {}, CALLER);
        expect(res.status).toBe('completed');
        // user.permit.get WAS called (we still fetch — allow_all is evaluated inside coversAll)
        expect(h.mock.count('user.permit.get')).toBe(1);
        expect(h.mock.count('ledger.transfer')).toBe(1);
        expect(h.mock.count('mail.send')).toBe(1);
    });

    test('wildcard service permit → pre-check passes', async () => {
        const wildcardPermit = { allow_all: false, services: { ledger: ['*'], mail: ['*'] } };
        h.mock.on('user.permit.get', () => wildcardPermit);
        await h.seedWorkflow(workflow);

        const res = await h.run(workflow.id, {}, {}, CALLER);
        expect(res.status).toBe('completed');
    });

    test('branch workflow: full permit including branch method → pre-check passes', async () => {
        h.mock.on('user.permit.get', () => BRANCH_FULL_PERMIT);
        h.mock.on('ledger.transfer', () => ({ approved: true }));
        await h.seedWorkflow(branchWorkflow);

        // Pre-check passes (caller has both ledger + bank permits); execution proceeds.
        const res = await h.run(branchWorkflow.id, {}, {}, CALLER);
        expect(res.status).toBe('completed');
    });

    // ── 3. No-callerUid path (Router already filtered; pre-check skipped) ──

    test('no callerUid → pre-check skipped entirely, user.permit.get never called', async () => {
        // Even with an empty permit stub, if callerUid is null the pre-check
        // doesn't run — Router already blocked unauthenticated callers.
        h.mock.on('user.permit.get', () => EMPTY_PERMIT);
        await h.seedWorkflow(workflow);

        // Run WITHOUT callerUid (4th param omitted = null)
        const res = await h.run(workflow.id, {});
        expect(res.status).toBe('completed');
        expect(h.mock.count('user.permit.get')).toBe(0); // never fetched
    });

    // ── 4. Error propagation ────────────────────────────────────────────────

    test('user.permit.get fails → internal error (not 403)', async () => {
        h.mock.on('user.permit.get', () => { throw new Error('user service down'); });
        await h.seedWorkflow(workflow);

        const err = await h.run(workflow.id, {}, {}, CALLER).catch(e => e);
        // Should be INTERNAL_ERROR (-32603), not FORBIDDEN (-32003)
        expect(err.code).toBe(-32603);
        expect(h.mock.count('ledger.transfer')).toBe(0);
    });
});
