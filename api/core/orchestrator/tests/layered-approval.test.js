/**
 * Layered approval (VERSION.md §3.1) — hermetic end-to-end of the HIGH-risk lane.
 *
 * Wires the REAL orchestrator workflow logic (via the harness) to the REAL approval
 * gate logic through a mock relay, plus a keyring that serves public keys (mirroring
 * user.key.public) and produces real Ed25519 signatures. So this exercises:
 *   create → footprint classified HIGH → approve (no sig) opens a gate + returns digest
 *   → approver signs the digest → approve (with sig) → gate verifies → APPROVED
 *   → workflow ACTIVE with a cooling period → runner blocks until effective_at.
 */
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { createHarness } = require('./utils/harness');
const createGate = require('../../../apps/approval/logic/gate');
const { makeFakeRedis: makeApprovalRedis } = require('../../../apps/approval/tests/utils/fake-redis');
const approvalConfig = require('../../../apps/approval/config');

// A keyring: uid -> keypair, plus a getPublic-shaped lookup and a signer.
function makeKeyring() {
    const keys = {};
    return {
        add(uid) {
            const kp = nacl.sign.keyPair();
            keys[uid] = { publicKey: bs58.encode(Buffer.from(kp.publicKey)), secret: kp.secretKey };
            return keys[uid].publicKey;
        },
        sign(uid, digest) {
            return bs58.encode(Buffer.from(nacl.sign.detached(Buffer.from(digest, 'utf8'), keys[uid].secret)));
        },
        getPublic(uid) {
            const k = keys[uid];
            return { uid, publicKey: k ? k.publicKey : null, history: [] };
        },
    };
}

// Bridge orchestrator's relay.call(...) to the in-process approval gate + keyring.
function makeBridgeRelay(gate, ring) {
    return {
        async call(method, params) {
            if (method === 'approval.gate.open') return gate.open(params);
            if (method === 'approval.gate.sign') return gate.sign(params);
            if (method === 'approval.gate.get')  return gate.get(params);
            if (method === 'user.key.public') return ring.getPublic(params.uid);
            throw new Error(`unexpected relay call ${method}`);
        },
    };
}

// A HIGH-risk workflow: contains a write (gateway.email.send).
const highWf = {
    id: 'wf_high',
    category: 'process',
    name: 'High-risk flow',
    desc: 'Sends an email — a write, so it routes to the multi-sig lane.',
    steps: [
        { id: 's1', service: 'user', method: 'user.profile.get', params: { uid: '$input.uid' } },
        { id: 's2', service: 'gateway', method: 'gateway.email.send', params: { to: '$step.s1.result.email' } },
    ],
};

const SUBMITTER = 'uid-sub';
const APPROVER  = 'uid-appr';
const APPROVER2 = 'uid-appr2';

describe('§3.1 layered approval — HIGH-risk multi-sig lane', () => {
    let h, gate, ring, relay;
    beforeEach(async () => {
        ring = makeKeyring();
        gate = createGate(makeApprovalRedis(), { config: approvalConfig, relay: { async call(m, p) { return ring.getPublic(p.uid); } } });
        relay = makeBridgeRelay(gate, ring);
        h = await createHarness({ relay });
    });
    afterEach(() => h.stop());

    test('1-of-1: create HIGH → approve(no sig) gives digest → sign → APPROVED + cooling', async () => {
        ring.add(APPROVER);
        const wf = await h.logic.workflow.create(highWf, SUBMITTER);
        expect(wf.risk_level).toBe('HIGH');
        expect(wf.approval_config.requiredSigners).toBe(1);

        // bare approve → opens a gate, returns the digest to sign (no state change)
        const need = await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        expect(need.status).toBe('NEEDS_SIGNATURE');
        expect(need.gateId).toBeTruthy();
        expect(need.digest).toMatch(/^[0-9a-f]{64}$/);
        expect((await h.logic.workflow.get({ id: wf.id })).status).toBe('PENDING_REVIEW');

        // approver signs the digest, re-submits
        const signature = ring.sign(APPROVER, need.digest);
        const done = await h.logic.workflow.approve({ id: wf.id, signature }, APPROVER);
        expect(done.success).toBe(true);
        expect(done.lane).toBe('multisig');

        const after = await h.logic.workflow.get({ id: wf.id });
        expect(after.status).toBe('ACTIVE');
        expect(after.effective_at).toBeGreaterThan(Date.now());   // cooling period set
        expect(after.approvals[after.approvals.length - 1].approvedBy).toBe(APPROVER);
    });

    test('submitter is rejected up front (orchestrator self-approval ban)', async () => {
        const wf = await h.logic.workflow.create(highWf, SUBMITTER);
        await expect(h.logic.workflow.approve({ id: wf.id }, SUBMITTER))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('a signature over the wrong digest is rejected by the gate', async () => {
        ring.add(APPROVER);
        const wf = await h.logic.workflow.create(highWf, SUBMITTER);
        await h.logic.workflow.approve({ id: wf.id }, APPROVER);   // open gate
        const badSig = ring.sign(APPROVER, 'ff'.repeat(32));        // signs a different digest
        await expect(h.logic.workflow.approve({ id: wf.id, signature: badSig }, APPROVER))
            .rejects.toMatchObject({ code: -32001 });               // INVALID_SIGNATURE from the gate
        expect((await h.logic.workflow.get({ id: wf.id })).status).toBe('PENDING_REVIEW');
    });

    test('cooling period blocks run until effective_at; runs after', async () => {
        ring.add(APPROVER);
        h.mock.on('user.profile.get', () => ({ email: 'a@b.com' }));
        h.mock.on('gateway.email.send', () => ({ delivered: true }));

        const wf = await h.logic.workflow.create(highWf, SUBMITTER);
        const need = await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        await h.logic.workflow.approve({ id: wf.id, signature: ring.sign(APPROVER, need.digest) }, APPROVER);

        // inside the cooling period → run is blocked
        await expect(h.run(wf.id, { uid: 'u1' })).rejects.toMatchObject({ code: -32005 });

        // fast-forward past the cooling period (rewrite effective_at into the past)
        const key = `${h.config.redis.workflowPrefix}${wf.id}`;
        const doc = await h.redis.json.get(key);
        await h.redis.json.set(key, '$', { ...doc, effective_at: Date.now() - 1000 });
        const res = await h.run(wf.id, { uid: 'u1' });
        expect(res.status).toBe('completed');
    });
});

describe('§3.1 layered approval — 2-of-2', () => {
    let h, gate, ring;
    beforeEach(async () => {
        ring = makeKeyring();
        gate = createGate(makeApprovalRedis(), { config: approvalConfig, relay: { async call(m, p) { return ring.getPublic(p.uid); } } });
        h = await createHarness({ relay: makeBridgeRelay(gate, ring) });
        // force 2 signers via config override on the created workflow's approval_config
    });
    afterEach(() => h.stop());

    test('requires two distinct approver signatures before ACTIVE', async () => {
        ring.add(APPROVER); ring.add(APPROVER2);
        // create then bump requiredSigners to 2 by editing the stored doc (simulates config)
        const wf = await h.logic.workflow.create(highWf, SUBMITTER);
        const key = `${h.config.redis.workflowPrefix}${wf.id}`;
        const doc = await h.redis.json.get(key);
        await h.redis.json.set(key, '$', { ...doc, approval_config: { ...doc.approval_config, requiredSigners: 2, coolingMs: 0 } });

        const need = await h.logic.workflow.approve({ id: wf.id }, APPROVER);
        expect(need.required).toBe(2);

        const r1 = await h.logic.workflow.approve({ id: wf.id, signature: ring.sign(APPROVER, need.digest) }, APPROVER);
        expect(r1.status).toBe('AWAITING_SIGNATURES');
        expect(r1.signed).toBe(1);
        expect((await h.logic.workflow.get({ id: wf.id })).status).toBe('PENDING_REVIEW');

        // second distinct approver completes it
        const r2 = await h.logic.workflow.approve({ id: wf.id, signature: ring.sign(APPROVER2, need.digest) }, APPROVER2);
        expect(r2.success).toBe(true);
        expect((await h.logic.workflow.get({ id: wf.id })).status).toBe('ACTIVE');
    });
});

describe('§3.4 external submission surface', () => {
    let h;
    beforeEach(async () => { h = await createHarness(); });
    afterEach(() => h.stop());

    const readOnlyWf = (id) => ({
        id, category: 'process', name: 'ro', desc: 'read-only',
        steps: [{ id: 's1', service: 'planner', method: 'planner.task.list', params: {} }],
    });

    test('admin submitter is NOT rate-limited; external submitter IS', async () => {
        // admin: unthrottled (ctx.isAdmin true) — create well past the limit
        for (let i = 0; i < 12; i++) {
            await h.logic.workflow.create(readOnlyWf(`wfadmin${i}`), 'uid-op', { isAdmin: true });
        }
        // external: limited to 10/hour (config default)
        for (let i = 0; i < 10; i++) {
            await h.logic.workflow.create(readOnlyWf(`wfext${i}`), 'uid-ext', { isAdmin: false });
        }
        await expect(h.logic.workflow.create(readOnlyWf('wfext_over'), 'uid-ext', { isAdmin: false }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('snapshot is trimmed to ACTIVE for external (activeOnly) callers', async () => {
        // one ACTIVE, one PENDING_REVIEW in the snapshot
        await h.seedWorkflow({ id: 'wf_active_cap', category: 'c', name: 'A', desc: 'd', status: 'ACTIVE', steps: [] });
        await h.seedWorkflow({ id: 'wf_pending_cap', category: 'c', name: 'P', desc: 'd', status: 'PENDING_REVIEW', steps: [] });
        await h.logic.workflow.build();

        const full = await h.logic.workflow.getSnapshot({ activeOnly: false });
        const ext  = await h.logic.workflow.getSnapshot({ activeOnly: true });
        const fullIds = full.items.map(i => i.id);
        const extIds = ext.items.map(i => i.id);

        expect(fullIds).toEqual(expect.arrayContaining(['wf_active_cap', 'wf_pending_cap']));
        expect(extIds).toContain('wf_active_cap');
        expect(extIds).not.toContain('wf_pending_cap');   // external never sees pending proposals
    });
});
