/**
 * 28 · user 管理面:admin 读 + bot 生命周期 + permit self-read(Task A 的修复).
 * 避开 category(会 RPC Router system.category.reserve,非 hermetic)和 destroy/remove(危险).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser, ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('28 · user admin surface + bot lifecycle + self-read', () => {
    let redis, uid, token;
    const name = `e2e-user-${process.pid}`;
    const botUid = `system.e2e-bot-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { user: ['user.permit.get'] }));
    }, 20_000);
    afterAll(async () => {
        await redis.del(`user:bot:${botUid}`); await redis.sRem('user:bot:ids', botUid);
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('admin reads: account.status / account.list / bot.list', async () => {
        const st = V.assertResult(await rpc('user.account.status', {}, ADMIN_TOKEN), 'account.status');
        expect(typeof st.total).toBe('number');
        expect(V.assertResult(await rpc('user.account.list', { page: 1 }, ADMIN_TOKEN), 'account.list')).toBeTruthy();
        expect(Array.isArray(V.assertResult(await rpc('user.bot.list', {}, ADMIN_TOKEN), 'bot.list').items)).toBe(true);
    });

    test('bot lifecycle: create → ②落库(+SET 索引)→ get → update permit', async () => {
        V.assertResult(await rpc('user.bot.create', { uid: botUid, permit: { allow_all: false, services: { example: ['m1'] } }, desc: 'e2e bot' }, ADMIN_TOKEN), 'bot.create');
        await V.assertRecord(redis, `user:bot:${botUid}`, { id: botUid, type: 'bot', status: 'ACTIVE' });   // ②
        expect(await redis.sIsMember('user:bot:ids', botUid)).toBeTruthy();

        const got = V.assertResult(await rpc('user.bot.get', { uid: botUid }, ADMIN_TOKEN), 'bot.get');
        expect(got.id).toBe(botUid);

        V.assertResult(await rpc('user.bot.update', { uid: botUid, permit: { allow_all: false, services: { example: ['m1', 'm2'] } } }, ADMIN_TOKEN), 'bot.update');
        const after = await V.readKey(redis, `user:bot:${botUid}`);
        expect(after.permit.services.example).toContain('m2');
        await V.assertNoErrors(redis, ['user']);

        V.assertResult(await rpc('user.bot.delete', { uid: botUid }, ADMIN_TOKEN), 'bot.delete');
        expect(await redis.exists(`user:bot:${botUid}`)).toBe(0);
    });

    test('permit self-read allowed; reading others is forbidden (non-admin)', async () => {
        const self = V.assertResult(await rpc('user.permit.get', { uid }, token), 'self permit.get');
        expect(self.uid).toBe(uid);   // 自读自己的 permit:放行(Task A 修复)
        const other = await rpc('user.permit.get', { uid: 'e2e-admin' }, token);
        V.assertRpcError(other, undefined, 'non-admin reading others permit must fail');
    });
});
