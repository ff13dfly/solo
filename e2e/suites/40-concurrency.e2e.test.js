/**
 * 40 · 并发正确性(race correctness)—— 在单个 test 内用 Promise.all 发 N 个并发请求,
 * 断言**聚合不变量**(不依赖具体时序,故确定、不 flaky)。
 *   ① user.register 同名并发 → 恰好 1 成功(SET NX TOCTOU 护栏)
 *   ② collection 并发 create → N 个不同 id + INDEX 一致(entity NX 抢占 + MULTI/EXEC)
 *   ③ ingress 并发同 request_id → 恰好 1 条进流(SET NX EX 去重)
 *   ④ 同实体并发 update → 不丢更新(读改写/乐观锁)—— 探针,可能暴露 last-writer-wins 丢写
 *   ⑤ storage 同内容并发 upload → 去重收敛到同一 assetId + refcount=1(per-sha 内容锁)
 *   ⑥ storage 同 id 并发 delete → DEL 仲裁恰好 1 成功,共享字节不被误清(refcount 只减一次)
 *   ⑦ storage upload×delete 混战 → 幸存记录的 URL 永远打得通(探针:修复前概率性悬空 404)
 * 纯负载/吞吐不在此(那是 perf 工具的事)。full profile.
 */
const http = require('http');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sha256, randomHex } = require('../lib/crypto');
const { ADMIN_TOKEN, createAndLogin, sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const N = 25;
const range = (n) => Array.from({ length: n }, (_, i) => i);

/** GET 一个资产 URL,只回状态码 —— ⑥⑦ 用它验证"记录指向的字节真的在"(悬空 = 404). */
function fetchStatus(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.setTimeout(5_000, () => { req.destroy(); reject(new Error(`fetch timeout: ${url}`)); });
    });
}

gate('40 · concurrency (race correctness)', () => {
    let redis;
    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => { await redis.quit(); });

    test('① register 同名并发 → 恰好 1 成功(SET NX TOCTOU)', async () => {
        const name = `e2e-conc-reg-${process.pid}`;
        const results = await Promise.all(range(N).map((i) => {
            const salt = randomHex(16);
            return rpc('user.register', { name, salt, hash: sha256(`pw${i}` + salt) });
        }));
        const winners = results.filter((r) => r.result && r.result.uid);
        expect(winners.length).toBe(1);                                   // 恰好 1 个抢到名字
        const uid = await redis.get(`user:name:${name}`);
        expect(uid).toBe(winners[0].result.uid);                          // 映射指向赢家
        expect(await redis.sCard('user:ids')).toBeGreaterThanOrEqual(1);

        await cleanupUser(redis, { uid, name });
    }, 40_000);

    test('② collection 并发 create → N 个不同 id + INDEX 一致', async () => {
        const results = await Promise.all(range(N).map((i) =>
            rpc('collection.payment.record', { amount: 1, currency: 'CNY', orderId: `conc-${process.pid}-${i}` }, ADMIN_TOKEN)));
        const ids = results.map((r) => r.result && r.result.id).filter(Boolean);
        expect(ids.length).toBe(N);                                       // 全部成功
        expect(new Set(ids).size).toBe(N);                               // id 全不同(无碰撞/覆盖)
        for (const id of ids) {
            expect(await redis.exists(`COLLECTION:PAYMENT:${id}`)).toBe(1);
            expect(await redis.sIsMember('COLLECTION:PAYMENT:INDEX', id)).toBeTruthy();   // 无孤儿
        }
        for (const id of ids) { await redis.del(`COLLECTION:PAYMENT:${id}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', id); }
    }, 40_000);

    test('③ ingress 并发同 request_id → 恰好 1 条进流(SET NX EX 去重)', async () => {
        const sname = `concsrc${process.pid}`;
        const s = V.assertResult(await rpc('ingress.source.create', { name: sname, dedupTtlSec: 120 }, ADMIN_TOKEN), 'source.create');
        const before = await redis.xLen(s.stream).catch(() => 0);
        const reqId = `conc-req-${process.pid}`;
        await Promise.all(range(N).map(() =>
            rpc('ingress.ingest', { request_id: reqId, data: { x: 1 } }, null, { authHeader: `ApiKey ${s.apiKey}` })));
        expect((await redis.xLen(s.stream)) - before).toBe(1);            // 去重:恰好 1 条

        await rpc('ingress.source.delete', { id: s.id }, ADMIN_TOKEN).catch(() => {});
        await redis.del(`INGRESS:NAME:${sname}`); await redis.del(s.stream);
    }, 40_000);

    test('④ 同实体并发 update → 不丢更新(每个并发写一个不同 meta key)', async () => {
        const name = `e2e-conc-upd-${process.pid}`;
        const { uid } = await createAndLogin({ name });
        await Promise.all(range(N).map((i) =>
            rpc('user.account.update', { uid, meta: { [`k${i}`]: i } }, ADMIN_TOKEN)));
        const user = JSON.parse(await redis.get(`user:${uid}`));
        const present = range(N).filter((i) => user.meta && `k${i}` in user.meta);
        // 理想:N 个并发 meta patch 互不覆盖,全部保留(user.update 注释声称"concurrent patches don't clobber").
        expect(present.length).toBe(N);

        await cleanupUser(redis, { uid, name });
    }, 40_000);

    // ─── storage CAS(内容寻址)竞态 —— per-sha 内容锁 + DEL 仲裁 + MULTI 的真栈回归钉 ───
    // hermetic 版在 api/apps/storage/tests/asset-concurrency.test.js(可控时序,红/绿都验过);
    // 这里走真 Router + 真 Redis + 真 local-oss,断言同一组不变量在真实时序下恒成立。
    describe('storage CAS races (⑤⑥⑦)', () => {
        let A, B;
        const leftovers = [];   // [ [id, token] ] — afterAll 经 rpc 清(顺带清 refcount + 字节)

        beforeAll(async () => {
            A = await sessionUser(redis, `e2e-conc-casa-${process.pid}`, { storage: ['*'] });
            B = await sessionUser(redis, `e2e-conc-casb-${process.pid}`, { storage: ['*'] });
        }, 20_000);
        afterAll(async () => {
            for (const [id, token] of leftovers) await rpc('storage.asset.delete', { id }, token).catch(() => {});
            await cleanupUser(redis, A);
            await cleanupUser(redis, B);
        });

        test('⑤ 同内容并发 upload → 去重收敛:同一 assetId + refcount=1', async () => {
            const file = Buffer.from(`cas5-${process.pid}-${randomHex(8)}`).toString('base64');
            const results = await Promise.all(range(10).map(() =>
                rpc('storage.asset.upload', { file, filename: 'race.bin', mimeType: 'application/octet-stream' }, A.token)));
            const assets = results.map((r) => V.assertResult(r, 'upload'));

            expect(new Set(assets.map((a) => a.id)).size).toBe(1);   // 修复前:并发全 miss 去重,10 个不同 id
            const sha = assets[0].sha256;
            expect(await redis.get(`STORAGE:SHA256:REFCOUNT:${sha}`)).toBe('1');
            expect(await redis.get(`STORAGE:SHA256:${sha}`)).toBe(assets[0].id);
            leftovers.push([assets[0].id, A.token]);
        }, 40_000);

        test('⑥ 同 id 并发 delete → DEL 仲裁恰好 1 成功,共享字节不被误清', async () => {
            const file = Buffer.from(`cas6-${process.pid}-${randomHex(8)}`).toString('base64');
            const mine   = V.assertResult(await rpc('storage.asset.upload', { file, filename: 'shared.bin' }, A.token), 'upload A');
            const theirs = V.assertResult(await rpc('storage.asset.upload', { file, filename: 'shared.bin' }, B.token), 'upload B');
            expect(theirs.id).not.toBe(mine.id);                     // owner 不同 → 两条记录共享同一份字节
            expect(await redis.get(`STORAGE:SHA256:REFCOUNT:${mine.sha256}`)).toBe('2');

            const results = await Promise.all(range(10).map(() => rpc('storage.asset.delete', { id: mine.id }, A.token)));
            const winners = results.filter((r) => r.result && r.result.deleted === mine.id);
            expect(winners.length).toBe(1);                          // 恰好 1 个抢到清理权
            results.filter((r) => r.error).forEach((r) => expect(r.error.code).toBe(-32002));   // 其余 = 晚到一步的 NOT_FOUND

            // 修复前:一条记录被 decr 10 次 → refcount 冲到负数 → B 还引用的字节被 purge。
            expect(await redis.get(`STORAGE:SHA256:REFCOUNT:${mine.sha256}`)).toBe('1');
            const url = V.assertResult(await rpc('storage.asset.resolve', { id: theirs.id }, B.token), 'resolve B').url;
            expect(await fetchStatus(url)).toBe(200);                // 兄弟记录的字节仍打得通
            leftovers.push([theirs.id, B.token]);
        }, 40_000);

        test('⑦ upload×delete 混战 → 幸存记录永不悬空(探针:不变量恒成立)', async () => {
            for (let k = 0; k < 6; k++) {
                const file = Buffer.from(`cas7-${process.pid}-${k}-${randomHex(8)}`).toString('base64');
                const first = V.assertResult(await rpc('storage.asset.upload', { file, filename: 'race.bin' }, A.token), `round ${k} seed`);

                // A 删掉这份内容唯一的记录,同刻 B 上传同一份内容 —— 修复前 B 的 upload 可能
                // 看到"字节存在"而跳过 put,随后 A 的 purge 落地 → B 拿到一条永远 404 的记录。
                const [del, up] = await Promise.all([
                    rpc('storage.asset.delete', { id: first.id }, A.token),
                    rpc('storage.asset.upload', { file, filename: 'race.bin' }, B.token),
                ]);
                expect(del.result && del.result.deleted).toBe(first.id);
                const second = V.assertResult(up, `round ${k} upload B`);

                const url = V.assertResult(await rpc('storage.asset.resolve', { id: second.id }, B.token), `round ${k} resolve`).url;
                expect(await fetchStatus(url)).toBe(200);            // 不变量:新记录的字节必须在
                expect(await redis.get(`STORAGE:SHA256:REFCOUNT:${second.sha256}`)).toBe('1');

                V.assertResult(await rpc('storage.asset.delete', { id: second.id }, B.token), `round ${k} cleanup`);
            }
        }, 60_000);
    });
});
