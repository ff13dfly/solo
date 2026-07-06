/**
 * 33 · ingress 入站 webhook(source 管理 + per-source API key 鉴权 + 去重 + 审计).
 * source.create(admin)→ 一次性 apiKey → ingress.ingest(Authorization: ApiKey <key>)
 * → 真发 EVENT:WEBHOOK:{NAME} 流;同 request_id 去重;坏 key 被拒;log.recent 有审计.
 * (full profile;依赖 system.ingress bot token + 事件注册表覆盖含 EVENT:WEBHOOK:*,harness 已配)
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('33 · ingress webhook (source + API-key ingest + dedup)', () => {
    let redis, sourceId, apiKey, stream;
    const sname = `e2esrc${process.pid}`;
    const reqId = `req-${process.pid}-1`;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        if (sourceId) await rpc('ingress.source.delete', { id: sourceId }, ADMIN_TOKEN).catch(() => {});
        await redis.del(`INGRESS:NAME:${sname}`);
        if (stream) await redis.del(stream);
        await redis.quit();
    });

    test('source.create → 一次性 apiKey + ②落库(INGRESS:SOURCE + NAME 索引)', async () => {
        const s = V.assertResult(await rpc('ingress.source.create', { name: sname, dedupTtlSec: 60 }, ADMIN_TOKEN), 'source.create');
        sourceId = s.id; apiKey = s.apiKey; stream = s.stream;
        expect(apiKey).toBeTruthy();                                  // 一次性 key 返回
        expect(stream).toBe(`EVENT:WEBHOOK:${sname.toUpperCase()}`);
        await V.assertRecord(redis, `INGRESS:SOURCE:${sourceId}`, { name: sname });   // ②
        expect(await redis.get(`INGRESS:NAME:${sname}`)).toBeTruthy();
    });

    test('ingest(ApiKey header) → 真发 EVENT:WEBHOOK 流', async () => {
        const before = await redis.xLen(stream).catch(() => 0);
        const res = V.assertResult(await rpc('ingress.ingest', { request_id: reqId, data: { hello: 'world' } }, null, { authHeader: `ApiKey ${apiKey}` }), 'ingest');
        expect(res.ok).toBe(true);
        expect(await redis.xLen(stream)).toBe(before + 1);            // 真落了一条 EVENT:WEBHOOK
    });

    test('dedup: 同 request_id 被丢弃(流不增)', async () => {
        const before = await redis.xLen(stream);
        await rpc('ingress.ingest', { request_id: reqId, data: { hello: 'world' } }, null, { authHeader: `ApiKey ${apiKey}` });
        expect(await redis.xLen(stream)).toBe(before);               // 去重 → 不新增
    });

    test('坏 API key → 拒绝、不发流', async () => {
        const before = await redis.xLen(stream);
        const res = await rpc('ingress.ingest', { request_id: `req-${process.pid}-bad`, data: {} }, null, { authHeader: 'ApiKey totally-wrong-key' });
        expect(Boolean(res.error) || res.result?.ok === false).toBe(true);   // 拒绝(抛错或 ok:false)
        expect(await redis.xLen(stream)).toBe(before);
    });

    test('source.get / list / log.recent(admin)', async () => {
        expect(V.assertResult(await rpc('ingress.source.get', { id: sourceId }, ADMIN_TOKEN)).id).toBe(sourceId);
        expect(V.assertResult(await rpc('ingress.source.list', {}, ADMIN_TOKEN)).items.some((x) => x.id === sourceId)).toBe(true);
        const log = V.assertResult(await rpc('ingress.log.recent', { limit: 10, source: sname }, ADMIN_TOKEN), 'log.recent');
        expect(log.items.length).toBeGreaterThan(0);   // 有投递审计(accepted + duplicate + unauthorized)
    });
});
