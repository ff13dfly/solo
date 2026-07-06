/**
 * 53 · fulfillment — profile 全生命周期 + instance.transition(JsonLogic 状态机).
 *
 * 历史注:
 *  BUG-A(已修复): introspection 曾把 `toState` 声明为 required,但 logic 读 `event`。
 *    已改为只声明 `event`。本套调用全部移除了 toState。
 *  BUG-B(已修复): profile.create 的 entity factory 曾用生成 id 作 Redis key,
 *    导致 created.id ≠ key。entity.js clientId:true 分支修复后,caller 提供的 id
 *    直接作 key,get/update/delete 可直接用 created.id。本套已去掉 INDEX 扫描 workaround。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const PKEY   = (id) => `FULFILLMENT:PROFILE:${id}`;
const PINDEX = 'FULFILLMENT:PROFILE:INDEX';
const IKEY   = (id) => `FULFILLMENT:INSTANCE:${id}`;
const IINDEX = 'FULFILLMENT:INSTANCE:INDEX';

gate('53 · fulfillment (transition state machine + profile CRUD)', () => {
    let redis, uid, token;
    const name = `e2e-fulfil53-${process.pid}`;

    // 状态机 profile:DRAFT --start--> PROCESSING(无条件);
    // PROCESSING --confirm--> CONFIRMED(JsonLogic:meta.approved === true)。
    const smTransitions = [
        { event: 'start',   from: 'DRAFT',       to: 'PROCESSING', condition: null, actions: [] },
        { event: 'confirm', from: 'PROCESSING',   to: 'CONFIRMED',
          condition: { '==': [{ var: 'instance.meta.approved' }, true] }, actions: [] },
    ];

    const profileIds  = [];
    const instanceIds = [];

    async function createProfile(id, transitions) {
        const created = V.assertResult(await rpc('fulfillment.profile.create', { id, name: id, transitions }, token), 'profile.create');
        expect(created.id).toBe(id);   // clientId:true — returned id must equal what we sent
        expect(created.status).toBe('ACTIVE');
        profileIds.push(id);
        return id;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { fulfillment: ['*'] }));
    }, 25_000);

    afterAll(async () => {
        for (const id of profileIds)  { await redis.del(PKEY(id));  await redis.sRem(PINDEX, id); }
        for (const id of instanceIds) { await redis.del(IKEY(id));  await redis.sRem(IINDEX, id); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    // ── profile CRUD 全生命周期 ────────────────────────────────────────────────

    test('profile.create → get / list / update', async () => {
        const pid = await createProfile(`e2e-crud-${process.pid}`, [
            { event: 'start', from: 'DRAFT', to: 'PROCESSING', condition: null, actions: [] },
        ]);

        // get — same id works directly (clientId路径)
        const got = V.assertResult(await rpc('fulfillment.profile.get', { id: pid }, token), 'profile.get');
        expect(got.id).toBe(pid);
        expect(got.transitions[0].event).toBe('start');

        // list
        const listed = V.assertResult(await rpc('fulfillment.profile.list', {}, token), 'profile.list');
        expect(listed.items.some((p) => p.id === pid)).toBe(true);

        // update
        const updated = V.assertResult(await rpc('fulfillment.profile.update', { id: pid, name: `${pid}-renamed` }, token), 'profile.update');
        expect(updated.name).toBe(`${pid}-renamed`);
        expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
        expect((await V.readKey(redis, PKEY(pid))).name).toBe(`${pid}-renamed`);
        await V.assertNoErrors(redis, ['fulfillment']);
    }, 30_000);

    test('profile.delete(软删→DELETED) → restore(→ACTIVE)', async () => {
        const pid = await createProfile(`e2e-delrestore-${process.pid}`, []);

        const del = V.assertResult(await rpc('fulfillment.profile.delete', { id: pid }, token), 'profile.delete');
        expect(del.status).toBe('DELETED');
        expect((await V.readKey(redis, PKEY(pid))).status).toBe('DELETED');
        expect(V.assertResult(await rpc('fulfillment.profile.list', {}, token)).items.some((p) => p.id === pid)).toBe(false);

        const res = V.assertResult(await rpc('fulfillment.profile.restore', { id: pid }, token), 'profile.restore');
        expect(res.status).toBe('ACTIVE');
        expect(V.assertResult(await rpc('fulfillment.profile.list', {}, token)).items.some((p) => p.id === pid)).toBe(true);
    }, 30_000);

    test('profile.destroy(硬删) → get 报 NOT_FOUND', async () => {
        const pid = `e2e-destroy-${process.pid}`;
        V.assertResult(await rpc('fulfillment.profile.create', { id: pid, name: pid, transitions: [] }, token), 'create for destroy');
        // 不加入 profileIds — destroy 后无需 afterAll 清

        const d = V.assertResult(await rpc('fulfillment.profile.destroy', { id: pid }, token), 'profile.destroy');
        expect(d.success).toBe(true);
        expect(await V.readKey(redis, PKEY(pid))).toBeNull();
        expect(await redis.sIsMember(PINDEX, pid)).toBeFalsy();
        const err = V.assertRpcError(await rpc('fulfillment.profile.get', { id: pid }, token), undefined, 'get after destroy');
        expect(err.code).not.toBe(-32601);
    }, 30_000);

    // ── instance.transition:JsonLogic 状态机 ──────────────────────────────────

    test('transition(event=start):DRAFT → PROCESSING, history 增长, prevState 记录', async () => {
        const pid = await createProfile(`e2e-sm-${process.pid}`, smTransitions);
        const inst = V.assertResult(await rpc('fulfillment.instance.create', {
            sourceId: `ORD53-${process.pid}`, profileId: pid, meta: { approved: false },
        }, token), 'instance.create');
        instanceIds.push(inst.id);

        const moved = V.assertResult(await rpc('fulfillment.instance.transition', {
            id: inst.id, event: 'start',
        }, token), 'transition start');
        expect(moved.state).toBe('PROCESSING');
        expect(moved.prevState).toBe('DRAFT');
        expect(moved.history.length).toBeGreaterThanOrEqual(2);
        const last = moved.history[moved.history.length - 1];
        expect(last.state).toBe('PROCESSING');
        expect(last.event).toBe('start');
        expect(last.user).toBe(uid);
        expect((await V.readKey(redis, IKEY(inst.id))).state).toBe('PROCESSING');
        await V.assertNoErrors(redis, ['fulfillment']);
    }, 30_000);

    test('JsonLogic 条件未满足被拒; metaUpdate 补足后通过', async () => {
        const pid = await createProfile(`e2e-smcond-${process.pid}`, smTransitions);
        const inst = V.assertResult(await rpc('fulfillment.instance.create', {
            sourceId: `ORD53C-${process.pid}`, profileId: pid, meta: { approved: false },
        }, token), 'instance.create');
        instanceIds.push(inst.id);

        V.assertResult(await rpc('fulfillment.instance.transition', { id: inst.id, event: 'start' }, token), 'start');

        // approved=false → 条件不通过
        const denied = V.assertRpcError(
            await rpc('fulfillment.instance.transition', { id: inst.id, event: 'confirm' }, token),
            undefined, 'confirm must fail when not approved'
        );
        expect(denied.code).not.toBe(-32601);
        expect((await V.readKey(redis, IKEY(inst.id))).state).toBe('PROCESSING');

        // metaUpdate 在条件评估前 merge → 通过
        const ok = V.assertResult(await rpc('fulfillment.instance.transition', {
            id: inst.id, event: 'confirm', metaUpdate: { approved: true },
        }, token), 'confirm with metaUpdate');
        expect(ok.state).toBe('CONFIRMED');
        expect(ok.meta.approved).toBe(true);
        expect((await V.readKey(redis, IKEY(inst.id))).state).toBe('CONFIRMED');
    }, 30_000);

    test('未定义 event → 报错, state 不变', async () => {
        const pid = await createProfile(`e2e-smbad-${process.pid}`, smTransitions);
        const inst = V.assertResult(await rpc('fulfillment.instance.create', {
            sourceId: `ORD53B-${process.pid}`, profileId: pid, meta: {},
        }, token), 'instance.create');
        instanceIds.push(inst.id);

        const err = V.assertRpcError(
            await rpc('fulfillment.instance.transition', { id: inst.id, event: 'nonexistent' }, token),
            undefined, 'undefined event must be rejected'
        );
        expect(err.code).not.toBe(-32601);
        expect((await V.readKey(redis, IKEY(inst.id))).state).toBe('DRAFT');
    }, 30_000);
});
