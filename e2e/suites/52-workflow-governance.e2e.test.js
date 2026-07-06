/**
 * 52 · workflow 治理生命周期(C1 审核闸).
 * 真实路径(不再直接注入 ACTIVE):create(PENDING_REVIEW)→ 自审被拒(-32005)→ 换人 approve → ACTIVE.
 * 这是 91 直接注入 ACTIVE 绕过的那段治理逻辑.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('52 · workflow governance (C1 approval gate)', () => {
    let redis, creator, approver, wfId, sagaWfId;
    const nameA = `e2e-gov-creator-${process.pid}`;
    const nameB = `e2e-gov-approver-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        creator = await sessionUser(redis, nameA, { orchestrator: ['*'] });
        approver = await sessionUser(redis, nameB, { orchestrator: ['*'] });
    }, 25_000);
    afterAll(async () => {
        for (const w of [wfId, sagaWfId].filter(Boolean)) { await redis.del(`ORCHESTRATOR:WORKFLOW:${w}`); await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', w); }
        await cleanupUser(redis, { uid: creator.uid, name: nameA });
        await cleanupUser(redis, { uid: approver.uid, name: nameB });
        await redis.quit();
    });

    test('create → PENDING_REVIEW,submittedBy=创建者', async () => {
        // §3.1: this suite tests the C1 fast lane, so use a READ-only footprint (LOW risk).
        // A write method (payment.record) would route to the multi-sig lane (suite 110).
        const wf = V.assertResult(await rpc('orchestrator.workflow.create', {
            category: { name: 'e2e-gov' }, name: 'E2E governance wf', desc: 'create→approve test',
            steps: [{ id: 's1', service: 'collection', method: 'collection.payment.get', params: { id: 'x' } }],
        }, creator.token), 'workflow.create');
        wfId = wf.id;
        expect(wf.status).toBe('PENDING_REVIEW');
        expect(wf.submittedBy).toBe(creator.uid);
        // 落库(workflow 是 RedisJSON doc,用 json.get)+ 进 index(matcher 现靠 index 发现)
        const doc = await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`);
        expect(doc.status).toBe('PENDING_REVIEW');
        expect(doc.submittedBy).toBe(creator.uid);
        expect(await redis.sIsMember('ORCHESTRATOR:WORKFLOW_INDEX', wfId)).toBeTruthy();
    }, 30_000);

    test('自审禁令:创建者本人 approve → 被拒(仍 PENDING_REVIEW)', async () => {
        const res = await rpc('orchestrator.workflow.approve', { id: wfId }, creator.token);
        const err = V.assertRpcError(res, undefined, 'self-approve must be forbidden');
        expect(err.code).not.toBe(-32601);   // 可达,是被治理闸挡(预期 -32005)
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`)).status).toBe('PENDING_REVIEW');
    }, 30_000);

    test('换一个人 approve → ACTIVE', async () => {
        V.assertResult(await rpc('orchestrator.workflow.approve', { id: wfId }, approver.token), 'approve(by other)');
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`)).status).toBe('ACTIVE');
    }, 30_000);

    // §7.4 — approve verifies each compensate step's method exists in the LIVE capability
    // catalog (system:capability:list). A rollback to a non-existent method is rejected
    // BEFORE any lane (it would fail UNSAFE at run, after forward steps commit).
    test('§7.4: approve rejects a compensate step whose method exists in no service', async () => {
        const wf = V.assertResult(await rpc('orchestrator.workflow.create', {
            category: { name: 'e2e-gov' }, name: 'E2E saga precheck', desc: 'compensate → missing method',
            steps: [
                { id: 'charge', service: 'collection', method: 'collection.payment.record', params: { amount: 1, currency: 'CNY', orderId: 'x' }, compensate: 'undo' },
                { id: 'undo',   service: 'collection', method: 'collection.payment.nonexistent999', params: { id: 'x' } },   // not in the live catalog
            ],
        }, creator.token), 'workflow.create');
        sagaWfId = wf.id;
        expect(wf.status).toBe('PENDING_REVIEW');   // create stores it (structure is valid; existence is an approve-time check)

        // approve by a different actor → §7.4 fires before the lane → rejected, stays PENDING_REVIEW
        const res = await rpc('orchestrator.workflow.approve', { id: sagaWfId }, approver.token);
        const err = V.assertRpcError(res, undefined, '§7.4 compensation-method existence');
        expect(err.code).toBe(-32602);
        expect(err.message).toMatch(/Saga rollback cannot run/i);
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${sagaWfId}`)).status).toBe('PENDING_REVIEW');
    }, 30_000);
});
