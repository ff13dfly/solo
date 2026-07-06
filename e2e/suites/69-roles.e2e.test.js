/**
 * 69 · 角色(RBAC,authority.md)—— assign 把角色 permit **物化**到内部用户上.
 *
 * 验证用户说的那个本质:role = 设 permit 的模板;`user.role.assign` 把角色的 permit
 * 写到 `user:{uid}.permit`,**请求时只读用户自己的 permit(Scheme F),不在运行时查 role**。
 * 改角色 + 重新 assign → 用户 permit 重新物化。
 *
 * full profile(需 user + collection + Router).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN, sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

const ROLE = `ops-${process.pid}`;

gate('69 · roles — assign materializes a role permit onto an internal user', () => {
    let redis;
    let u;   // internal user

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        await redis.del(`USER:ROLE:${ROLE}`); await redis.sRem('USER:ROLE:IDS', ROLE);
        if (u) await cleanupUser(redis, u);
        await redis.quit();
    });

    test('define a role (named permit template)', async () => {
        const r = V.assertResult(await rpc('user.role.set', {
            role: ROLE, services: { collection: ['collection.payment.list'] }, scope: 'internal',
        }, ADMIN_TOKEN), 'role.set');
        expect(r.role).toBe(ROLE);
        const got = V.assertResult(await rpc('user.role.get', { role: ROLE }, ADMIN_TOKEN), 'role.get');
        expect(got.services).toEqual({ collection: ['collection.payment.list'] });
    }, 30_000);

    test('before assign: a fresh internal user has no permit → FORBIDDEN', async () => {
        u = await sessionUser(redis, `ru-${process.pid}`);   // default empty permit
        const denied = await rpc('collection.payment.list', { pageSize: 5 }, u.token);
        expect(denied.error).toBeTruthy();
    }, 30_000);

    test('assign materializes the permit onto user.permit → user can call role methods; others FORBIDDEN', async () => {
        V.assertResult(await rpc('user.role.assign', { uid: u.uid, role: ROLE }, ADMIN_TOKEN), 'role.assign');

        // 落库:user.permit 被物化成角色的 permit(运行时不查 role,只读这份)
        const rec = await V.readKey(redis, `user:${u.uid}`);
        expect(rec.permit.services).toEqual({ collection: ['collection.payment.list'] });
        expect(rec.role).toBe(ROLE);   // RBAC 轴写 user.role;tier 在 categories.POWER,另一回事

        // 同一个旧 token,Scheme F 实时读到物化后的 permit → 现在能调 list
        const ok = V.assertResult(await rpc('collection.payment.list', { pageSize: 5 }, u.token), 'list after assign');
        expect(Array.isArray(ok.items)).toBe(true);

        // 角色没给的方法 → 仍 FORBIDDEN(get / settle 都不在)
        const get = await rpc('collection.payment.get', { id: 'nope' }, u.token);
        expect(get.error).toBeTruthy();
        expect(String(get.error.message)).toMatch(/forbidden/i);
    }, 30_000);

    test('edit role + re-assign → user permit re-materialized (picks up the new method)', async () => {
        V.assertResult(await rpc('user.role.set', {
            role: ROLE, services: { collection: ['collection.payment.list', 'collection.payment.get'] },
        }, ADMIN_TOKEN), 'role.set edit');
        V.assertResult(await rpc('user.role.assign', { uid: u.uid, role: ROLE }, ADMIN_TOKEN), 're-assign');

        const rec = await V.readKey(redis, `user:${u.uid}`);
        expect(rec.permit.services).toEqual({ collection: ['collection.payment.list', 'collection.payment.get'] });

        // get 现在权限通了(到达了 collection;报错也只是 not-found,不再是 FORBIDDEN)
        const get = await rpc('collection.payment.get', { id: 'nope' }, u.token);
        if (get.error) expect(String(get.error.message)).not.toMatch(/forbidden/i);
    }, 30_000);
});
