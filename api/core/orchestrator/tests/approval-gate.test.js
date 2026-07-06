/**
 * C1 + C2 + C5 — Approval gate tests
 *
 * C1: workflow.create → PENDING_REVIEW; approve/deny methods; self-approval ban
 * C2: workflow.run rejects any status ≠ ACTIVE
 * C5: workflow.restore → PENDING_REVIEW (not ACTIVE)
 *
 * All tests use the harness (real logic + MockRouter + fakeRedis).
 * No real services required.
 */
const { createHarness } = require('./utils/harness');
const base = require('./cases/linear-flow.json');

// §3.1 — linear-flow contains gateway.email.send (a WRITE) → HIGH risk, which routes
// to the multi-sig lane. The C1 fast-lane mechanics below (self-approval ban, dedup,
// single-sign flip) are about LOW-risk workflows, so use a read-only fixture for them.
// (HIGH multi-sig is covered in layered-approval.test.js.)
const lowBase = {
    id: 'wf_quiet',
    category: 'process',
    name: 'Read-only demo',
    desc: 'Two read steps — no side effects, so it stays in the C1 fast lane.',
    steps: [
        { id: 's1', service: 'user', method: 'user.profile.get', params: { uid: '$input.customerId' } },
        { id: 's2', service: 'planner', method: 'planner.task.list', params: {} },
    ],
};

// Distinct UIDs for submitter / approver
const SUBMITTER = 'uid-submitter';
const APPROVER  = 'uid-approver';
const APPROVER2 = 'uid-approver-2';

describe('C1 — create → PENDING_REVIEW', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('create() sets status PENDING_REVIEW, not ACTIVE', async () => {
        const wf = await h.logic.workflow.create(base, SUBMITTER);
        expect(wf.status).toBe('PENDING_REVIEW');
        expect(wf.submittedBy).toBe(SUBMITTER);
        expect(wf.approvals).toEqual([]);
    });

    test('create() without callerUid still lands in PENDING_REVIEW', async () => {
        const wf = await h.logic.workflow.create(base);
        expect(wf.status).toBe('PENDING_REVIEW');
        expect(wf.submittedBy).toBeNull();
    });
});

describe('C1 — approve', () => {
    let h;
    // A minimal relay so the HIGH-risk branch can open a gate (no signing in these tests).
    const stubRelay = { async call(method) { if (method === 'approval.gate.open') return { id: 'gate-stub' }; throw new Error(`unexpected ${method}`); } };
    beforeEach(async () => { h = await createHarness({ relay: stubRelay }); });
    afterEach(() => h.stop());

    test('LOW-risk approve by a different user → ACTIVE (C1 fast lane)', async () => {
        const wf = await h.logic.workflow.create(lowBase, SUBMITTER);
        expect(wf.risk_level).toBe('LOW');
        const result = await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        expect(result.lane).toBe('C1');
        expect(result.workflow.status).toBe('ACTIVE');
        expect(result.workflow.approvals[0].approvedBy).toBe(APPROVER);
    });

    test('self-approval ban: submitter cannot approve their own workflow', async () => {
        const wf = await h.logic.workflow.create(lowBase, SUBMITTER);
        await expect(h.logic.workflow.approve({ id: wf.id }, SUBMITTER))
            .rejects.toMatchObject({ code: -32005 });
        // Workflow stays PENDING_REVIEW
        const after = await h.logic.workflow.get({ id: wf.id });
        expect(after.status).toBe('PENDING_REVIEW');
    });

    test('duplicate approval by same uid is rejected', async () => {
        const wf = await h.logic.workflow.create(lowBase, SUBMITTER);
        await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        // Already ACTIVE, but also deduplicated
        await expect(h.logic.workflow.approve({ id: wf.id }, APPROVER))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('cannot approve a REJECTED or ACTIVE workflow', async () => {
        const wf = await h.logic.workflow.create(lowBase, SUBMITTER);
        await h.logic.workflow.deny({ id: wf.id }, APPROVER);
        await expect(h.logic.workflow.approve({ id: wf.id }, APPROVER2))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('HIGH-risk workflow does NOT flip ACTIVE on a bare approve (routes to multi-sig)', async () => {
        const wf = await h.logic.workflow.create(base, SUBMITTER);   // base has gateway.email.send → HIGH
        expect(wf.risk_level).toBe('HIGH');
        const res = await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        expect(res.status).toBe('NEEDS_SIGNATURE');
        expect(res.lane).toBe('multisig');
        const after = await h.logic.workflow.get({ id: wf.id });
        expect(after.status).toBe('PENDING_REVIEW');   // stays pending until signed
    });
});

describe('C1 — deny', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('deny → REJECTED with reason recorded', async () => {
        const wf = await h.logic.workflow.create(base, SUBMITTER);
        const result = await h.logic.workflow.deny({ id: wf.id, reason: 'insufficient review' }, APPROVER);
        expect(result.workflow.status).toBe('REJECTED');
        expect(result.workflow.deniedBy).toBe(APPROVER);
        expect(result.workflow.denialReason).toBe('insufficient review');
    });

    test('cannot deny an ACTIVE workflow', async () => {
        const wf = await h.logic.workflow.create(lowBase, SUBMITTER);   // LOW → C1 approve flips ACTIVE
        await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        await expect(h.logic.workflow.deny({ id: wf.id }, APPROVER2))
            .rejects.toMatchObject({ code: -32005 });
    });
});

describe('C2 — run rejects non-ACTIVE status', () => {
    let h;
    beforeEach(async () => {
        h = await createHarness();
        h.mock.onAny(() => ({}));
    });
    afterEach(() => h.stop());

    test('PENDING_REVIEW → run → FORBIDDEN', async () => {
        const wf = await h.logic.workflow.create(base, SUBMITTER);
        await expect(h.run(wf.id)).rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count()).toBe(0); // no downstream calls
    });

    test('REJECTED → run → FORBIDDEN', async () => {
        const wf = await h.logic.workflow.create(base, SUBMITTER);
        await h.logic.workflow.deny({ id: wf.id }, APPROVER);
        await expect(h.run(wf.id)).rejects.toMatchObject({ code: -32005 });
    });

    test('DELETED → run → FORBIDDEN', async () => {
        await h.seedWorkflow({ ...base, id: 'wf_drop_test', status: 'DELETED' });
        await expect(h.run('wf_drop_test')).rejects.toMatchObject({ code: -32005 });
    });

    test('ACTIVE → run → executes normally', async () => {
        h.mock.on('user.profile.get', () => ({ uid: 'c-1', name: 'A', email: 'a@b.com' }));
        h.mock.on('gateway.email.send', () => ({ delivered: true }));
        // base is HIGH-risk (multi-sig); this test is about "ACTIVE runs", so seed ACTIVE directly.
        await h.seedWorkflow({ ...base, id: 'wf_active_run', status: 'ACTIVE' });
        const res = await h.run('wf_active_run', { customerId: 'c-1' });
        expect(res.status).toBe('completed');
    });
});

describe('C5 — restore → PENDING_REVIEW', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('restore from DELETED → PENDING_REVIEW (not ACTIVE)', async () => {
        await h.seedWorkflow({ ...base, id: 'wf_r1', status: 'DELETED' });
        const result = await h.logic.workflow.restore({ id: 'wf_r1' });
        expect(result.workflow.status).toBe('PENDING_REVIEW');
        expect(result.workflow.approvals).toEqual([]);
    });

    test('restore from REJECTED → PENDING_REVIEW', async () => {
        const wf = await h.logic.workflow.create(base, SUBMITTER);
        await h.logic.workflow.deny({ id: wf.id }, APPROVER);
        const result = await h.logic.workflow.restore({ id: wf.id });
        expect(result.workflow.status).toBe('PENDING_REVIEW');
        expect(result.workflow.approvals).toEqual([]);
    });

    test('restore an already-ACTIVE workflow is a no-op', async () => {
        await h.seedWorkflow({ ...base, id: 'wf_r2', status: 'ACTIVE' });
        const result = await h.logic.workflow.restore({ id: 'wf_r2' });
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/ACTIVE/);
    });

    test('restored workflow cannot run until re-approved', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow({ ...base, id: 'wf_r3', status: 'DELETED' });
        await h.logic.workflow.restore({ id: 'wf_r3' });
        await expect(h.run('wf_r3')).rejects.toMatchObject({ code: -32005 });
    });
});

// P1 (v1-implementation-plan.md, decided 2026-07-05): deprecate() gives "retire a live
// workflow" its own status + audit trail, distinct from delete()'s "discard a draft".
// Reactivation always goes through restore() → PENDING_REVIEW — full re-approval, no
// lightweight/time-windowed shortcut.
describe('P1 — deprecate/reactivate lifecycle', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    test('deprecate() ACTIVE → DEPRECATED, records who/when', async () => {
        await h.seedWorkflow({ ...base, id: 'wf_dep1', status: 'ACTIVE' });
        const result = await h.logic.workflow.deprecate({ id: 'wf_dep1' }, APPROVER);
        expect(result.success).toBe(true);
        expect(result.workflow.status).toBe('DEPRECATED');
        expect(result.workflow.deprecatedBy).toBe(APPROVER);
        expect(typeof result.workflow.deprecatedAt).toBe('number');
    });

    test.each(['PENDING_REVIEW', 'REJECTED', 'DELETED', 'DEPRECATED'])(
        'cannot deprecate a workflow already in %s',
        async (status) => {
            await h.seedWorkflow({ ...base, id: `wf_depbad_${status}`, status });
            await expect(h.logic.workflow.deprecate({ id: `wf_depbad_${status}` }))
                .rejects.toMatchObject({ code: -32005 });
        }
    );

    test('DEPRECATED → run → FORBIDDEN (same C2 gate as any non-ACTIVE status)', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow({ ...base, id: 'wf_dep2', status: 'DEPRECATED' });
        await expect(h.run('wf_dep2')).rejects.toMatchObject({ code: -32005 });
        expect(h.mock.count()).toBe(0);
    });

    test('restore() from DEPRECATED → PENDING_REVIEW, clears deprecation fields, cannot run until re-approved', async () => {
        h.mock.onAny(() => ({}));
        await h.seedWorkflow({ ...base, id: 'wf_dep3', status: 'DEPRECATED', deprecatedAt: 111, deprecatedBy: APPROVER });
        const result = await h.logic.workflow.restore({ id: 'wf_dep3' });
        expect(result.workflow.status).toBe('PENDING_REVIEW');
        expect(result.workflow.approvals).toEqual([]);
        expect(result.workflow.deprecatedAt).toBeUndefined();
        expect(result.workflow.deprecatedBy).toBeUndefined();
        await expect(h.run('wf_dep3')).rejects.toMatchObject({ code: -32005 });
    });

    test('update() rejects edits to a DEPRECATED workflow (frozen like DELETED)', async () => {
        await h.seedWorkflow({ ...base, id: 'wf_dep4', status: 'DEPRECATED' });
        await expect(h.logic.workflow.update({ id: 'wf_dep4', name: 'renamed' }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('list() shows DEPRECATED by default, unlike DELETED', async () => {
        await h.seedWorkflow({ ...base, id: 'wf_dep5', status: 'DEPRECATED' });
        await h.seedWorkflow({ ...base, id: 'wf_dep5b', status: 'DELETED' });
        const { items } = await h.logic.workflow.list({});
        const ids = items.map(w => w.id);
        expect(ids).toContain('wf_dep5');
        expect(ids).not.toContain('wf_dep5b');
    });
});

// §7.4 — approve-time compensation-interface existence check (against system:capability:list).
// A compensate step whose downstream method exists in no active service is a rollback that
// can't run (fail-closed); a missing FORWARD method only warns. All-read footprints stay LOW
// → C1 fast lane, so no relay is needed.
describe('§7.4 — compensation interface existence at approve', () => {
    let h;
    // A Saga workflow (declares `compensate`) classifies HIGH → multi-sig lane, so a stub
    // relay lets approve reach the lane. §7.4 runs BEFORE the lane, so its reject fires
    // regardless; "passed §7.4" = the approve reached its lane (ACTIVE or NEEDS_SIGNATURE)
    // instead of throwing the compensation error.
    const stubRelay = { async call(method) { if (method === 'approval.gate.open') return { id: 'gate-stub' }; throw new Error(`unexpected ${method}`); } };
    const passedPrecheck = (res) => res && (res.workflow?.status === 'ACTIVE' || res.status === 'NEEDS_SIGNATURE');
    const CATALOG = JSON.stringify({ 'user.profile.get': { service: 'user' } });
    const sagaWf = (id, undoMethod) => ({
        id, category: 'ops', name: 'saga', desc: 'compensation precheck',
        steps: [
            { id: 'act',  service: 'user', method: 'user.profile.get', params: { id: 'u1' }, compensate: 'undo' },
            { id: 'undo', service: 'user', method: undoMethod,          params: { id: 'u1' } },
        ],
    });
    beforeEach(async () => { h = await createHarness({ relay: stubRelay }); await h.redis.set('system:capability:list', CATALOG); });
    afterEach(() => h.stop());

    test('reject: compensate method absent from the catalog → approve rejected, stays PENDING_REVIEW', async () => {
        const wf = await h.logic.workflow.create(sagaWf('wf_comp_bad', 'user.profile.ghost'), SUBMITTER);
        await expect(h.logic.workflow.approve({ id: wf.id }, APPROVER))
            .rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/Saga rollback cannot run/i) });
        expect((await h.logic.workflow.get({ id: wf.id })).status).toBe('PENDING_REVIEW');
    });

    test('pass: compensate method present in the catalog → approve proceeds past §7.4', async () => {
        const wf = await h.logic.workflow.create(sagaWf('wf_comp_ok', 'user.profile.get'), SUBMITTER);
        expect(passedPrecheck(await h.logic.workflow.approve({ id: wf.id }, APPROVER))).toBe(true);
    });

    test('forward (non-compensate) method missing → warns only, does NOT block approval', async () => {
        const wf = await h.logic.workflow.create({
            id: 'wf_fwd_missing', category: 'ops', name: 'x', desc: 'x',
            steps: [{ id: 's1', service: 'user', method: 'user.profile.ghost', params: {} }],
        }, SUBMITTER);
        // single read step, no compensate → LOW → C1 → ACTIVE; the missing forward method only warns
        expect(passedPrecheck(await h.logic.workflow.approve({ id: wf.id }, APPROVER))).toBe(true);
    });

    test('catalog unavailable → §7.4 skipped (a bad compensate is not blocked)', async () => {
        await h.redis.set('system:capability:list', '');   // empty → loadCapabilityCatalog returns null
        const wf = await h.logic.workflow.create(sagaWf('wf_comp_skip', 'user.profile.ghost'), SUBMITTER);
        expect(passedPrecheck(await h.logic.workflow.approve({ id: wf.id }, APPROVER))).toBe(true);
    });
});
