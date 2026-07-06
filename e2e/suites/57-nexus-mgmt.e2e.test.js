/**
 * 57 · nexus management surface — 补 27/51 未覆盖的方法.
 *
 * 27 已测 agent.create/get/list + schedule.create/delete;51 测 scheduler 真触发.
 * 本套补:
 *   - agent 生命周期剩余段:heartbeat → resolve → broadcast → disable
 *   - schedule CRUD 剩余段:create → get / list / update(远未来 fire_at,绝不触发)
 *   - token.status(只读;绝不动 token.set/clear,那会废掉 50/51/91/92 的 system.nexus bot)
 *
 * full profile;admin-only 方法用 ADMIN_TOKEN.
 * 全部实体 id 带 process.pid,afterAll 逐一清掉(data key + SET 索引 + SUB 订阅集 + SCHEDULE zset/def).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const FAR_FUTURE = 4102444800000; // 2100-01-01,scheduler tick 永不触发

gate('57 · nexus management (agent lifecycle + schedule CRUD + token.status)', () => {
    let redis;
    let agentId;
    const SUB_STREAM = `EVENT:E2E:MGMT-${process.pid}`;
    const schedId = `e2e-mgmt-sched-${process.pid}`;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        // agent: data key + 注册集 + online TTL key + 订阅集成员
        if (agentId) {
            await redis.del(`NEXUS:SENTINEL:${agentId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', agentId);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${agentId}`);
            await redis.sRem(`NEXUS:SUB:${SUB_STREAM}`, agentId);
        }
        // schedule: RedisJSON def + zset 成员
        await redis.del(`NEXUS:SCHEDULE:DEF:${schedId}`);
        await redis.zRem('NEXUS:SCHEDULE', schedId);
        await redis.quit();
    });

    // ── agent 生命周期 ────────────────────────────────────────────────────────

    test('agent.create(reachability=null, 订阅一个 stream) → ACTIVE + 落库 + SUB 索引', async () => {
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-mgmt-agent-${process.pid}`,
            authorityRole: 'test:mgmt',
            eventSubscriptions: [SUB_STREAM],
            reachability: null,
        }, ADMIN_TOKEN), 'agent.create');
        agentId = a.id;
        expect(a.status).toBe('ACTIVE');
        await V.assertRecord(redis, `NEXUS:SENTINEL:${agentId}`, { status: 'ACTIVE' });
        expect(await redis.sIsMember('NEXUS:SENTINEL:SET', agentId)).toBeTruthy();
        // 订阅写入 NEXUS:SUB:{stream}
        expect(await redis.sIsMember(`NEXUS:SUB:${SUB_STREAM}`, agentId)).toBeTruthy();
        await V.assertNoErrors(redis, ['nexus']);
    }, 30_000);

    test('agent.heartbeat → 写 ONLINE TTL key + get 反映 online=true', async () => {
        const hb = V.assertResult(await rpc('nexus.sentinel.heartbeat', { sentinelId: agentId }, ADMIN_TOKEN), 'sentinel.heartbeat');
        expect(hb.sentinelId).toBe(agentId);
        expect(typeof hb.expiresInSeconds).toBe('number');
        expect(hb.expiresInSeconds).toBeGreaterThan(0);
        // 落库:ONLINE key 存在且带 TTL(EX=60s)
        expect(await redis.exists(`NEXUS:SENTINEL:ONLINE:${agentId}`)).toBe(1);
        const ttl = await redis.ttl(`NEXUS:SENTINEL:ONLINE:${agentId}`);
        expect(ttl).toBeGreaterThan(0);
        // get 反映 online + lastSeenAt 被写
        const got = V.assertResult(await rpc('nexus.sentinel.get', { id: agentId }, ADMIN_TOKEN), 'agent.get');
        expect(got.online).toBe(true);
        expect(typeof got.lastSeenAt).toBe('number');
    }, 30_000);

    test('agent.resolve(订阅的 stream) → 返回该 ACTIVE agent', async () => {
        const r = V.assertResult(await rpc('nexus.sentinel.resolve', { event: SUB_STREAM }, ADMIN_TOKEN), 'sentinel.resolve');
        expect(Array.isArray(r.sentinels)).toBe(true);
        const mine = r.sentinels.find((x) => x.sentinelId === agentId);
        expect(mine).toBeTruthy();
        expect(mine.name).toBe(`e2e-mgmt-agent-${process.pid}`);
    }, 30_000);

    test('agent.broadcast(reachability=null) → 契约:broadcasted=false,无 notification 副作用', async () => {
        // reachability 既非 sse 也非 webhook → broadcast 不调 relay,直接返回 false.
        // 这样测到 broadcast 方法的契约,又不触碰 system.nexus relay token(共享栈).
        const b = V.assertResult(await rpc('nexus.sentinel.broadcast', { id: agentId }, ADMIN_TOKEN), 'agent.broadcast');
        expect(b.id).toBe(agentId);
        expect(b.broadcasted).toBe(false);
        expect(typeof b.reason).toBe('string');
        await V.assertNoErrors(redis, ['nexus']);
    }, 30_000);

    test('agent.disable → DISABLED + resolve 不再返回它(只返回 ACTIVE)', async () => {
        const d = V.assertResult(await rpc('nexus.sentinel.disable', { id: agentId }, ADMIN_TOKEN), 'agent.disable');
        expect(d.id).toBe(agentId);
        expect(d.status).toBe('DISABLED');
        // 落库
        const rec = await V.readKey(redis, `NEXUS:SENTINEL:${agentId}`);
        expect(rec.status).toBe('DISABLED');
        // resolve 过滤掉非 ACTIVE
        const r = V.assertResult(await rpc('nexus.sentinel.resolve', { event: SUB_STREAM }, ADMIN_TOKEN), 'sentinel.resolve(after disable)');
        expect(r.sentinels.find((x) => x.sentinelId === agentId)).toBeFalsy();
    }, 30_000);

    // ── schedule CRUD(远未来 fire_at,绝不触发) ───────────────────────────────

    test('schedule.create → get / list / update(far future one-shot)', async () => {
        // create
        V.assertResult(await rpc('nexus.schedule.create', {
            schedule_id: schedId,
            fire_at: FAR_FUTURE,
            recurrence_ms: null,
            action: { kind: 'emit_event', stream: 'EVENT:E2E:MGMT', type: 'e2e.mgmt' },
            enabled: true,
        }, ADMIN_TOKEN), 'schedule.create');

        // get 反映写入
        const got = V.assertResult(await rpc('nexus.schedule.get', { schedule_id: schedId }, ADMIN_TOKEN), 'schedule.get');
        expect(got.schedule_id).toBe(schedId);
        expect(got.fire_at).toBe(FAR_FUTURE);
        expect(got.enabled).toBe(true);
        expect(got.recurrence_ms).toBeNull();

        // list 包含它
        const items = V.assertResult(await rpc('nexus.schedule.list', {}, ADMIN_TOKEN), 'schedule.list');
        expect(Array.isArray(items)).toBe(true);
        expect(items.some((x) => x.schedule_id === schedId)).toBe(true);

        // update:改 enabled=false + fire_at(仍远未来)→ 落库 + zset score 同步
        const NEW_FIRE = FAR_FUTURE + 86400000; // 2100-01-02,仍永不触发
        const upd = V.assertResult(await rpc('nexus.schedule.update', {
            schedule_id: schedId,
            enabled: false,
            fire_at: NEW_FIRE,
        }, ADMIN_TOKEN), 'schedule.update');
        expect(upd.enabled).toBe(false);
        expect(upd.fire_at).toBe(NEW_FIRE);
        // 落库(RedisJSON)+ zset score 跟着改
        const def = await redis.json.get(`NEXUS:SCHEDULE:DEF:${schedId}`);
        expect(def.enabled).toBe(false);
        expect(def.fire_at).toBe(NEW_FIRE);
        expect(await redis.zScore('NEXUS:SCHEDULE', schedId)).toBe(NEW_FIRE);
        await V.assertNoErrors(redis, ['nexus']);
    }, 30_000);

    // ── token.status(只读;绝不动 set/clear) ──────────────────────────────────

    test('token.status → 只读返回结构化状态(不泄漏 token)', async () => {
        const st = V.assertResult(await rpc('nexus.token.status', {}, ADMIN_TOKEN), 'token.status');
        // 绝不返回 token 串本身
        expect(st).not.toHaveProperty('token');
        expect(typeof st.hasToken).toBe('boolean');
        // full profile 的 seedBots 注入了 system.nexus relay token → hasToken=true.
        if (st.hasToken) {
            expect(st.sub).toBe('system.nexus');
            expect(typeof st.expiresAt).toBe('number');
            expect(typeof st.ttlMs).toBe('number');
            expect(typeof st.expired).toBe('boolean');
        }
    }, 30_000);

    // ── 共享栈不可跑的 admin 破坏性方法(不属 nexus,仅声明跳过原因) ─────────────
    // 注:这两个是 administrator 服务的方法,非 nexus;在此声明性 skip 以满足
    // "覆盖列表显式排除项"的留痕要求 —— 它们会废掉共享的 ADMIN_TOKEN / admin 服务.

    // eslint-disable-next-line jest/no-disabled-tests
    test.skip('admin.self.lock — SKIP:会锁死共享 ADMIN_TOKEN 背后的 admin 账号,破坏整个 e2e 栈', () => {});
    // eslint-disable-next-line jest/no-disabled-tests
    test.skip('admin.password.reset — SKIP:会改 admin 凭证,使后续套件的 ADMIN_TOKEN 失效,不可在共享栈跑', () => {});
});
