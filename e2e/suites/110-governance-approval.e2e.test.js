/**
 * 110 · 治理线全链路 (VERSION.md §3.1–§3.3) — 分层审批 + 密码签名 + 冷却期.
 *
 * 真实路径(全栈,经 Router):
 *   submitter 投稿 HIGH-risk workflow(含写方法 → footprint 判 HIGH)
 *     → approver 生成签名密钥(user.key.generate)
 *     → approver approve(无签名)→ NEEDS_SIGNATURE + digest
 *     → approver user.key.sign(digest, password)→ signature
 *     → approver approve(带签名)→ approval.gate 验签 → ACTIVE + 冷却期
 *     → 冷却期内 run 被拒
 *   并验证:自审禁令、LOW-risk 走 C1 快速档、错误密码不放行.
 *
 * 跨服务:orchestrator → approval.gate.* → user.key.public(验签). full profile.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, setPermit, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('110 · governance — layered approval (multi-sig + signing + cooling)', () => {
    let redis, submitter, approver;
    const nameS = `e2e-gov110-sub-${process.pid}`;
    const nameA = `e2e-gov110-appr-${process.pid}`;
    const PASSWORD = 'approver-pass-110';   // ≥8 chars (key encryption)
    const created = [];

    const highWf = () => ({
        category: { name: 'e2e-gov110' }, name: 'HIGH risk wf', desc: 'writes → multi-sig',
        steps: [
            { id: 's1', service: 'collection', method: 'collection.payment.get', params: { id: '$input.pid' } },
            { id: 's2', service: 'gateway', method: 'gateway.email.send', params: { to: 'x@y.z' } },   // WRITE → HIGH
        ],
    });
    const lowWf = () => ({
        category: { name: 'e2e-gov110' }, name: 'LOW risk wf', desc: 'reads → C1',
        steps: [{ id: 's1', service: 'collection', method: 'collection.payment.get', params: { id: 'x' } }],
    });

    beforeAll(async () => {
        redis = await redisLib.connect();
        // submitter: may propose workflows. approver: may approve + manage own signing key.
        submitter = await sessionUser(redis, nameS, { orchestrator: ['orchestrator.workflow.create', 'orchestrator.workflow.get', 'orchestrator.workflow.run'] });
        approver  = await sessionUser(redis, nameA, { orchestrator: ['orchestrator.workflow.approve', 'orchestrator.workflow.get'], user: ['user.key.generate', 'user.key.sign'] });
        // approver provisions a signing key (password-encrypted).
        V.assertResult(await rpc('user.key.generate', { password: PASSWORD }, approver.token), 'key.generate');
    }, 40_000);

    afterAll(async () => {
        for (const id of created) { await redis.del(`ORCHESTRATOR:WORKFLOW:${id}`); await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', id); }
        await redis.del(`USER:SIGNKEY:${approver.uid}`).catch(() => {});
        await cleanupUser(redis, { uid: submitter.uid, name: nameS });
        await cleanupUser(redis, { uid: approver.uid, name: nameA });
        await redis.quit();
    });

    test('HIGH-risk create → PENDING_REVIEW, risk_level=HIGH, approval_config set', async () => {
        const wf = V.assertResult(await rpc('orchestrator.workflow.create', highWf(), submitter.token), 'create HIGH');
        created.push(wf.id);
        expect(wf.status).toBe('PENDING_REVIEW');
        expect(wf.risk_level).toBe('HIGH');
        expect(wf.approval_config.requiredSigners).toBeGreaterThanOrEqual(1);
    }, 30_000);

    test('self-approval ban: submitter cannot approve their own HIGH workflow', async () => {
        const wfId = created[0];
        const res = await rpc('orchestrator.workflow.approve', { id: wfId }, submitter.token);
        const err = V.assertRpcError(res, undefined, 'self-approve must be forbidden');
        expect(err.code).toBe(-32005);
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`)).status).toBe('PENDING_REVIEW');
    }, 30_000);

    test('approve(no signature) → NEEDS_SIGNATURE + digest (opens gate, no state change)', async () => {
        const wfId = created[0];
        const need = V.assertResult(await rpc('orchestrator.workflow.approve', { id: wfId }, approver.token), 'approve(no sig)');
        expect(need.status).toBe('NEEDS_SIGNATURE');
        expect(need.gateId).toBeTruthy();
        expect(need.digest).toMatch(/^[0-9a-f]{64}$/);
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`)).status).toBe('PENDING_REVIEW');
    }, 30_000);

    test('wrong password does not produce a valid signature (no activation)', async () => {
        const wfId = created[0];
        const need = V.assertResult(await rpc('orchestrator.workflow.approve', { id: wfId }, approver.token), 'approve(no sig)');
        const bad = await rpc('user.key.sign', { digest: need.digest, password: 'WRONG-PASSWORD' }, approver.token);
        expect(bad.error).toBeTruthy();   // sign fails with the wrong password
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`)).status).toBe('PENDING_REVIEW');
    }, 30_000);

    test('sign the digest → approve(signature) → ACTIVE with a cooling period', async () => {
        const wfId = created[0];
        const need = V.assertResult(await rpc('orchestrator.workflow.approve', { id: wfId }, approver.token), 'approve(no sig)');
        const signed = V.assertResult(await rpc('user.key.sign', { digest: need.digest, password: PASSWORD }, approver.token), 'key.sign');
        expect(signed.signature).toBeTruthy();

        const done = V.assertResult(await rpc('orchestrator.workflow.approve', { id: wfId, signature: signed.signature }, approver.token), 'approve(sig)');
        expect(done.success).toBe(true);
        expect(done.lane).toBe('multisig');

        const doc = await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wfId}`);
        expect(doc.status).toBe('ACTIVE');
        expect(doc.effective_at).toBeGreaterThan(Date.now());   // cooling period in effect
    }, 40_000);

    test('cooling period blocks run (FORBIDDEN) until effective_at', async () => {
        const wfId = created[0];
        const res = await rpc('orchestrator.workflow.run', { workflowId: wfId, input: { pid: 'p1' } }, submitter.token);
        const err = V.assertRpcError(res, undefined, 'cooling-period run must be forbidden');
        expect(err.code).toBe(-32005);
        expect(err.message).toMatch(/cooling/i);
    }, 30_000);

    test('LOW-risk create → approve(no signature) → C1 fast lane → ACTIVE immediately', async () => {
        const wf = V.assertResult(await rpc('orchestrator.workflow.create', lowWf(), submitter.token), 'create LOW');
        created.push(wf.id);
        expect(wf.risk_level).toBe('LOW');

        const res = V.assertResult(await rpc('orchestrator.workflow.approve', { id: wf.id }, approver.token), 'approve LOW');
        expect(res.lane).toBe('C1');
        expect((await redis.json.get(`ORCHESTRATOR:WORKFLOW:${wf.id}`)).status).toBe('ACTIVE');
    }, 30_000);
});
