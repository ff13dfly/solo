/**
 * 70 · tier role(账号层级,authority.md)—— portal/operator 登录门禁的后端契约.
 *
 * 与 RBAC(`user.role.*`,管"能调哪些方法")正交:tier role(`categories.POWER`:admin/operator/normal)
 * 管"哪种用户 / 能进哪个台"。portal/operator 登录后从 `user.login.verify` 的返回里直接读
 * `categories.POWER`(不再单独调 `user.profile`——那方法已收敛为 permit 门控,新 operator 无该授权),
 * 不是 operator 就拒进运维台(`portal/operator/src/pages/Login.tsx`).
 *
 * 本套覆盖那条后端契约(登录即带 tier)+ 证明 tier 与 RBAC 是两个独立的轴(改 RBAC 不动 tier)。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, createAndLogin, loginOnly, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const RBAC_ROLE = `r-${process.pid}`;

gate('70 · operator tier role (portal-access gate contract) + axis independence', () => {
    let redis;
    let op, normal;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        await redis.del(`USER:ROLE:${RBAC_ROLE}`); await redis.sRem('USER:ROLE:IDS', RBAC_ROLE);
        for (const u of [op, normal]) { if (u) await cleanupUser(redis, u); }
        await redis.quit();
    });

    test('user with tier=operator → login.verify surfaces categories.POWER=operator (what the operator portal gates on)', async () => {
        op = await createAndLogin({ name: `optier-${process.pid}` });   // 真实挑战-响应登录
        // admin 设 tier(= portal/system UserManagement 的"层级"下拉,写 categories.POWER)
        V.assertResult(await rpc('user.account.update', { uid: op.uid, categories: { POWER: 'operator' } }, ADMIN_TOKEN), 'set tier');

        // portal/operator 登录后从 login.verify 返回里读 categories.POWER(不再单独调 user.profile)
        const relogin = await loginOnly({ name: op.name });
        expect((relogin.categories || {}).POWER).toBe('operator');   // 门禁通过条件
    }, 30_000);

    test('normal user has no operator tier → operator portal gate would reject', async () => {
        normal = await createAndLogin({ name: `normaltier-${process.pid}` });
        // createAndLogin 已完成一次真实登录 → 返回的 categories 就是 login.verify 给门户的那份
        const tier = ((normal.categories || {}).POWER || '').toLowerCase();
        expect(tier).not.toBe('operator');   // Login.tsx 会拒
    }, 30_000);

    test('tier (categories.POWER) and RBAC (user.role) are INDEPENDENT axes', async () => {
        // 给同一个 operator 用户分配一个 RBAC 角色 → 只动 permit/user.role,绝不动 tier(POWER)
        V.assertResult(await rpc('user.role.set', { role: RBAC_ROLE, services: { collection: ['collection.payment.list'] } }, ADMIN_TOKEN), 'role.set');
        V.assertResult(await rpc('user.role.assign', { uid: op.uid, role: RBAC_ROLE }, ADMIN_TOKEN), 'role.assign');

        const rec = await V.readKey(redis, `user:${op.uid}`);
        expect(rec.role).toBe(RBAC_ROLE);                           // RBAC 轴:动了
        expect(rec.permit.services).toEqual({ collection: ['collection.payment.list'] });
        expect((rec.categories || {}).POWER).toBe('operator');      // tier 轴(POWER):没被碰
    }, 30_000);
});
