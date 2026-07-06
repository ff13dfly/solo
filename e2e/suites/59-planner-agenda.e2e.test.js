/**
 * 59 · planner agenda CRUD + sync,以及 todo.delete/sync 与 AI stub(analyze/schedule).
 *
 * 22 已覆盖 todo.create/update/get/list;本套件补 planner 当前**无 e2e 覆盖**的方法:
 *   - agenda.create / get / update / delete / list / sync
 *   - todo.delete(软删:status→DELETED,从 active list 消失但键还在)
 *   - todo.sync(批量本地优先同步:local-* → 新建 server id,idMap 回填)
 *   - todo.analyze / todo.schedule(index.js 里是 Phase-2 stub,返回 {status:'PENDING'},测到返回即可)
 *
 * 隔离:planner 实体按用户隔离,键在 PLANNER:U:{UID-UPPER}:AGENDA:{id}(+ SET 索引);
 *       agenda softDelete=false(硬删,键消失);todo softDelete=true(软删,键留 status=DELETED)。
 *       createdAt/updatedAt 是 ms 整数。
 * full profile(需 user + router + planner 夹具)。
 *
 * 共享栈纪律:只动本套件自建的、带 process.pid 命名的用户与实体;afterAll 逐一清干净
 *           (agenda 硬删多数已自清,残留 id 兜底 del + sRem;todo 软删的键必须显式 del)。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('59 · planner agenda CRUD + sync + todo.delete/sync + AI stubs', () => {
    let redis, uid, token, UID;
    const name = `e2e-planner-agenda-${process.pid}`;

    // 本套件创建的实体 id,afterAll 逐一兜底清理。
    const agendaIds = new Set();
    const todoIds = new Set();

    const aKey = (id) => `PLANNER:U:${UID}:AGENDA:${id}`;
    const aIndex = () => `PLANNER:U:${UID}:AGENDA:INDEX`;
    const tKey = (id) => `PLANNER:U:${UID}:TODO:${id}`;
    const tIndex = () => `PLANNER:U:${UID}:TODO:INDEX`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { planner: ['*'] }));
        UID = uid.toUpperCase();
    }, 25_000);

    afterAll(async () => {
        for (const id of agendaIds) { await redis.del(aKey(id)); await redis.sRem(aIndex(), id); }
        for (const id of todoIds) { await redis.del(tKey(id)); await redis.sRem(tIndex(), id); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    // ── agenda CRUD 串:create → get → list → update → delete ─────────────────

    test('agenda.create → ①API(ACTIVE)②落库(per-user key + SET 索引)③WAL', async () => {
        const a = V.assertResult(await rpc('planner.agenda.create', {
            title: 'Standup', date: '2026-06-10', startTime: '09:00', endTime: '09:30',
        }, token), 'agenda.create');
        agendaIds.add(a.id);
        expect(a.status).toBe('ACTIVE');
        expect(a.title).toBe('Standup');

        // ② 落库 + 进 index
        await V.assertRecord(redis, aKey(a.id),
            { title: 'Standup', date: '2026-06-10', status: 'ACTIVE' },
            { indexKey: aIndex() });
        // ③ WAL create(before===null,user=uid)
        V.assertWal(undefined, aKey(a.id), 'create', { user: uid });
    }, 30_000);

    test('agenda.get / list 反映该 agenda', async () => {
        const id = [...agendaIds][0];
        const got = V.assertResult(await rpc('planner.agenda.get', { id }, token), 'agenda.get');
        expect(got.id).toBe(id);
        expect(got.startTime).toBe('09:00');

        const listed = V.assertResult(await rpc('planner.agenda.list', {}, token), 'agenda.list');
        expect(Array.isArray(listed.items)).toBe(true);
        expect(listed.items.some((x) => x.id === id)).toBe(true);
    }, 30_000);

    test('agenda.update 改一个字段 + 盖 WAL update 行', async () => {
        const id = [...agendaIds][0];
        V.assertResult(await rpc('planner.agenda.update', { id, endTime: '10:00' }, token), 'agenda.update');
        await V.assertRecord(redis, aKey(id), { endTime: '10:00', status: 'ACTIVE' });
        V.assertWal(undefined, aKey(id), 'update', { user: uid });
    }, 30_000);

    test('agenda.delete 硬删:键消失 + 出 index + 不再 get', async () => {
        // 另建一个专供删除的 agenda,避免影响上面的串。
        const a = V.assertResult(await rpc('planner.agenda.create', {
            title: 'To be deleted', date: '2026-06-11', startTime: '14:00', endTime: '14:15',
        }, token), 'agenda.create(for delete)');
        agendaIds.add(a.id);

        V.assertResult(await rpc('planner.agenda.delete', { id: a.id }, token), 'agenda.delete');

        // 硬删:数据键不存在 + 已出 index
        expect(await redis.exists(aKey(a.id))).toBe(0);
        expect(await redis.sIsMember(aIndex(), a.id)).toBe(false);
        // 再 get 应报错(NOT_FOUND),不是 METHOD_NOT_FOUND
        const res = await rpc('planner.agenda.get', { id: a.id }, token);
        const err = V.assertRpcError(res, undefined, 'get deleted agenda must error');
        expect(err.code).not.toBe(-32601);
    }, 30_000);

    // ── agenda.sync:本地优先批量同步 ──────────────────────────────────────────

    test('agenda.sync:local-* 新建 server id 并回填 idMap', async () => {
        const localId = `local-${process.pid}-x`;
        const res = V.assertResult(await rpc('planner.agenda.sync', {
            events: [{
                id: localId, title: 'Synced block', date: '2026-06-12',
                startTime: '11:00', endTime: '11:45',
            }],
        }, token), 'agenda.sync');

        expect(res.success).toBe(true);
        expect(res.count).toBe(1);
        const newId = res.idMap[localId];
        expect(typeof newId).toBe('string');
        agendaIds.add(newId);

        // 服务端确实创建了该 agenda
        await V.assertRecord(redis, aKey(newId),
            { title: 'Synced block', status: 'ACTIVE' }, { indexKey: aIndex() });
    }, 30_000);

    // ── todo.delete(软删)+ todo.sync ─────────────────────────────────────────

    test('todo.delete 软删:键留存 status=DELETED,从 active list 消失', async () => {
        const t = V.assertResult(await rpc('planner.todo.create', {
            name: 'todo-to-delete', content: '# x',
        }, token), 'todo.create');
        todoIds.add(t.id);
        expect(t.status).toBe('ACTIVE');

        V.assertResult(await rpc('planner.todo.delete', { id: t.id }, token), 'todo.delete');

        // 软删:键仍在,status 变 DELETED
        await V.assertRecord(redis, tKey(t.id), { status: 'DELETED' });
        // 默认 list 只返回 ACTIVE → 该 todo 不再出现
        const listed = V.assertResult(await rpc('planner.todo.list', {}, token), 'todo.list');
        expect(listed.items.some((x) => x.id === t.id)).toBe(false);
    }, 30_000);

    test('todo.sync:local-* 新建 server id 并回填 idMap', async () => {
        const localId = `local-${process.pid}-t`;
        const res = V.assertResult(await rpc('planner.todo.sync', {
            todos: [{ id: localId, name: 'synced todo', content: '# goals' }],
        }, token), 'todo.sync');

        expect(res.success).toBe(true);
        expect(res.count).toBe(1);
        const newId = res.idMap[localId];
        expect(typeof newId).toBe('string');
        todoIds.add(newId);

        await V.assertRecord(redis, tKey(newId),
            { name: 'synced todo', status: 'ACTIVE' }, { indexKey: tIndex() });
    }, 30_000);

    // ── AI stubs(Phase-2,index.js 直接返回 {status:'PENDING'};测可达 + 形状) ──

    test('todo.analyze:Phase-2 stub,可达且返回 PENDING(未实现)', async () => {
        const id = [...todoIds][0] || 'noop';
        const res = await rpc('planner.todo.analyze', { id }, token);
        const result = V.assertResult(res, 'todo.analyze');
        // 当前是 stub:不做真实分析,只返回占位状态。
        expect(result.status).toBe('PENDING');
        expect(typeof result.message).toBe('string');
    }, 30_000);

    test('todo.schedule:Phase-2 stub,可达且返回 PENDING(未实现)', async () => {
        const id = [...todoIds][0] || 'noop';
        const res = await rpc('planner.todo.schedule', { id }, token);
        const result = V.assertResult(res, 'todo.schedule');
        expect(result.status).toBe('PENDING');
        expect(typeof result.message).toBe('string');
    }, 30_000);
});
