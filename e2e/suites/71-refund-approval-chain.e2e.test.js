/**
 * 71 · Refund gated by a SIGNED 3-tier approval chain (governance.md §3, direction 2).
 *
 * Demonstrates that a sensitive BUSINESS operation (collection.payment.refund) cannot
 * fire on one operator's say-so. It requires a confirmed approval.record that:
 *   - walks the full request → verify → confirm state machine,
 *   - is signed at every stage with a real per-user Ed25519 key (user.key.sign),
 *   - by THREE DISTINCT actors (three tiered roles), and
 *   - targets exactly this payment.
 *
 * The refund verifies the approval over the Router (relay → approval.record.get); there is
 * no direct service-to-service call. This is the "approval guards a business flow" proof
 * the user asked for — three role tiers, approving step by step.
 *
 * Full profile only (needs user + collection + approval + bot tokens). E2E_PROFILE=full.
 */
const crypto = require('crypto');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, createAndLogin, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

// Reproduce approval/logic/record.js's digest formula exactly (the signed message).
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPayload = (payload) => sha256(JSON.stringify(payload ?? null));
const stageDigest = (target, stage, payloadHash) => sha256(`${target}\n${stage}\n${payloadHash}`);

const REC  = (id) => `APPROVAL:RECORD:${id}`;
const RECI = 'APPROVAL:RECORD:INDEX';
const PAY  = (id) => `COLLECTION:PAYMENT:${id}`;
const PAYI = 'COLLECTION:PAYMENT:INDEX';

gate('71 · refund gated by a signed 3-tier approval chain', () => {
    let redis;
    let requester, verifier, confirmer;          // the three role tiers
    const sfx = process.pid;
    const roles = [`refund-req-${sfx}`, `refund-ver-${sfx}`, `refund-con-${sfx}`];
    const recIds = [];
    const payIds = [];

    // The payment under refund + the approval chain that authorises it.
    let payId, target, payloadHash, recordId;
    const payload = [{ op: 'UPDATE', field: 'state', oldValue: 'RECEIVED', newValue: 'REFUNDED' }];

    // Sign `digest` as `actor` (their key was generated with actor.password).
    async function sign(actor, digest) {
        return V.assertResult(
            await rpc('user.key.sign', { digest, password: actor.password }, actor.token),
            `sign by ${actor.name}`,
        ).signature;
    }
    async function recordPayment(amount, order) {
        const p = V.assertResult(
            await rpc('collection.payment.record', { amount, currency: 'CNY', orderId: order }, ADMIN_TOKEN),
            'record payment',
        );
        payIds.push(p.id);
        return p;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();

        // Three tiered roles: requester (files) → verifier (approves) → confirmer (releases).
        // Each may run user.key.* (to sign) + read approval records; the chain methods are
        // split one-per-tier so no single role can drive the whole chain. The requester
        // additionally may fire the refund once the chain completes.
        const keyPerm = ['user.key.generate', 'user.key.sign', 'user.key.public'];
        await V.assertResult(await rpc('user.role.set', { role: roles[0], scope: 'internal',
            services: { approval: ['approval.record.request', 'approval.record.get'], collection: ['collection.payment.refund'], user: keyPerm } }, ADMIN_TOKEN), 'role req');
        await V.assertResult(await rpc('user.role.set', { role: roles[1], scope: 'internal',
            services: { approval: ['approval.record.verify', 'approval.record.get'], user: keyPerm } }, ADMIN_TOKEN), 'role ver');
        await V.assertResult(await rpc('user.role.set', { role: roles[2], scope: 'internal',
            services: { approval: ['approval.record.confirm', 'approval.record.get'], user: keyPerm } }, ADMIN_TOKEN), 'role con');

        requester = await createAndLogin({ name: `req-${sfx}` });
        verifier  = await createAndLogin({ name: `ver-${sfx}` });
        confirmer = await createAndLogin({ name: `con-${sfx}` });

        await rpc('user.role.assign', { uid: requester.uid, role: roles[0] }, ADMIN_TOKEN);
        await rpc('user.role.assign', { uid: verifier.uid,  role: roles[1] }, ADMIN_TOKEN);
        await rpc('user.role.assign', { uid: confirmer.uid, role: roles[2] }, ADMIN_TOKEN);

        // Each tier provisions its own signing key (self-only; the password is theirs).
        for (const a of [requester, verifier, confirmer]) {
            V.assertResult(await rpc('user.key.generate', { password: a.password }, a.token), `keygen ${a.name}`);
        }
    }, 60_000);

    afterAll(async () => {
        if (!redis) return;
        for (const id of recIds) { await redis.del(REC(id)); await redis.sRem(RECI, id); }
        for (const id of payIds) { await redis.del(PAY(id)); await redis.sRem(PAYI, id); }
        for (const r of roles)   { await redis.del(`USER:ROLE:${r}`); await redis.sRem('USER:ROLE:IDS', r); }
        for (const a of [requester, verifier, confirmer]) {
            if (!a) continue;
            await redis.del(`USER:SIGNKEY:${a.uid}`);
            await cleanupUser(redis, a);
        }
        await redis.quit();
    });

    test('a payment exists; refund is refused before any approval (fail-closed)', async () => {
        const p = await recordPayment(500, `ord-${sfx}`);
        payId = p.id;
        target = `collection-payment-${payId}`;
        payloadHash = hashPayload(payload);
        expect(p.state).toBe('RECEIVED');
        // No approval at all → a bogus id must be refused as a failed gate (FORBIDDEN), not a 500.
        V.assertRpcError(await rpc('collection.payment.refund', { id: payId, approvalId: `none-${sfx}` }, requester.token), -32005, 'refund without approval');
    });

    test('tier-1 requester files a SIGNED request → INIT', async () => {
        const sig = await sign(requester, stageDigest(target, 'request', payloadHash));
        const rec = V.assertResult(await rpc('approval.record.request', { target, payload, signature: sig }, requester.token), 'request');
        recordId = rec.id; recIds.push(rec.id);
        expect(rec.state).toBe('INIT');
        expect(rec.evidence[0]).toMatchObject({ stage: 'request', actor: requester.uid, method: 'solana:ed25519' });
        expect(rec.evidence[0].signature).toBeTruthy();
        await V.assertRecord(redis, REC(recordId), { state: 'INIT' }, { indexKey: RECI });
    });

    test('refund still refused: approval is only INIT, not DONE', async () => {
        V.assertRpcError(await rpc('collection.payment.refund', { id: payId, approvalId: recordId }, requester.token), -32005, 'refund on INIT approval');
    });

    test('applicant cannot self-verify (separation of duties)', async () => {
        const sig = await sign(requester, stageDigest(target, 'verify', payloadHash));
        V.assertRpcError(await rpc('approval.record.verify', { id: recordId, signature: sig }, requester.token), -32005, 'self-verify');
    });

    test('a signature over the wrong stage is rejected', async () => {
        // verifier signs the CONFIRM digest but calls verify → digest mismatch → invalid signature.
        const wrong = await sign(verifier, stageDigest(target, 'confirm', payloadHash));
        V.assertRpcError(await rpc('approval.record.verify', { id: recordId, signature: wrong }, verifier.token), -32001, 'wrong-stage signature');
    });

    test('tier-2 verifier approves (signed) → DISPATCHED', async () => {
        const sig = await sign(verifier, stageDigest(target, 'verify', payloadHash));
        V.assertResult(await rpc('approval.record.verify', { id: recordId, signature: sig }, verifier.token), 'verify');
        await V.assertRecord(redis, REC(recordId), { state: 'DISPATCHED' });
    });

    test('tier-3 confirmer releases (signed) → DONE; 3 distinct, all-signed stages', async () => {
        const sig = await sign(confirmer, stageDigest(target, 'confirm', payloadHash));
        const done = V.assertResult(await rpc('approval.record.confirm', { id: recordId, signature: sig }, confirmer.token), 'confirm');
        expect(done.state).toBe('DONE');
        expect(done.evidence.map((e) => e.stage)).toEqual(['request', 'verify', 'confirm']);
        expect(done.evidence.map((e) => e.actor)).toEqual([requester.uid, verifier.uid, confirmer.uid]);
        expect(done.evidence.every((e) => e.method === 'solana:ed25519' && e.signature)).toBe(true);
    });

    test('refund now succeeds → payment REFUNDED, stamped with the approval id', async () => {
        const r = V.assertResult(await rpc('collection.payment.refund', { id: payId, approvalId: recordId }, requester.token), 'refund');
        expect(r.state).toBe('REFUNDED');
        expect(r.approvalId).toBe(recordId);
        await V.assertRecord(redis, PAY(payId), { state: 'REFUNDED' }, { indexKey: PAYI });
    });

    test('refund is idempotent (a second call returns the REFUNDED payment, no error)', async () => {
        const r = V.assertResult(await rpc('collection.payment.refund', { id: payId, approvalId: recordId }, requester.token), 'refund again');
        expect(r.state).toBe('REFUNDED');
    });

    test('the approval is bound to its payment: a different payment cannot reuse it', async () => {
        const p2 = await recordPayment(700, `ord2-${sfx}`);
        // approval.target = collection-payment-{payId} ≠ collection-payment-{p2.id} → FORBIDDEN.
        V.assertRpcError(await rpc('collection.payment.refund', { id: p2.id, approvalId: recordId }, requester.token), -32005, 'approval target mismatch');
    });

    test('no real (-32603) errors surfaced in approval/collection', async () => {
        await V.assertNoErrors(redis, ['approval', 'collection']);
    });
});
