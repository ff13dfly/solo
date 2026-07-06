/**
 * 61 · approval SAP 协议 —— 覆盖 24 没覆盖的方法:record.reject / record.get / record.list.
 *
 * reject 路径(协议 §4 TRANSITIONS):reject.from = [INIT, DISPATCHED]。
 *   - 这里走完整 request → verify → reject(DISPATCHED → REJECTED),覆盖"被审核后再驳回".
 *   - 顺带断 INIT → reject 直接驳回(applicant 撤回前的另一条合法边).
 * get:按 id 读回,断 target/payload/state/evidence 形状.
 * list:按 target 过滤拿回 { items, total },断本套件造的记录在内 + state 过滤生效.
 *
 * 自审禁令:verify 必须换 actor(≠ applicant)。applicant = 测试用户,verify = ADMIN_TOKEN.
 * record 走 entity-factory(data key APPROVAL:RECORD:{id} / index APPROVAL:RECORD:INDEX);
 * 业务态在 state 字段,与 factory 的 status(ACTIVE/DELETED)分离.
 *
 * 共享栈纪律:所有 record id 带 process.pid;afterAll 逐一 del 数据键 + sRem 索引集.
 * 不触碰任何 relay-bot token / admin.self.lock / *.config —— 只读写本服务自有实体.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser, ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const DATA = (id) => `APPROVAL:RECORD:${id}`;
const INDEX = 'APPROVAL:RECORD:INDEX';

gate('61 · approval reject / get / list', () => {
    let redis, uid, token;
    const name = `e2e-approval61-${process.pid}`;
    const target = `commodity:product:p61-${process.pid}`;          // 本套件专属 target(带 pid)
    const PERMS = [
        'approval.record.request',
        'approval.record.verify',
        'approval.record.reject',
        'approval.record.get',
        'approval.record.list',
    ];
    const created = [];        // 所有造出来的 record id,afterAll 清

    // 帮手:applicant 发起一个变更请求 → INIT,记录 id 以便清理.
    async function fileRequest(field) {
        const payload = [{ op: 'UPDATE', field, oldValue: 100, newValue: 80, meta: { desc: 'markdown' } }];
        const r = V.assertResult(await rpc('approval.record.request', { target, payload }, token), 'request');
        created.push(r.id);
        return r;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { approval: PERMS }));
    }, 20_000);

    afterAll(async () => {
        for (const id of created) {
            await redis.del(DATA(id));
            await redis.sRem(INDEX, id);
        }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('request → verify(admin) → reject(admin): DISPATCHED → REJECTED', async () => {
        const req = await fileRequest('price.amount');
        expect(req.state).toBe('INIT');

        // 换 actor 通过自审禁令,推进到 DISPATCHED.
        V.assertResult(await rpc('approval.record.verify', { id: req.id }, ADMIN_TOKEN), 'verify');
        await V.assertRecord(redis, DATA(req.id), { state: 'DISPATCHED' });

        // reject(带 reason):DISPATCHED → REJECTED.
        const rej = V.assertResult(
            await rpc('approval.record.reject', { id: req.id, reason: 'budget exceeded' }, ADMIN_TOKEN),
            'reject',
        );
        expect(rej.state).toBe('REJECTED');
        await V.assertRecord(redis, DATA(req.id), { state: 'REJECTED', status: 'ACTIVE' }, { indexKey: INDEX });
    });

    test('reject directly from INIT (applicant withdraws before verify)', async () => {
        const req = await fileRequest('price.discount');
        const rej = V.assertResult(
            await rpc('approval.record.reject', { id: req.id }, token),   // 无 reason 也合法
            'reject-from-init',
        );
        expect(rej.state).toBe('REJECTED');
        await V.assertRecord(redis, DATA(req.id), { state: 'REJECTED' });
    });

    test('reject a DONE/REJECTED record is forbidden (state machine guard)', async () => {
        const req = await fileRequest('price.tax');
        V.assertResult(await rpc('approval.record.reject', { id: req.id }, token), 'first-reject');
        // 已 REJECTED,再 reject 应被状态机拒(reject.from 不含 REJECTED).
        const second = await rpc('approval.record.reject', { id: req.id }, ADMIN_TOKEN);
        V.assertRpcError(second, undefined, 're-reject a REJECTED record must fail');
        await V.assertRecord(redis, DATA(req.id), { state: 'REJECTED' });   // 仍 REJECTED,未被改动
    });

    test('get by id → returns target / payload / state / evidence trail', async () => {
        const req = await fileRequest('name.label');
        const rec = V.assertResult(await rpc('approval.record.get', { id: req.id }, token), 'get');

        expect(rec.id).toBe(req.id);
        expect(rec.target).toBe(target);
        expect(Array.isArray(rec.payload)).toBe(true);
        expect(rec.payload[0].field).toBe('name.label');
        expect(rec.state).toBe('INIT');
        // evidence 是 append-only attestation trail;request 阶段至少落一条.
        expect(Array.isArray(rec.evidence)).toBe(true);
        expect(rec.evidence.length).toBeGreaterThanOrEqual(1);
        expect(rec.evidence[0].stage).toBe('request');
    });

    test('list filtered by target → returns { items, total } incl. this suite records', async () => {
        // 至此本套件已造若干条(全用同一 target).
        const res = V.assertResult(await rpc('approval.record.list', { target }, token), 'list');
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');

        // 我们造的 id 应全部在结果里,且每条 target 都匹配过滤条件.
        const ids = new Set(res.items.map((r) => r.id));
        for (const id of created) expect(ids.has(id)).toBe(true);
        expect(res.items.every((r) => r.target === target)).toBe(true);
        expect(res.total).toBeGreaterThanOrEqual(created.length);
    });

    test('list filtered by state=REJECTED → only rejected records of this target', async () => {
        const res = V.assertResult(
            await rpc('approval.record.list', { target, state: 'REJECTED' }, token),
            'list-rejected',
        );
        expect(res.items.every((r) => r.state === 'REJECTED' && r.target === target)).toBe(true);
        // 前面至少驳回了 3 条(DISPATCHED→REJECTED、INIT→REJECTED、guard 用例那条).
        expect(res.total).toBeGreaterThanOrEqual(3);
    });
});
