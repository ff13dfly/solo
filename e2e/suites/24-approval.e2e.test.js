/**
 * 24 · approval SAP 协议:request→verify→confirm(INIT→DISPATCHED→DONE).
 * 关键:3-distinct-actor 链 —— applicant ≠ verifier ≠ confirmer。
 *   ① applicant 不能自审(verify 自己的 request);
 *   ② confirmer 不能等于任何 prior actor(record.js distinct-confirm 规则,127ba5e 引入)。
 *   applicant=测试用户、verify=admin、confirm=第三个独立用户。
 * record 走 entity-factory(四连含 WAL);业务态在 state 字段,与 factory status 分离.
 * (签名 Ed25519 链由 suite 71 覆盖;本套走 server-attested 路径 + 两道 distinct 闸。)
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser, ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('24 · approval SAP protocol (request→verify→confirm)', () => {
    let redis, uid, token, recordId;
    let confUid, confToken;                                  // 第三个独立 actor(confirmer)
    const name = `e2e-approval-${process.pid}`;
    const confName = `e2e-approval-conf-${process.pid}`;
    const PERMS = ['approval.record.request', 'approval.record.verify', 'approval.record.confirm', 'approval.record.get', 'approval.record.list'];

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { approval: PERMS }));
        ({ uid: confUid, token: confToken } = await sessionUser(redis, confName, { approval: ['approval.record.confirm', 'approval.record.get'] }));
    }, 20_000);
    afterAll(async () => {
        if (recordId) { await redis.del(`APPROVAL:RECORD:${recordId}`); await redis.sRem('APPROVAL:RECORD:INDEX', recordId); }
        await cleanupUser(redis, { uid, name });
        await cleanupUser(redis, { uid: confUid, name: confName });
        await redis.quit();
    });

    test('request (applicant) → ①API ②落库(state INIT)③WAL', async () => {
        const payload = [{ op: 'UPDATE', field: 'price.amount', oldValue: 100, newValue: 80, meta: { desc: 'markdown' } }];
        const r = V.assertResult(await rpc('approval.record.request', { target: `commodity:product:p-${process.pid}`, payload }, token), 'request');
        recordId = r.id;
        expect(r.state).toBe('INIT');

        const key = `APPROVAL:RECORD:${recordId}`;
        await V.assertRecord(redis, key, { state: 'INIT', status: 'ACTIVE' }, { indexKey: 'APPROVAL:RECORD:INDEX' });  // ②
        await V.assertWal(undefined, key, 'create', { user: uid });   // ③(applicant=调用方)
        await V.assertNoErrors(redis, ['approval']);
    });

    test('applicant cannot verify own request (self-audit forbidden)', async () => {
        const self = await rpc('approval.record.verify', { id: recordId }, token);   // 同一 actor
        V.assertRpcError(self, undefined, 'self-verify must be forbidden');
        await V.assertRecord(redis, `APPROVAL:RECORD:${recordId}`, { state: 'INIT' });   // 仍 INIT
    });

    test('verify (admin, distinct from applicant) → DISPATCHED', async () => {
        V.assertResult(await rpc('approval.record.verify', { id: recordId }, ADMIN_TOKEN), 'verify');
        await V.assertRecord(redis, `APPROVAL:RECORD:${recordId}`, { state: 'DISPATCHED' });
    });

    test('confirmer must differ from the verifier (3-distinct chain enforced)', async () => {
        // ADMIN already attested the `verify` stage → confirming as ADMIN is rejected (record.js
        // priorActors guard). Locks the distinct-confirm rule introduced with the signed chain.
        const dup = await rpc('approval.record.confirm', { id: recordId }, ADMIN_TOKEN);
        V.assertRpcError(dup, undefined, 'confirm by the verifier must be forbidden (distinct-actor)');
        await V.assertRecord(redis, `APPROVAL:RECORD:${recordId}`, { state: 'DISPATCHED' });   // 仍 DISPATCHED
    });

    test('confirm (3rd distinct actor) → DONE', async () => {
        V.assertResult(await rpc('approval.record.confirm', { id: recordId }, confToken), 'confirm');
        await V.assertRecord(redis, `APPROVAL:RECORD:${recordId}`, { state: 'DONE' });
    });
});
