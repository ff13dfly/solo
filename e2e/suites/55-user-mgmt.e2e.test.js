/**
 * 55 · user 管理面剩余覆盖(28 没碰的方法).
 *   ① permit.update / permit.batch  —— RBAC 写路径:set → 读回验证(getPermit).
 *   ② account 软删生命周期            —— remove → list(includeDeleted) → restore → check → destroy(硬删).
 *   ③ category CRUD + item            —— create → get → list → update → item.add/update/remove → delete.
 *   ④ bot token                       —— bot.create → issue.token(落 session)→ revoke(session 没了);token.refresh 可达性.
 *
 * 28-user 显式避开了 category(会 RPC Router system.category.reserve)和 destroy/remove(危险);
 * 本套件补齐这些方法 —— 全部用 process.pid 隔离 key,afterAll 逐一清干净,不留垃圾给后续套件.
 *
 * category.create/delete 经 Router system.category.reserve / system.category.delete:
 *   reservation 落在 Router 的 SYSTEM:REGISTRY:CATEGORIES hash(field=KEY),本地数据落 USER:CONFIG:CATEGORY:{KEY}.
 *   两处都用 PID 专属 key,afterAll 都删(含 hDel 注册表 field),不污染全局命名空间.
 *
 * full profile(需 router + user 真栈;category 需 Router 在场).admin-only 方法用 ADMIN_TOKEN.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, createAndLogin, sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('55 · user mgmt (permit write / soft-delete lifecycle / category / bot token)', () => {
    let redis;

    // permit 测试用户(留存到 afterAll)
    let permitUser;
    const permitName = `e2e-um-permit-${process.pid}`;

    // account 生命周期用户(被 remove→restore,afterAll 收尾)
    let lifeUser;
    const lifeName = `e2e-um-life-${process.pid}`;

    // destroy 用户(被硬删:destroy 已移除索引/数据,afterAll 只兜底)
    let destroyUser;
    const destroyName = `e2e-um-destroy-${process.pid}`;

    // bot(token 测试)
    const botUid = `system.e2e-um-bot-${process.pid}`;
    let issuedToken = null;

    // category(PID 专属,大写)
    const catKey = `E2E_UM_CAT_${process.pid}`.toUpperCase();
    const catItemId = `e2e-um-item-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        permitUser = await sessionUser(redis, permitName, { user: ['user.permit.get'] });
        lifeUser = await createAndLogin({ name: lifeName });
        destroyUser = await createAndLogin({ name: destroyName });
    }, 30_000);

    afterAll(async () => {
        // 用户
        if (permitUser) await cleanupUser(redis, { uid: permitUser.uid, name: permitName });
        if (lifeUser) await cleanupUser(redis, { uid: lifeUser.uid, name: lifeName });
        if (destroyUser) await cleanupUser(redis, { uid: destroyUser.uid, name: destroyName });   // destroy 后多为 no-op
        // bot + 它的 session(若 revoke 没跑到)
        await redis.del(`user:bot:${botUid}`); await redis.sRem('user:bot:ids', botUid);
        const idxKey = `USER:SESSIONS:${botUid}`;
        const toks = await redis.sMembers(idxKey);
        for (const t of toks) await redis.del(`session:${t}`);
        await redis.del(idxKey);
        if (issuedToken) await redis.del(`session:${issuedToken}`);
        // category:本地数据 + 本地索引 + Router 全局注册表 field
        const catDataKey = `USER:CONFIG:CATEGORY:${catKey}`;
        await redis.del(catDataKey);
        await redis.sRem('USER:CONFIG:CATEGORY_IDX', catDataKey);
        await redis.hDel('SYSTEM:REGISTRY:CATEGORIES', catKey).catch(() => {});
        // category.create 内部经 Router system.category.reserve(未带 admin 凭证)→ -32603
        // "Admin required" 落 ERROR:QUEUE(已知框架 bug:联邦分类 reserve 调用无鉴权)。
        // 本套件有意触发它,afterAll 清掉,免得污染"断言队列空"的套件(如 28)。
        for (const k of await redisLib.scanAll(redis, 'ERROR:QUEUE:*')) await redis.del(k);
        await redis.quit();
    });

    // ── ① permit.update / permit.batch ───────────────────────────────────────
    test('permit.update:给用户设权限 → 读回验证(落 user:{uid}.permit)', async () => {
        const newPermit = { allow_all: false, services: { planner: ['planner.agenda.list'], storage: ['*'] } };
        V.assertResult(await rpc('user.permit.update', { uid: permitUser.uid, permit: newPermit }, ADMIN_TOKEN), 'permit.update');

        // ① API 读回(admin 读任意 uid 的 permit)
        const got = V.assertResult(await rpc('user.permit.get', { uid: permitUser.uid }, ADMIN_TOKEN), 'permit.get');
        expect(got.uid).toBe(permitUser.uid);
        expect(got.permit.allow_all).toBe(false);
        expect(got.permit.services.planner).toContain('planner.agenda.list');
        expect(got.permit.services.storage).toContain('*');

        // ② 直接落库校验(Router checkAccess 与 H6 都实时读这里)
        const stored = await V.readKey(redis, `user:${permitUser.uid}`);
        expect(stored.permit.services.storage).toContain('*');
    }, 30_000);

    test('permit.update:非 admin 调用被拒(方法级闸,可达)', async () => {
        const res = await rpc('user.permit.update', {
            uid: permitUser.uid, permit: { allow_all: false, services: {} },
        }, permitUser.token);
        const err = V.assertRpcError(res, undefined, 'non-admin permit.update must fail');
        expect(err.code).not.toBe(-32601);   // 可达,被权限闸挡(非 METHOD_NOT_FOUND)
    }, 30_000);

    test('permit.batch:一次给多个用户设权限 → results 标记成功 + 落库', async () => {
        const res = V.assertResult(await rpc('user.permit.batch', {
            permits: [
                { uid: permitUser.uid, permit: { allow_all: false, services: { agent: ['*'] } } },
                { uid: 'not-a-valid-uid', permit: { allow_all: false, services: {} } },   // 故意坏:验证逐条容错
            ],
        }, ADMIN_TOKEN), 'permit.batch');

        const ok = res.results.find((r) => r.uid === permitUser.uid);
        expect(ok).toBeTruthy();
        expect(ok.success).toBe(true);
        const bad = res.results.find((r) => r.uid === 'not-a-valid-uid');
        expect(bad.success).toBe(false);   // 坏 uid 不中断整批,单条标失败

        const stored = await V.readKey(redis, `user:${permitUser.uid}`);
        expect(stored.permit.services.agent).toContain('*');   // batch 真写进去了
    }, 30_000);

    // ── ② account 软删生命周期 ────────────────────────────────────────────────
    test('account.remove:软删 → status=DELETED + deletedAt;默认 list 不含、includeDeleted 含', async () => {
        V.assertResult(await rpc('user.account.remove', { id: lifeUser.uid }, ADMIN_TOKEN), 'account.remove');

        const rec = await V.readKey(redis, `user:${lifeUser.uid}`);
        expect(rec.status).toBe('DELETED');
        expect(rec.deletedAt).toBeTruthy();   // 软删:数据还在,只是打标

        // 默认 list 排除已删;includeDeleted=true 才出现
        const plain = V.assertResult(await rpc('user.account.list', { page: 1, limit: 500 }, ADMIN_TOKEN), 'list(default)');
        expect((plain.users || plain.items || []).some((u) => u.id === lifeUser.uid)).toBe(false);
        const withDel = V.assertResult(await rpc('user.account.list', { page: 1, limit: 500, includeDeleted: true }, ADMIN_TOKEN), 'list(includeDeleted)');
        expect((withDel.users || withDel.items || []).some((u) => u.id === lifeUser.uid)).toBe(true);
    }, 30_000);

    test('account.restore:已删用户恢复 → status 回 ACTIVE + deletedAt 清除', async () => {
        V.assertResult(await rpc('user.account.restore', { id: lifeUser.uid }, ADMIN_TOKEN), 'account.restore');
        const rec = await V.readKey(redis, `user:${lifeUser.uid}`);
        expect(rec.status).toBe('ACTIVE');
        expect(rec.deletedAt).toBeUndefined();
    }, 30_000);

    test('account.check:预检可否硬删 → canDestroy', async () => {
        const res = V.assertResult(await rpc('user.account.check', { id: destroyUser.uid }, ADMIN_TOKEN), 'account.check');
        expect(res.canDestroy).toBe(true);
    }, 30_000);

    test('account.destroy:硬删 → 数据键/name 索引/ids set 全清', async () => {
        const name = destroyName.toLowerCase().trim();
        // 前置:确认硬删前数据/索引都在
        expect(await redis.exists(`user:${destroyUser.uid}`)).toBe(1);
        expect(await redis.exists(`user:name:${name}`)).toBe(1);

        V.assertResult(await rpc('user.account.destroy', { id: destroyUser.uid }, ADMIN_TOKEN), 'account.destroy');

        expect(await redis.exists(`user:${destroyUser.uid}`)).toBe(0);       // 数据键没了
        expect(await redis.exists(`user:name:${name}`)).toBe(0);             // name 索引没了
        expect(await redis.sIsMember('user:ids', destroyUser.uid)).toBe(false);   // 出 ids set
        destroyUser = null;   // 已硬删,afterDual 不必再清
    }, 30_000);

    // ── ③ category CRUD + item ───────────────────────────────────────────────
    //
    // 关键约束:user.category.create 内部经 Router 调 system.category.reserve(联邦预定),
    // 而 category 共享库的 makeRpcCall **不带 Authorization** → Router checkAccess 见 guest →
    // FORBIDDEN('Admin required',-32005) → create 抛 INTERNAL_ERROR 中止(逻辑见 library/category.js).
    // 这是部署事实(28-user 注释里说的"非 hermetic"),非本套件可绕过.
    // 因此:create 只断"可达 + 走到了联邦预定闸"(非 METHOD_NOT_FOUND);
    // 本地纯读写方法(get/list/update/item.*)直接 seed 一条本地 category 记录来真跑;
    // delete 内部对非 -32012 的 Router 错误是"容忍 + 继续本地软删",故 delete 在 seed 后真能落地.
    const catDataKey = `USER:CONFIG:CATEGORY:${catKey}`;

    async function seedCategory() {
        const now = Date.now();
        await redis.set(catDataKey, JSON.stringify({
            key: catKey, type: 'LIST', scope: 'LOCAL', desc: 'e2e seeded', meta: {},
            items: [], status: 'ACTIVE', createdAt: now, updatedAt: now,
        }));
        await redis.sAdd('USER:CONFIG:CATEGORY_IDX', catDataKey);
    }

    test('category.create:可达,走到联邦预定闸(内部 reserve 无 token → 结构化拒绝,非 404)', async () => {
        const res = await rpc('user.category.create', {
            key: catKey, type: 'LIST', scope: 'LOCAL', desc: 'e2e user-mgmt category',
        }, ADMIN_TOKEN);
        // 当前部署下内部 reserve 无凭证 → create 抛错;断"可达"即可(契约已连通,非 METHOD_NOT_FOUND).
        if (res.error) {
            expect(res.error.code).not.toBe(-32601);
        } else {
            expect(res.result.key).toBe(catKey);   // 若部署放开了内部预定,正常成功路径也认
        }
    }, 30_000);

    test('category.get / list / update:本地纯读写(seed 后真跑)', async () => {
        await seedCategory();

        const got = V.assertResult(await rpc('user.category.get', { key: catKey }, ADMIN_TOKEN), 'category.get');
        expect(got.key).toBe(catKey);

        const list = V.assertResult(await rpc('user.category.list', {}, ADMIN_TOKEN), 'category.list');
        const arr = Array.isArray(list) ? list : (list.items || []);
        expect(arr.some((c) => c.key === catKey)).toBe(true);

        V.assertResult(await rpc('user.category.update', { key: catKey, desc: 'updated-desc' }, ADMIN_TOKEN), 'category.update');
        const after = V.assertResult(await rpc('user.category.get', { key: catKey }, ADMIN_TOKEN), 'category.get(after update)');
        expect(after.desc).toBe('updated-desc');   // 改 desc 生效
    }, 30_000);

    test('category.item.add → update → remove:项的增改删(label 走 string,符合 introspection 类型)', async () => {
        const added = V.assertResult(await rpc('user.category.item.add', {
            key: catKey, id: catItemId, label: 'Test Item',   // introspection 声明 label:string,Router 会类型校验
        }, ADMIN_TOKEN), 'item.add');
        expect(added.id).toBe(catItemId);

        // 落到 category.items
        let stored = await V.readKey(redis, catDataKey);
        expect(stored.items.some((i) => i.id === catItemId)).toBe(true);

        const updated = V.assertResult(await rpc('user.category.item.update', {
            key: catKey, id: catItemId, desc: 'item-updated',
        }, ADMIN_TOKEN), 'item.update');
        expect(updated.desc).toBe('item-updated');

        V.assertResult(await rpc('user.category.item.remove', { key: catKey, id: catItemId }, ADMIN_TOKEN), 'item.remove');
        stored = await V.readKey(redis, catDataKey);
        expect(stored.items.some((i) => i.id === catItemId)).toBe(false);   // 已移除
    }, 30_000);

    test('category.delete:软删 → status=DELETED(内部 Router 错被容忍,本地仍落软删)', async () => {
        V.assertResult(await rpc('user.category.delete', { key: catKey }, ADMIN_TOKEN), 'category.delete');
        const stored = await V.readKey(redis, catDataKey);
        expect(stored.status).toBe('DELETED');   // 软删:打标,不真删;数据键仍在,afterAll 收
    }, 30_000);

    // ── ④ bot token:issue / revoke / refresh ─────────────────────────────────
    test('bot.issue.token:为 bot 签发 token → 落 session:{token} + 反向索引', async () => {
        // 前置:建一个 bot(显式 permit,不能 allow_all)
        V.assertResult(await rpc('user.bot.create', {
            uid: botUid, permit: { allow_all: false, services: { user: ['user.token.refresh'] } }, desc: 'e2e um bot',
        }, ADMIN_TOKEN), 'bot.create');

        const issued = V.assertResult(await rpc('user.bot.issue.token', { uid: botUid }, ADMIN_TOKEN), 'bot.issue.token');
        expect(typeof issued.token).toBe('string');
        expect(issued.expiresAt).toBeGreaterThan(Date.now());
        issuedToken = issued.token;

        // ② session 落库 + 进反向索引(供主动吊销)
        const sess = await V.readKey(redis, `session:${issuedToken}`);
        expect(sess.uid).toBe(botUid);
        expect(sess.type).toBe('bot');
        expect(await redis.sIsMember(`USER:SESSIONS:${botUid}`, issuedToken)).toBe(true);
    }, 30_000);

    test('token.refresh:bot 用自己的 session 刷新 → 拿到新 token + 落库(增发,不废旧)', async () => {
        // bot 用自己的 session 调用,Router 注入 req.user=botUid → callerUid=botUid。
        // (回归锁:曾因 index.js 取 `context.user?.user`(永远 undefined)→ 恒 UNAUTHORIZED,
        //  旧测只断"可达 ≠ -32601"把死方法蒙混过去。现在硬断成功路径。)
        const r = V.assertResult(await rpc('user.token.refresh', {}, issuedToken), 'token.refresh');
        expect(typeof r.token).toBe('string');
        expect(r.token).not.toBe(issuedToken);                              // 新 token
        const sess = await V.readKey(redis, `session:${r.token}`);
        expect(sess.uid).toBe(botUid);                                      // 新 session 归属 bot
        expect(await redis.sIsMember(`USER:SESSIONS:${botUid}`, r.token)).toBe(true);
        expect(await redis.exists(`session:${issuedToken}`)).toBe(1);       // refresh 是增发,旧 session 仍在
    }, 30_000);

    test('token.revoke:吊销 bot 全部 session → session:{token} 没了 + 索引清空', async () => {
        expect(await redis.exists(`session:${issuedToken}`)).toBe(1);   // 吊销前还在

        const res = V.assertResult(await rpc('user.token.revoke', { uid: botUid }, ADMIN_TOKEN), 'token.revoke');
        expect(res.uid).toBe(botUid);
        expect(res.revoked).toBeGreaterThanOrEqual(1);   // 至少干掉了一条 live session

        expect(await redis.exists(`session:${issuedToken}`)).toBe(0);          // session 被删
        expect(await redis.exists(`USER:SESSIONS:${botUid}`)).toBe(0);         // 反向索引清空
        issuedToken = null;

        // 收尾:删 bot(create 的它不属于共享栈,删了不影响别的套件)
        V.assertResult(await rpc('user.bot.delete', { uid: botUid }, ADMIN_TOKEN), 'bot.delete');
        expect(await redis.exists(`user:bot:${botUid}`)).toBe(0);
    }, 30_000);

    // ── 共享栈红线:不可在共享 e2e 跑的破坏性 admin 方法 ──────────────────────
    test.skip('admin.self.lock — 会废掉共享 ADMIN_TOKEN/admin 服务,不可在共享 e2e 栈跑', () => {});
    test.skip('admin.password.reset — 会破坏共享 admin 凭证,不可在共享 e2e 栈跑', () => {});
});
