/**
 * 22 · planner todo/agenda CRUD(四连断言;full profile).
 * 按用户隔离:键在 PLANNER:U:{uid}:TODO:{id}(+ SET 索引);createdAt 是 ms 整数.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('22 · planner todo (four-layer, per-user keys)', () => {
    let redis, uid, token;
    const name = `e2e-planner-${process.pid}`;
    const todos = [];

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { planner: ['*'] }));
    }, 20_000);
    afterAll(async () => {
        for (const id of todos) { await redis.del(`PLANNER:U:${uid.toUpperCase()}:TODO:${id}`); await redis.sRem(`PLANNER:U:${uid.toUpperCase()}:TODO:INDEX`, id); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('todo.create → ①API ②落库(per-user key + SET 索引)③WAL', async () => {
        const t = V.assertResult(await rpc('planner.todo.create', { name: 'Q3 planning', content: '# goals' }, token), 'todo.create');
        todos.push(t.id);
        expect(t.status).toBe('ACTIVE');

        const key = `PLANNER:U:${uid.toUpperCase()}:TODO:${t.id}`;
        await V.assertRecord(redis, key, { name: 'Q3 planning', status: 'ACTIVE' }, { indexKey: `PLANNER:U:${uid.toUpperCase()}:TODO:INDEX` });  // ②
        V.assertWal(undefined, key, 'create', { user: uid });   // ③
        await V.assertNoErrors(redis, ['planner']);             // ③
    });

    test('todo.update updates a field + stamps WAL update', async () => {
        // 注:planner todo 的 `status` 同时被 entity factory 当生命周期字段(ACTIVE/DELETED),
        // 改成 IN_PROGRESS 会让 factory.list(过滤 status===ACTIVE)看不到它 → 改 content 字段.
        const id = todos[0];
        V.assertResult(await rpc('planner.todo.update', { id, content: '# updated goals' }, token), 'todo.update');
        const key = `PLANNER:U:${uid.toUpperCase()}:TODO:${id}`;
        await V.assertRecord(redis, key, { content: '# updated goals', status: 'ACTIVE' });
        V.assertWal(undefined, key, 'update', { user: uid });
    });

    test('get / list reflect the todo', async () => {
        const id = todos[0];
        expect(V.assertResult(await rpc('planner.todo.get', { id }, token)).id).toBe(id);
        expect(V.assertResult(await rpc('planner.todo.list', {}, token)).items.some((x) => x.id === id)).toBe(true);
    });
});
