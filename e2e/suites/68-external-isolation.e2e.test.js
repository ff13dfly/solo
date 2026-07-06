/**
 * 68 · 外部主体接入 + 内外隔离(authority.md)—— 端到端.
 *
 * 验证"外部用户独立 identity → 共享角色 permit + 按人 owner 谓词"这套：
 *   ① 桥(user.passport.*):admin 定义外部角色 + 登记设备 proof;外部用户 public 验证 → 拿受限 session。
 *   ② 边界隔离(Router 零改、checkAccess):外部只能调角色 permit 列的方法,其余 FORBIDDEN。
 *   ③ 行隔离(collection 按 constraints.$owner 自 scope):外部 A 只看/改自己的行,看不到 B 的。
 *
 * full profile(需 user + collection + Router 全栈)。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const ROLE = `supplier-${process.pid}`;
const A = { anchor: `sup-A-${process.pid}`, deviceId: 'devA', deviceToken: `tokA-secret-${process.pid}` };
const B = { anchor: `sup-B-${process.pid}`, deviceId: 'devB', deviceToken: `tokB-secret-${process.pid}` };

gate('68 · external principal isolation (passport bridge + method wall + row isolation)', () => {
    let redis;
    let tokenA, tokenB;
    let payA, payB;   // ids of payments owned by A / B
    let op, plain;    // internal users for the permit-gating test

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        for (const anchor of [A.anchor, B.anchor]) {
            const toks = await redis.sMembers(`USER:SESSIONS:${anchor}`);
            for (const t of toks) await redis.del(`session:${t}`);
            await redis.del(`USER:SESSIONS:${anchor}`, `PASSPORT:SALT:${anchor}`, `PASSPORT:PROOFS:${anchor}`, `USER:PASSPORT:${anchor}`);
            await redis.sRem('USER:PASSPORT:IDS', anchor);
        }
        await redis.del(`USER:ROLE:${ROLE}`); await redis.sRem('USER:ROLE:IDS', ROLE);
        for (const pid of [payA, payB]) {
            if (pid) { await redis.del(`COLLECTION:PAYMENT:${pid}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', pid); }
        }
        for (const u of [op, plain]) { if (u) await cleanupUser(redis, u); }
        await redis.quit();
    });

    // ── ① 桥:定义外部角色 + 登记设备 + 验证铸票 ──────────────────────────────────

    test('admin defines role + onboards principals (role bound on the entity; app set)', async () => {
        // 统一角色 'supplier':只暴露 payment 的 record/list/get,带 owner 字段 ownerId.
        V.assertResult(await rpc('user.role.set', {
            role: ROLE,
            services: { collection: ['collection.payment.record', 'collection.payment.list', 'collection.payment.get'] },
            ownerField: 'ownerId',
            scope: 'external',
        }, ADMIN_TOKEN), 'role.set');

        // A 属 appX,B 属 appY —— 用于按外部应用区分.
        for (const { dev, app } of [{ dev: A, app: 'appX' }, { dev: B, app: 'appY' }]) {
            const r = V.assertResult(await rpc('user.passport.register', {
                anchor: dev.anchor, role: ROLE, app, deviceId: dev.deviceId, deviceToken: dev.deviceToken,
            }, ADMIN_TOKEN), `register ${dev.anchor}`);
            expect(r).toMatchObject({ anchor: dev.anchor, role: ROLE, app, status: 'ACTIVE' });
        }
    }, 30_000);

    test('external user verifies (public, no internal token; role read from entity) → restricted session', async () => {
        // 用 guest(无 token)调 public 方法,模拟外部用户.role 不传 —— 从实体读.
        const a = V.assertResult(await rpc('user.passport.verify', { ...A }), 'verify A');
        const b = V.assertResult(await rpc('user.passport.verify', { ...B }), 'verify B');
        expect(typeof a.token).toBe('string');
        expect(a.role).toBe(ROLE);   // 实体绑定的 role
        tokenA = a.token; tokenB = b.token;

        // 落库:session 存在、kind=external、permit 受限带 $owner
        const sess = await redis.get(`session:${tokenA}`);
        const parsed = JSON.parse(sess);
        expect(parsed.kind).toBe('external');
        expect(parsed.uid).toBe(A.anchor);
        expect(parsed.permit.allow_all).toBe(false);
        expect(parsed.permit.constraints.$owner).toEqual({ field: 'ownerId', value: A.anchor });

        // 错误凭证 → 拒
        const bad = await rpc('user.passport.verify', { ...A, deviceToken: 'wrong' });
        expect(bad.error).toBeTruthy();
    }, 30_000);

    test('management: list + get + distinguish by external app', async () => {
        const listed = V.assertResult(await rpc('user.passport.list', {}, ADMIN_TOKEN), 'passport.list');
        const ids = listed.items.map((x) => x.id);
        expect(ids).toContain(A.anchor);
        expect(ids).toContain(B.anchor);

        const got = V.assertResult(await rpc('user.passport.get', { anchor: A.anchor }, ADMIN_TOKEN), 'passport.get');
        expect(got.role).toBe(ROLE);
        expect(got.app).toBe('appX');
        expect(got.status).toBe('ACTIVE');
        expect(got.devices).toContain(A.deviceId);   // device ids only

        // 按 app 区分:list({app:'appX'}) 只出 A,不出 B
        const appX = V.assertResult(await rpc('user.passport.list', { app: 'appX' }, ADMIN_TOKEN), 'list appX');
        const appXids = appX.items.map((x) => x.id);
        expect(appXids).toContain(A.anchor);
        expect(appXids).not.toContain(B.anchor);
    }, 30_000);

    // ── ② 边界隔离:方法墙 ────────────────────────────────────────────────────────

    test('method wall: exposed method works; non-exposed → FORBIDDEN', async () => {
        // 暴露的方法可用
        const p = V.assertResult(await rpc('collection.payment.record', { amount: 100, currency: 'CNY', orderId: `A-${process.pid}` }, tokenA), 'A record');
        payA = p.id;
        expect(p.state).toBe('RECEIVED');

        // settle 不在角色 permit → FORBIDDEN
        const settle = await rpc('collection.payment.settle', { id: payA }, tokenA);
        expect(settle.error).toBeTruthy();
        expect(String(settle.error.message)).toMatch(/forbidden/i);

        // 完全不沾边的内部方法 → FORBIDDEN(user 不在 permit.services)
        const internal = await rpc('user.account.list', {}, tokenA);
        expect(internal.error).toBeTruthy();
        expect(String(internal.error.message)).toMatch(/forbidden/i);
    }, 30_000);

    // ── ③ 行隔离:外部 A / B 互不可见 ─────────────────────────────────────────────

    test('row isolation: A and B see only their own rows', async () => {
        // B 记一笔(归 B)
        const pB = V.assertResult(await rpc('collection.payment.record', { amount: 200, currency: 'CNY', orderId: `B-${process.pid}` }, tokenB), 'B record');
        payB = pB.id;

        // 落库:各自盖了 ownerId 戳
        await V.assertRecord(redis, `COLLECTION:PAYMENT:${payA}`, { ownerId: A.anchor });
        await V.assertRecord(redis, `COLLECTION:PAYMENT:${payB}`, { ownerId: B.anchor });

        // A 的 list 只出 A 的;不含 B 的
        const listA = V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, tokenA), 'A list');
        const idsA = listA.items.map((x) => x.id);
        expect(idsA).toContain(payA);
        expect(idsA).not.toContain(payB);

        // B 的 list 只出 B 的
        const listB = V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, tokenB), 'B list');
        const idsB = listB.items.map((x) => x.id);
        expect(idsB).toContain(payB);
        expect(idsB).not.toContain(payA);

        // A 直接 get B 的 id → NOT_FOUND(拿不到别人的行)
        const cross = await rpc('collection.payment.get', { id: payB }, tokenA);
        expect(cross.error).toBeTruthy();

        // A get 自己的 → ok
        const own = V.assertResult(await rpc('collection.payment.get', { id: payA }, tokenA), 'A get own');
        expect(own.id).toBe(payA);
    }, 30_000);

    // ── 内部不受影响:admin 仍看得到全部 ─────────────────────────────────────────

    test('internal/admin is NOT scoped (sees both rows)', async () => {
        const all = V.assertResult(await rpc('collection.payment.list', { pageSize: 1000 }, ADMIN_TOKEN), 'admin list');
        const ids = all.items.map((x) => x.id);
        expect(ids).toContain(payA);
        expect(ids).toContain(payB);   // admin 无 $owner → 不 scope,两条都在
    }, 30_000);

    // ── 管理是按 permit 放行的(非硬 isAdmin)→ operator 也能处理 ─────────────────

    test('permit-gated: operator with user.passport.* in permit can manage; per-method; no-permit → FORBIDDEN', async () => {
        // 非 admin operator,permit 只授 list/get(没授 disable)
        op = await sessionUser(redis, `op-${process.pid}`, { user: ['user.passport.list', 'user.passport.get'] });
        const listed = V.assertResult(await rpc('user.passport.list', {}, op.token), 'op list');
        expect(listed.items.map((x) => x.id)).toContain(A.anchor);
        V.assertResult(await rpc('user.passport.get', { anchor: A.anchor }, op.token), 'op get');

        // 没授的方法(disable)→ Router checkAccess FORBIDDEN(细粒度按方法授权生效)
        const dis = await rpc('user.passport.disable', { anchor: A.anchor }, op.token);
        expect(dis.error).toBeTruthy();
        expect(String(dis.error.message)).toMatch(/forbidden/i);

        // 完全没有 passport permit 的普通用户 → 连 list 都 FORBIDDEN
        plain = await sessionUser(redis, `plain-${process.pid}`, { collection: ['collection.payment.list'] });
        const denied = await rpc('user.passport.list', {}, plain.token);
        expect(denied.error).toBeTruthy();
    }, 30_000);

    // ── ④ 管理:禁用一个外部主体 → 吊销其 session + 拒绝再认证 ───────────────────

    test('disable a principal → its live session is revoked + re-verify denied', async () => {
        const d = V.assertResult(await rpc('user.passport.disable', { anchor: A.anchor }, ADMIN_TOKEN), 'disable A');
        expect(d.status).toBe('DISABLED');
        expect(d.revoked).toBeGreaterThanOrEqual(1);   // A 的 live session 被吊销

        // A 旧 token 失效 → 调用被拒(session 没了 → guest → AUTH_REQUIRED/FORBIDDEN)
        const afterRevoke = await rpc('collection.payment.list', { pageSize: 10 }, tokenA);
        expect(afterRevoke.error).toBeTruthy();

        // A 再认证 → 拒(实体 DISABLED)
        const reVerify = await rpc('user.passport.verify', { ...A });
        expect(reVerify.error).toBeTruthy();

        // B 不受影响
        const bOk = V.assertResult(await rpc('collection.payment.list', { pageSize: 10 }, tokenB), 'B still ok');
        expect(Array.isArray(bOk.items)).toBe(true);
    }, 30_000);
});
