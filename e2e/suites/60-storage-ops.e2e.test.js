/**
 * 60 · storage 运维方法(当前无 e2e 覆盖的三个):asset.delete / asset.multi / thumbnail.rebuild.
 * 21-storage 只覆盖 upload/get/resolve/list;本套补全删除、批量解析、缩略图重建.
 *
 * 串法:每个用例自己 upload 一个独立内容(带 pid,避免 CAS 去重命中别套件的资产)再操作.
 * 落库真相(api/apps/storage/logic/asset.js + config.js):
 *   - 元数据 key  = STORAGE:ASSET:<id>(自定义 redis.set,非 entity factory → 无 WAL)
 *   - 排序索引    = ZSET STORAGE:ASSETS:SORTED(zAdd/zRem,score=createdAt ms);用 zScore 判存在
 *   - sha256 索引 = STORAGE:SHA256:<sha256>
 *   - delete 返回 { deleted: id };删 ASSET key + zRem 索引;仅当无其它资产引用同 sha256 才删盘上文件
 *   - multi 返回 { items: [{ id, url }|{ id, url:null, error }] }(批量 resolve,坏 id 不抛)
 *   - thumbnail.rebuild { force?, id? } → { processed, skipped, failed, total, errors };
 *       需 sharp 安装 + thumbnails.enabled,否则结构化错(-32603).text/plain 资产会被 skip.
 *
 * 共享栈纪律:不碰任何 *.token.* / admin.self.lock / *.password.reset;
 *   afterAll 逐一清掉本套件产生的所有 STORAGE:* key + 索引成员 + 测试用户.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('60 · storage ops (delete / multi / thumbnail.rebuild)', () => {
    let redis, uid, token;
    const name = `e2e-storage-ops-${process.pid}`;
    const made = [];   // { id, sha256 } — afterAll 逐一清理

    // 上传一个内容唯一(带 pid + 随机)的资产,登记进 made 以便清理.返回 result.
    async function uploadUnique(suffix, mimeType = 'text/plain', filename = 'e2e.txt') {
        const content = `storage-ops ${process.pid} ${suffix} ${Math.random()}`;
        const file = Buffer.from(content).toString('base64');
        const a = V.assertResult(await rpc('storage.asset.upload', { file, filename, mimeType }, token), `upload(${suffix})`);
        made.push({ id: a.id, sha256: a.sha256 });
        return a;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { storage: ['*'] }));
    }, 20_000);

    afterAll(async () => {
        for (const a of made) {
            await redis.del(`STORAGE:ASSET:${a.id}`);
            await redis.zRem('STORAGE:ASSETS:SORTED', a.id);
            if (a.sha256) await redis.del(`STORAGE:SHA256:${a.sha256}`);
        }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    // ── asset.delete ────────────────────────────────────────────────────────
    test('asset.delete → ①{deleted:id} ②元数据 key 没了 ③ZSET 索引移除 ④后续 get 报 not-found', async () => {
        const a = await uploadUnique('del');
        // 前置:确实落库了
        expect(await redis.zScore('STORAGE:ASSETS:SORTED', a.id)).not.toBeNull();
        expect(await redis.get(`STORAGE:ASSET:${a.id}`)).not.toBeNull();

        const del = V.assertResult(await rpc('storage.asset.delete', { id: a.id }, token), 'delete');
        expect(del.deleted).toBe(a.id);                                       // ①

        expect(await redis.get(`STORAGE:ASSET:${a.id}`)).toBeNull();          // ② 元数据没了
        expect(await redis.zScore('STORAGE:ASSETS:SORTED', a.id)).toBeNull(); // ③ 索引移除

        const after = await rpc('storage.asset.get', { id: a.id }, token);    // ④ get 报错(资产已删)
        const err = V.assertRpcError(after, undefined, 'get after delete must fail');
        expect(err.code).not.toBe(-32601);                                    // 可达,非 METHOD_NOT_FOUND
        expect(err.code).toBe(-32002);                                        // ASSET_NOT_FOUND

        await V.assertNoErrors(redis, ['storage']);
    }, 30_000);

    test('asset.delete 不存在的 id → 结构化 not-found(可达,非 -32601)', async () => {
        const res = await rpc('storage.asset.delete', { id: `nope-${process.pid}` }, token);
        const err = V.assertRpcError(res, undefined, 'delete missing must error');
        expect(err.code).not.toBe(-32601);
        expect(err.code).toBe(-32002);
    }, 20_000);

    // ── asset.multi(批量 resolve) ────────────────────────────────────────────
    test('asset.multi → 已知 id 给 url、未知 id 给 url:null+error(批量,不抛)', async () => {
        const a = await uploadUnique('multi-a');
        const b = await uploadUnique('multi-b');
        const bogus = `bogus-${process.pid}`;

        const res = V.assertResult(await rpc('storage.asset.multi', { ids: [a.id, b.id, bogus] }, token), 'multi');
        expect(Array.isArray(res.items)).toBe(true);
        expect(res.items.length).toBe(3);

        const byId = Object.fromEntries(res.items.map((it) => [it.id, it]));
        // 已知 → 有 url. url 是内容寻址(CAS, sha256 的 2/2/2 key),非 id 寻址 → 去掉 '/' 后含 sha256.
        expect(byId[a.id].url.replace(/\//g, '')).toContain(a.sha256);
        expect(byId[b.id].url.replace(/\//g, '')).toContain(b.sha256);
        expect(byId[bogus].url).toBeNull();         // 未知 → url:null + error,整批仍成功返回
        expect(byId[bogus].error).toBeTruthy();

        await V.assertNoErrors(redis, ['storage']);
    }, 30_000);

    test('asset.multi 非数组 ids → 结构化错误(可达,非 -32601)', async () => {
        const res = await rpc('storage.asset.multi', { ids: 'not-an-array' }, token);
        const err = V.assertRpcError(res, undefined, 'multi with non-array must error');
        expect(err.code).not.toBe(-32601);          // INVALID_PARAM,不是 method-not-found
    }, 20_000);

    // ── thumbnail.rebuild ─────────────────────────────────────────────────────
    // sharp 可能没装(logic 会抛 -32603 'sharp is not installed')→ 两种情况都视为"契约可达".
    // text/plain 资产即便 sharp 在也会被 skip,不真生成图;故只断结构,不断真实图片字节.
    test('thumbnail.rebuild(单个 id) → 可达;若 sharp 在则返回 {processed,skipped,failed,total} 结构', async () => {
        const a = await uploadUnique('thumb', 'text/plain', 'e2e.txt');

        const res = await rpc('storage.thumbnail.rebuild', { id: a.id, force: false }, token);

        if (res.error) {
            // sharp 未装 / 缩略图被禁 → 结构化错误即可,关键是可达(非 -32601)
            expect(res.error.code).not.toBe(-32601);
            return;
        }

        const r = V.assertResult(res, 'thumbnail.rebuild');
        // 形状断言(introspection returns: processed/skipped/failed/total/errors)
        expect(typeof r.processed).toBe('number');
        expect(typeof r.skipped).toBe('number');
        expect(typeof r.failed).toBe('number');
        expect(r.total).toBe(1);                    // 只针对这一个 id
        expect(Array.isArray(r.errors)).toBe(true);
        // text/plain 非 image/* → 必被 skip(logic asset.js: mimeType 不以 image/ 开头则 skipped++)
        expect(r.skipped).toBeGreaterThanOrEqual(1);
        expect(r.processed).toBe(0);

        await V.assertNoErrors(redis, ['storage']);
    }, 30_000);
});
