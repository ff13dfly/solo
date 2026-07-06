/**
 * 21 · storage 资产 CRUD(四连断言;full profile).
 * upload(base64)→ ①API ②落库(STORAGE:ASSET + ZSET 索引)③WAL(user=调用方)④无异常.
 * 索引是 ZSET(STORAGE:ASSETS:SORTED),用 zScore 而非 sIsMember;createdAt 是 ISO 串.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('21 · storage asset (four-layer)', () => {
    let redis, uid, token;
    const name = `e2e-storage-${process.pid}`;
    const made = [];

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { storage: ['*'] }));
    }, 20_000);
    afterAll(async () => {
        for (const a of made) { await redis.del(`STORAGE:ASSET:${a.id}`); await redis.zRem('STORAGE:ASSETS:SORTED', a.id); if (a.sha256) await redis.del(`STORAGE:SHA256:${a.sha256}`); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('upload → ①API ②落库(+ZSET 索引)③WAL', async () => {
        const file = Buffer.from(`hello e2e storage ${process.pid}`).toString('base64');
        const a = V.assertResult(await rpc('storage.asset.upload', { file, filename: 'e2e.txt', mimeType: 'text/plain' }, token), 'upload');
        made.push({ id: a.id, sha256: a.sha256 });
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);

        const key = `STORAGE:ASSET:${a.id}`;
        await V.assertRecord(redis, key, { mimeType: 'text/plain', sha256: a.sha256 });   // ② 落库
        expect(await redis.zScore('STORAGE:ASSETS:SORTED', a.id)).not.toBeNull();          // ② ZSET 索引
        // storage 用自定义 redis.set(非 entity factory)→ 无 entity WAL,故不断言 ③ WAL.
        await V.assertNoErrors(redis, ['storage']);                                       // ③ 无 error
    });

    test('get / resolve / list reflect the asset', async () => {
        const id = made[0].id;
        expect(V.assertResult(await rpc('storage.asset.get', { id }, token)).id).toBe(id);
        // resolve returns a CONTENT-addressed OSS URL (CAS) — keyed by sha256 (2/2/2 layout),
        // NOT by asset id. Strip the path separators and the sha256 is recovered → ties the
        // URL to THIS asset's bytes (the pre-CAS `url.toContain(id)` assumption was stale).
        const resolved = V.assertResult(await rpc('storage.asset.resolve', { id }, token)).url;
        expect(typeof resolved).toBe('string');
        expect(resolved.replace(/\//g, '')).toContain(made[0].sha256);
        expect(V.assertResult(await rpc('storage.asset.list', { page: 1 }, token)).items.some((x) => x.id === id)).toBe(true);
    });
});
