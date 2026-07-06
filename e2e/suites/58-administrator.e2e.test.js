/**
 * 58 · administrator — 之前没有 e2e 覆盖的方法.
 *
 * 32-administrator 只覆盖了登录链(login.request/verify)+ admin.log.error.
 * 本套件补齐:
 *   - setting.config.set / get / del / list      —— Redis hash `config:{service}` 的 CRUD
 *   - setting.config.schema                        —— SYSTEM:CONFIG:SCHEMA:{service}
 *   - setting.index.schema                         —— SYSTEM:INDEX_SCHEMA:{service}
 *   - admin.log.clear                              —— 清错误队列(经 Router 的 adminClearLogs)
 *
 * 全程 ADMIN_TOKEN(allow_all 管理会话). 所有 service/key 带 process.pid,afterAll 删干净.
 *
 * ⚠️ admin.self.lock / admin.password.reset 故意不测(test.skip):
 *    它们会改/废共享的 admin 账号与 ADMIN_TOKEN/HTTP 端口,在共享 e2e 栈里会废掉后续套件.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

// 本套件专属、带 pid 的命名空间——绝不碰真实服务的 config / schema / 错误队列.
const SVC = `e2e-adm-${process.pid}`;
const CFG_KEY = `feature.flag.${process.pid}`;
const CFG_VAL = `on-${process.pid}`;

gate('58 · administrator (config overrides + schema + log.clear)', () => {
    let redis;

    beforeAll(async () => {
        redis = await redisLib.connect();
        // 预清,防上次残留
        await redis.del(`config:${SVC}`);
        await redis.del(`SYSTEM:CONFIG:SCHEMA:${SVC}`);
        await redis.del(`SYSTEM:INDEX_SCHEMA:${SVC}`);
        await redis.del(`ERROR:QUEUE:${SVC}`);
    }, 20_000);

    afterAll(async () => {
        // 逐一清掉本套件造的所有 key,别留垃圾给别的套件.
        await redis.del(`config:${SVC}`);
        await redis.del(`SYSTEM:CONFIG:SCHEMA:${SVC}`);
        await redis.del(`SYSTEM:INDEX_SCHEMA:${SVC}`);
        await redis.del(`ERROR:QUEUE:${SVC}`);
        await redis.quit();
    });

    // ── setting.config.* CRUD ────────────────────────────────────────────────

    test('config.set → ②落库 config:{svc} hash field', async () => {
        const res = V.assertResult(
            await rpc('setting.config.set', { service: SVC, key: CFG_KEY, value: CFG_VAL }, ADMIN_TOKEN),
            'setting.config.set');
        expect(res.ok).toBe(true);
        // ② Redis hash 真写入(handler 走 hSet(`config:${service}`, key, String(value)))
        expect(await redis.hGet(`config:${SVC}`, CFG_KEY)).toBe(CFG_VAL);
    }, 30_000);

    test('config.get → overrides 含刚写入的 key', async () => {
        const res = V.assertResult(
            await rpc('setting.config.get', { service: SVC }, ADMIN_TOKEN),
            'setting.config.get');
        // handler 返回 hGetAll 的对象(可能直接是 map,也可能包一层 overrides)
        const map = res.overrides || res;
        expect(map[CFG_KEY]).toBe(CFG_VAL);
    }, 30_000);

    test('config.list → 含本服务名', async () => {
        const res = V.assertResult(
            await rpc('setting.config.list', {}, ADMIN_TOKEN),
            'setting.config.list');
        // handler 返回 keys('config:*').map(去前缀) —— 数组,或包一层 services
        const list = Array.isArray(res) ? res : (res.services || []);
        expect(list).toContain(SVC);
    }, 30_000);

    test('config.del → 字段被删,get 不再含它', async () => {
        const res = V.assertResult(
            await rpc('setting.config.del', { service: SVC, key: CFG_KEY }, ADMIN_TOKEN),
            'setting.config.del');
        expect(res.ok).toBe(true);
        // ② hash field 真被删
        expect(await redis.hExists(`config:${SVC}`, CFG_KEY)).toBe(false);
    }, 30_000);

    test('config.set 缺参 → 结构化错误(可达,非 METHOD_NOT_FOUND)', async () => {
        const res = await rpc('setting.config.set', { service: SVC }, ADMIN_TOKEN); // 缺 key/value
        const err = V.assertRpcError(res, undefined, 'missing key/value must fail');
        expect(err.code).not.toBe(-32601);
    }, 30_000);

    // ── setting.config.schema / setting.index.schema ─────────────────────────

    test('config.schema → 读 SYSTEM:CONFIG:SCHEMA:{svc}(seed 后)', async () => {
        const schema = {
            service: SVC,
            publishedAt: new Date().toISOString(),
            keys: [{ key: 'feature.flag', default: false, type: 'boolean' }],
        };
        await redis.set(`SYSTEM:CONFIG:SCHEMA:${SVC}`, JSON.stringify(schema));

        const res = V.assertResult(
            await rpc('setting.config.schema', { service: SVC }, ADMIN_TOKEN),
            'setting.config.schema');
        expect(res.service).toBe(SVC);
        expect(Array.isArray(res.keys)).toBe(true);
        expect(res.keys[0].key).toBe('feature.flag');
    }, 30_000);

    test('config.schema 未发布 → null(可达,不报错)', async () => {
        const res = await rpc('setting.config.schema', { service: `${SVC}-never` }, ADMIN_TOKEN);
        // handler: 无 key → return null. JSON-RPC result 为 null,无 error.
        expect(res.error).toBeUndefined();
        expect(res.result).toBeNull();
    }, 30_000);

    test('index.schema → 读 SYSTEM:INDEX_SCHEMA:{svc}(seed 后)', async () => {
        const idx = {
            widget: {
                name: `idx:${SVC}:widget`,
                prefix: `${SVC}:widget:`,
                schema: [{ field: 'name', type: 'TEXT' }],
            },
        };
        await redis.set(`SYSTEM:INDEX_SCHEMA:${SVC}`, JSON.stringify(idx));

        const res = V.assertResult(
            await rpc('setting.index.schema', { service: SVC }, ADMIN_TOKEN),
            'setting.index.schema');
        expect(res.widget).toBeDefined();
        expect(res.widget.name).toBe(`idx:${SVC}:widget`);
    }, 30_000);

    // ── admin.log.clear ──────────────────────────────────────────────────────
    // 经 Router 的 adminClearLogs:isAdmin 闸 → 清空 ERROR:QUEUE:*. 我们 seed 一条
    // pid 专属队列,断言清空后它消失(成功也清掉其它已为空的队列,健康栈里无害).

    test('admin.log.clear(admin) → 成功,seed 的错误队列被清空', async () => {
        await redis.rPush(`ERROR:QUEUE:${SVC}`, JSON.stringify({ msg: `e2e-seed-${process.pid}`, ts: 1 }));
        expect(await redis.lLen(`ERROR:QUEUE:${SVC}`)).toBe(1);

        const res = V.assertResult(
            await rpc('admin.log.clear', { service: SVC }, ADMIN_TOKEN),
            'admin.log.clear');
        expect(res.success).toBe(true);
        expect(await redis.exists(`ERROR:QUEUE:${SVC}`)).toBe(0);
    }, 30_000);

    // ── 危险方法:不可在共享栈跑 ──────────────────────────────────────────────

    test.skip('admin.self.lock —— 会缩短/废掉共享 admin session 并关闭 admin HTTP 端口,共享 e2e 栈不可跑', () => {});
    test.skip('admin.password.reset —— 会改写共享 admin 凭证(PBKDF2),废掉 ADMIN_TOKEN 登录链,共享 e2e 栈不可跑', () => {});
});
