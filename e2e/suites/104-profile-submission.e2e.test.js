/**
 * 104 · fulfillment profile 投稿面 (submission lane) — AI/external authoring → human approval.
 *
 * The missing governance puzzle piece (§7.3): a distributed SOLO can take fulfillment
 * profiles from an UNTRUSTED submitter (external AI / extending developer) through
 * lint → PENDING_REVIEW → signed-off approval → ACTIVE, instead of trusting direct create.
 * Mirrors the orchestrator workflow C1 lane.
 *
 * Asserts the four governance properties:
 *   1. submit is lint-gated — a structurally-broken profile never enters the review queue.
 *   2. a PENDING_REVIEW profile is NOT usable (instances can't be created on it).
 *   3. separation of duties — the submitter cannot self-activate; approval needs a different,
 *      admin identity; a non-admin submitter is blocked from approve entirely.
 *   4. after approval the profile is usable and actually drives an order.
 *
 * No "dirty data" injection needed: the negative paths are crafted INVALID SUBMISSIONS
 * (normal RPC calls with non-compliant profiles) — the lint + activation gates are the
 * defense, and we exercise them with adversarial-but-well-formed inputs.
 *
 * full profile only (needs fulfillment + market + Router _task dispatch).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, sessionUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = process.pid;

const { WL_KEY, TASK_WHITELIST_SUPERSET } = require('../lib/whitelist');
const CLEAN_ID = `sub-clean-${PID}`;
const BAD_ID = `sub-bad-${PID}`;
const REJ_ID = `sub-rej-${PID}`;
const SELF_ID = `sub-self-${PID}`;
const FRZ_ID = `sub-frz-${PID}`;
const INF_ID = `sub-inf-${PID}`;

// A lint-clean order-flow profile (DRAFT→PAID via the real market.order.pay).
const cleanProfile = (id) => ({
    id, name: id,
    transitions: [
        { event: 'pay', from: 'DRAFT', to: 'PAID', condition: null,
          actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
    ],
});
// Same shape but a hallucinated action method — must be rejected at the lint gate (rule 4).
const badProfile = (id) => { const p = cleanProfile(id); p.transitions[0].actions[0].method = 'market.order.payy'; return p; };

gate('104 · fulfillment profile submission lane (submit → review → approve)', () => {
    let redis, prevWhitelist, submitter, orderId, instanceId;
    const extraOrders = [], extraInstances = [];

    beforeAll(async () => {
        redis = await redisLib.connect();
        prevWhitelist = await redis.get(WL_KEY);
        // Shared superset (seeded at harness boot) — value never flips → no §5.6③ cache race.
        await redis.set(WL_KEY, JSON.stringify(TASK_WHITELIST_SUPERSET));
        // an UNTRUSTED submitter: permit allows ONLY profile.submit (can propose, never activate)
        submitter = await sessionUser(redis, `submitter-${PID}`, { fulfillment: ['fulfillment.profile.submit'] });
    }, 40_000);

    afterAll(async () => {
        if (!redis) return;
        if (prevWhitelist) await redis.set(WL_KEY, prevWhitelist); else await redis.del(WL_KEY);
        for (const id of [CLEAN_ID, BAD_ID, REJ_ID, SELF_ID, FRZ_ID, INF_ID]) {
            await redis.del(`FULFILLMENT:PROFILE:${id}`); await redis.sRem('FULFILLMENT:PROFILE:INDEX', id);
        }
        for (const iid of [instanceId, ...extraInstances].filter(Boolean)) { await redis.del(`FULFILLMENT:INSTANCE:${iid}`); await redis.sRem('FULFILLMENT:INSTANCE:INDEX', iid); }
        for (const oid of [orderId, ...extraOrders].filter(Boolean)) { await redis.del(`MARKET:ORDER:${oid}`); await redis.sRem('MARKET:ORDER:INDEX', oid); }
        if (submitter?.uid) await redis.del(`USER:${submitter.uid}`).catch(() => {});
        await redis.quit();
    }, 30_000);

    // 1 — lint gate: a broken submission never enters the queue.
    test('submit a lint-violating profile → rejected at the gate, nothing stored', async () => {
        const r = V.assertResult(await rpc('fulfillment.profile.submit', badProfile(BAD_ID), submitter.token), 'submit(bad)');
        expect(r.ok).toBe(false);
        expect(r.lintReport.errors.join('\n')).toMatch(/market\.order\.payy/);
        const got = await rpc('fulfillment.profile.get', { id: BAD_ID }, ADMIN_TOKEN);
        expect(got.error).toBeTruthy();                              // NOT_FOUND — never created
    });

    // 2 — submit clean → PENDING_REVIEW, and it is NOT usable yet.
    test('submit a clean profile → PENDING_REVIEW; instances cannot be created on it', async () => {
        const r = V.assertResult(await rpc('fulfillment.profile.submit', cleanProfile(CLEAN_ID), submitter.token), 'submit(clean)');
        expect(r.ok).toBe(true);
        expect(r.reviewState).toBe('PENDING_REVIEW');

        const p = V.assertResult(await rpc('fulfillment.profile.get', { id: CLEAN_ID }, ADMIN_TOKEN), 'profile.get');
        expect(p.reviewState).toBe('PENDING_REVIEW');
        expect(p.submittedBy).toBe(submitter.uid);

        const order = V.assertResult(await rpc('market.order.create', { orderRef: `sub-${PID}`, amount: 5000, currency: 'CNY' }, ADMIN_TOKEN), 'order.create');
        orderId = order.id;
        const blocked = await rpc('fulfillment.instance.create', { sourceId: orderId, profileId: CLEAN_ID, meta: { orderId } }, ADMIN_TOKEN);
        expect(blocked.error).toBeTruthy();
        expect(blocked.error.message).toMatch(/not activated/);
    });

    // 3 — separation of duties: the submitter cannot approve (not admin / lacks the permit).
    test('the submitter cannot approve its own submission', async () => {
        const denied = await rpc('fulfillment.profile.approve', { id: CLEAN_ID }, submitter.token);
        expect(denied.error).toBeTruthy();                          // Router checkAccess blocks (no approve permit)
        const p = V.assertResult(await rpc('fulfillment.profile.get', { id: CLEAN_ID }, ADMIN_TOKEN), 'still pending');
        expect(p.reviewState).toBe('PENDING_REVIEW');
    });

    // 4 — admin (≠ submitter) approves → APPROVED → now usable, and it drives the order.
    test('admin approves → APPROVED → instances work and pay drives the order to PAID', async () => {
        const approved = V.assertResult(await rpc('fulfillment.profile.approve', { id: CLEAN_ID }, ADMIN_TOKEN), 'approve');
        expect(approved.reviewState).toBe('APPROVED');

        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: orderId, profileId: CLEAN_ID, meta: { orderId } }, ADMIN_TOKEN), 'instance.create');
        instanceId = inst.id;
        expect(inst.state).toBe('DRAFT');

        const paid = V.assertResult(await rpc('fulfillment.instance.transition', { id: instanceId, event: 'pay' }, ADMIN_TOKEN), 'transition(pay)');
        expect(paid.state).toBe('PAID');
        let order = null;
        // 90s headroom (load-resilient): the pay _task → market order chain lags under full-run load.
        for (let i = 0; i < 180; i++) { order = (await rpc('market.order.get', { id: orderId }, ADMIN_TOKEN)).result; if (order?.state === 'PAID') break; await sleep(500); }
        expect(order?.state).toBe('PAID');
    }, 120_000);

    // 5 — reject path: a rejected profile stays unusable.
    test('reject a PENDING_REVIEW profile → REJECTED → still not usable', async () => {
        const r = V.assertResult(await rpc('fulfillment.profile.submit', cleanProfile(REJ_ID), submitter.token), 'submit(rej)');
        expect(r.ok).toBe(true);
        const rejected = V.assertResult(await rpc('fulfillment.profile.reject', { id: REJ_ID, reason: 'not this time' }, ADMIN_TOKEN), 'reject');
        expect(rejected.reviewState).toBe('REJECTED');
        const blocked = await rpc('fulfillment.instance.create', { sourceId: orderId, profileId: REJ_ID, meta: { orderId } }, ADMIN_TOKEN);
        expect(blocked.error).toBeTruthy();
        expect(blocked.error.message).toMatch(/not activated/);
    });

    // 6 — self-approval is blocked even for an admin (separation of duties is intrinsic).
    test('an admin who submitted cannot self-approve (approver ≠ submitter)', async () => {
        const r = V.assertResult(await rpc('fulfillment.profile.submit', cleanProfile(SELF_ID), ADMIN_TOKEN), 'submit(self)');
        expect(r.ok).toBe(true);
        const denied = await rpc('fulfillment.profile.approve', { id: SELF_ID }, ADMIN_TOKEN);
        expect(denied.error).toBeTruthy();
        expect(denied.error.message).toMatch(/same as the submitter/);
    });

    // 7 — INTEGRITY: an executable edit of an APPROVED profile re-opens review (it can't be
    //     silently mutated to bypass approval); metadata edits don't; approval binds a digest.
    test('executable edit on APPROVED → re-review + frozen + new digest; metadata edit stays APPROVED', async () => {
        V.assertResult(await rpc('fulfillment.profile.submit', cleanProfile(FRZ_ID), submitter.token), 'submit(frz)');
        const approved = V.assertResult(await rpc('fulfillment.profile.approve', { id: FRZ_ID }, ADMIN_TOKEN), 'approve(frz)');
        expect(approved.reviewState).toBe('APPROVED');
        expect(approved.approvedDigest).toMatch(/^[a-f0-9]{64}$/);   // approval bound to the exact definition
        const digest1 = approved.approvedDigest;

        // metadata-only edit (name) → still APPROVED / usable
        const metaEdit = V.assertResult(await rpc('fulfillment.profile.update', { id: FRZ_ID, name: 'frz renamed' }, ADMIN_TOKEN), 'update(meta)');
        expect(metaEdit.reviewState).toBe('APPROVED');

        // executable edit (add a transition) → resets to PENDING_REVIEW, approval cleared
        const edited = [...cleanProfile(FRZ_ID).transitions, { event: 'confirm', from: 'PAID', to: 'CONFIRMED', condition: null, actions: [{ type: 'task', method: 'market.order.confirm', params: { id: { var: 'instance.meta.orderId' } } }] }];
        const reopened = V.assertResult(await rpc('fulfillment.profile.update', { id: FRZ_ID, transitions: edited }, ADMIN_TOKEN), 'update(exec)');
        expect(reopened.reviewState).toBe('PENDING_REVIEW');
        expect(reopened.approvedDigest).toBeFalsy();

        // frozen: cannot create instances on the re-opened profile
        const o = V.assertResult(await rpc('market.order.create', { orderRef: `frz-${PID}`, amount: 5000, currency: 'CNY' }, ADMIN_TOKEN), 'order(frz)'); extraOrders.push(o.id);
        const blocked = await rpc('fulfillment.instance.create', { sourceId: o.id, profileId: FRZ_ID, meta: { orderId: o.id } }, ADMIN_TOKEN);
        expect(blocked.error).toBeTruthy();
        expect(blocked.error.message).toMatch(/not activated/);

        // re-approve → APPROVED with a NEW digest (definition changed) → usable again
        const reapproved = V.assertResult(await rpc('fulfillment.profile.approve', { id: FRZ_ID }, ADMIN_TOKEN), 're-approve(frz)');
        expect(reapproved.reviewState).toBe('APPROVED');
        expect(reapproved.approvedDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(reapproved.approvedDigest).not.toBe(digest1);        // bound to the new version
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: o.id, profileId: FRZ_ID, meta: { orderId: o.id } }, ADMIN_TOKEN), 'instance(frz)'); extraInstances.push(inst.id);
        expect(inst.state).toBe('DRAFT');
    }, 40_000);

    // 8 — an executable edit that breaks lint is rejected; the profile is left untouched.
    test('a lint-breaking executable edit is rejected, leaving the profile APPROVED', async () => {
        const broken = cleanProfile(FRZ_ID).transitions;
        broken[0].actions[0].method = 'market.order.payy';          // hallucinated action
        const res = await rpc('fulfillment.profile.update', { id: FRZ_ID, transitions: broken }, ADMIN_TOKEN);
        expect(res.error).toBeTruthy();
        expect(res.error.message).toMatch(/failed lint|payy/);
        const p = V.assertResult(await rpc('fulfillment.profile.get', { id: FRZ_ID }, ADMIN_TOKEN), 'unchanged');
        expect(p.reviewState).toBe('APPROVED');                     // edit rejected → still usable
    });

    // 9 — the subtle hole: an IN-FLIGHT instance must also freeze while its profile is under
    //     review (instances reload the profile each transition), and resume on re-approval.
    test('an in-flight instance freezes when its profile is sent back to review, resumes on re-approval', async () => {
        const twoStep = [
            { event: 'pay', from: 'DRAFT', to: 'PAID', condition: null, actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
            { event: 'confirm', from: 'PAID', to: 'CONFIRMED', condition: null, actions: [{ type: 'task', method: 'market.order.confirm', params: { id: { var: 'instance.meta.orderId' } } }] },
        ];
        V.assertResult(await rpc('fulfillment.profile.submit', { id: INF_ID, name: INF_ID, transitions: twoStep }, submitter.token), 'submit(inf)');
        V.assertResult(await rpc('fulfillment.profile.approve', { id: INF_ID }, ADMIN_TOKEN), 'approve(inf)');

        const o = V.assertResult(await rpc('market.order.create', { orderRef: `inf-${PID}`, amount: 5000, currency: 'CNY' }, ADMIN_TOKEN), 'order(inf)'); extraOrders.push(o.id);
        const inst = V.assertResult(await rpc('fulfillment.instance.create', { sourceId: o.id, profileId: INF_ID, meta: { orderId: o.id } }, ADMIN_TOKEN), 'instance(inf)'); extraInstances.push(inst.id);
        expect(V.assertResult(await rpc('fulfillment.instance.transition', { id: inst.id, event: 'pay' }, ADMIN_TOKEN), 'pay').state).toBe('PAID');

        // executable edit (append a transition) → profile drops to PENDING_REVIEW
        const edited = [...twoStep, { event: 'cancel', from: 'DRAFT', to: 'CANCELLED', condition: null }];
        const reopened = V.assertResult(await rpc('fulfillment.profile.update', { id: INF_ID, transitions: edited }, ADMIN_TOKEN), 'edit(inf)');
        expect(reopened.reviewState).toBe('PENDING_REVIEW');

        // in-flight instance cannot transition while the profile is under review
        const frozen = await rpc('fulfillment.instance.transition', { id: inst.id, event: 'confirm' }, ADMIN_TOKEN);
        expect(frozen.error).toBeTruthy();
        expect(frozen.error.message).toMatch(/not activated/);

        // re-approve → the in-flight instance resumes
        V.assertResult(await rpc('fulfillment.profile.approve', { id: INF_ID }, ADMIN_TOKEN), 're-approve(inf)');
        const confirmed = V.assertResult(await rpc('fulfillment.instance.transition', { id: inst.id, event: 'confirm' }, ADMIN_TOKEN), 'confirm after re-approve');
        expect(confirmed.state).toBe('CONFIRMED');
    }, 50_000);

    test('no service-side errors across fulfillment + market', async () => {
        await V.assertNoErrors(redis, ['fulfillment', 'market']);
    });
});
