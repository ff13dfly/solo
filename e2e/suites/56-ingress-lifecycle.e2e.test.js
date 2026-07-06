/**
 * 56 · ingress source 生命周期(此前无 e2e 覆盖的方法).
 * 覆盖:source.update / enable / disable / key.rotate / test, token.status(只读).
 *
 * 串法:create(本套件专属 source) → update(改名+dedupTtl) →
 *   disable(断 ingest 被拒) → enable(断 ingest 恢复) →
 *   key.rotate(断旧 key 失效、新 key 可用) → test(合成事件落 EVENT:WEBHOOK 流).
 * token.status 只读探测(绝不调 token.set/clear —— 会废掉 50/51/91/92 共享 bot).
 *
 * (full profile;source.test/ingest 依赖 system.ingress relay bot token + EVENT:WEBHOOK:* 注册,harness 已配)
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('56 · ingress source lifecycle (update/enable/disable/key.rotate/test, token.status)', () => {
    let redis;
    let sourceId;
    let apiKey;          // 当前有效 key(rotate 后会换成新值)
    let oldKey;          // rotate 前的旧 key(应失效)
    let stream;          // EVENT:WEBHOOK:{NAME_UPPER}(改名后会变)

    const sname = `e2elc${process.pid}`;          // 本套件专属、带 pid
    const sname2 = `e2elc${process.pid}b`;        // update 改名后的新名
    let reqN = 0;
    const nextReq = () => `req-${process.pid}-lc-${++reqN}`;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        // 走 source.delete:同时清 entity data + INGRESS:NAME:{name} + INGRESS:KEYHASH:{hash}.
        if (sourceId) await rpc('ingress.source.delete', { id: sourceId }, ADMIN_TOKEN).catch(() => {});
        // 安全网:逐一兜底清干净,绝不留垃圾给后续套件.
        if (sourceId) {
            await redis.del(`INGRESS:SOURCE:${sourceId}`).catch(() => {});
            await redis.sRem('INGRESS:SOURCE:INDEX', sourceId).catch(() => {});
        }
        await redis.del(`INGRESS:NAME:${sname}`).catch(() => {});
        await redis.del(`INGRESS:NAME:${sname2}`).catch(() => {});
        if (stream) await redis.del(stream).catch(() => {});
        await redis.del(`EVENT:WEBHOOK:${sname.toUpperCase()}`).catch(() => {});
        await redis.del(`EVENT:WEBHOOK:${sname2.toUpperCase()}`).catch(() => {});
        await redis.quit();
    });

    test('source.create → 一次性 apiKey + 落库(本套件前置)', async () => {
        const s = V.assertResult(
            await rpc('ingress.source.create', { name: sname, dedupTtlSec: 60 }, ADMIN_TOKEN),
            'source.create',
        );
        sourceId = s.id; apiKey = s.apiKey; stream = s.stream;
        expect(sourceId).toBeTruthy();
        expect(apiKey).toBeTruthy();                                   // 一次性 key
        expect(stream).toBe(`EVENT:WEBHOOK:${sname.toUpperCase()}`);
        await V.assertRecord(redis, `INGRESS:SOURCE:${sourceId}`, { name: sname, enabled: true });
    });

    test('source.update → 改名 + dedupTtlSec(name/enabled 字段变化)', async () => {
        const u = V.assertResult(
            await rpc('ingress.source.update', { id: sourceId, name: sname2, dedupTtlSec: 120 }, ADMIN_TOKEN),
            'source.update',
        );
        expect(u.id).toBe(sourceId);
        expect(u.name).toBe(sname2);                                   // ① 返回值反映新名
        // ② 落库:name 改了、旧 NAME 索引释放、新 NAME 索引指向本 source.
        await V.assertRecord(redis, `INGRESS:SOURCE:${sourceId}`, { name: sname2, dedupTtlSec: 120 });
        expect(await redis.get(`INGRESS:NAME:${sname}`)).toBeNull();   // 旧名释放
        expect(await redis.get(`INGRESS:NAME:${sname2}`)).toBe(sourceId);
        stream = `EVENT:WEBHOOK:${sname2.toUpperCase()}`;              // 改名后流名随之变
    });

    test('source.disable → ingest 被拒(不发流)', async () => {
        const d = V.assertResult(await rpc('ingress.source.disable', { id: sourceId }, ADMIN_TOKEN), 'source.disable');
        expect(d.enabled).toBe(false);                                 // ① 状态翻转
        await V.assertRecord(redis, `INGRESS:SOURCE:${sourceId}`, { enabled: false });   // ② 落库

        // disabled 源:有效 key 也被拒,流不增.
        const before = await redis.xLen(stream).catch(() => 0);
        const res = await rpc(
            'ingress.ingest', { request_id: nextReq(), data: { a: 1 } },
            null, { authHeader: `ApiKey ${apiKey}` },
        );
        // ingest 是 public 路径:返回 body { ok:false, error:'source disabled' }(403).
        expect(Boolean(res.error) || res.result?.ok === false).toBe(true);
        expect(await redis.xLen(stream).catch(() => 0)).toBe(before);  // 没发流
    });

    test('source.enable → ingest 恢复(真发 EVENT:WEBHOOK 流)', async () => {
        const e = V.assertResult(await rpc('ingress.source.enable', { id: sourceId }, ADMIN_TOKEN), 'source.enable');
        expect(e.enabled).toBe(true);                                  // ① 状态翻转
        await V.assertRecord(redis, `INGRESS:SOURCE:${sourceId}`, { enabled: true });    // ② 落库

        const before = await redis.xLen(stream).catch(() => 0);
        const res = V.assertResult(
            await rpc('ingress.ingest', { request_id: nextReq(), data: { ok: true } },
                null, { authHeader: `ApiKey ${apiKey}` }),
            'ingest(after enable)',
        );
        expect(res.ok).toBe(true);
        expect(await redis.xLen(stream)).toBe(before + 1);             // 恢复后真落一条
    });

    test('source.key.rotate → 旧 key 失效、新 key 可用', async () => {
        oldKey = apiKey;
        const r = V.assertResult(await rpc('ingress.source.key.rotate', { id: sourceId }, ADMIN_TOKEN), 'key.rotate');
        expect(r.id).toBe(sourceId);
        expect(r.apiKey).toBeTruthy();
        expect(r.apiKey).not.toBe(oldKey);                             // ① 换了新 key
        apiKey = r.apiKey;

        // ② 旧 key 失效:用旧 key ingest 被拒(unauthorized),流不增.
        const before = await redis.xLen(stream).catch(() => 0);
        const denied = await rpc(
            'ingress.ingest', { request_id: nextReq(), data: {} },
            null, { authHeader: `ApiKey ${oldKey}` },
        );
        expect(Boolean(denied.error) || denied.result?.ok === false).toBe(true);
        expect(await redis.xLen(stream).catch(() => 0)).toBe(before);  // 旧 key → 不发流

        // ③ 新 key 可用:真发一条流.
        const ok = V.assertResult(
            await rpc('ingress.ingest', { request_id: nextReq(), data: { rotated: true } },
                null, { authHeader: `ApiKey ${apiKey}` }),
            'ingest(new key)',
        );
        expect(ok.ok).toBe(true);
        expect(await redis.xLen(stream)).toBe(before + 1);
    });

    test('source.test → 合成 webhook.received 事件(跳过去重,真落流)', async () => {
        const before = await redis.xLen(stream).catch(() => 0);
        const t = V.assertResult(
            await rpc('ingress.source.test', { id: sourceId, data: { synthetic: true } }, ADMIN_TOKEN),
            'source.test',
        );
        expect(t.ok).toBe(true);
        expect(t.stream).toBe(stream);                                 // 指向本 source 的流
        expect(t.request_id).toMatch(/^test_/);                        // 合成 request_id 前缀
        expect(await redis.xLen(stream)).toBe(before + 1);             // 真落一条合成事件

        // 再 test 一次:跳过去重 → 仍新增(与 ingest 的去重语义区分).
        const before2 = await redis.xLen(stream);
        V.assertResult(await rpc('ingress.source.test', { id: sourceId }, ADMIN_TOKEN), 'source.test#2');
        expect(await redis.xLen(stream)).toBe(before2 + 1);
    });

    test('token.status(只读,admin)→ 可达 + 返回状态形状', async () => {
        // 只读探测 relay token 状态;绝不调 token.set/clear(会废掉共享 bot,破坏 50/51/91/92).
        const st = V.assertResult(await rpc('ingress.token.status', {}, ADMIN_TOKEN), 'token.status');
        expect(st).toBeTruthy();
        expect(typeof st.hasToken).toBe('boolean');                    // relay.status() 恒返回 hasToken;其余字段不强断,避免脆
    });
});
