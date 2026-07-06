/**
 * 62 · notification 管理面(此前无 e2e 覆盖的方法).
 *   ① config.set → config.get 往返:写规则 → 读回 → 落库(NOTIFICATION:CONFIG:<targetId>).
 *   ② token.status(只读):admin 能调到 relay token 状态,返回 { hasToken, ... } 结构,绝不回 token 串.
 *
 * 共享栈纪律:
 *   - ❌ 不碰 notification.token.set / token.clear(会让 50/失败恢复套件的 bot relay 失效);只测只读的 token.status.
 *   - config 用带 process.pid 的本套件专属 targetId,afterAll 逐一 del 数据键清干净.
 * full profile 门控(需全栈 Router + notification 服务在线).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('62 · notification management (config round-trip / token.status)', () => {
    let redis;
    // 本套件专属、带 pid 的 targetId(afterAll 删).
    const targetId = `e2e-notif-cfg-${process.pid}`;
    const configKey = `NOTIFICATION:CONFIG:${targetId}`;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);
    afterAll(async () => {
        // 清干净:本套件只写过这一个 config 键.
        await redis.del(configKey);
        await redis.quit();
    });

    test('① config.set → config.get 往返 + 落库', async () => {
        // 起始:未设置过 → get 返回空规则.
        const before = V.assertResult(await rpc('notification.config.get', { targetId }, ADMIN_TOKEN), 'config.get(before)');
        expect(before.targetId).toBe(targetId);
        expect(Array.isArray(before.rules)).toBe(true);
        expect(before.rules.length).toBe(0);

        // set:channel ∈ {email,sms,webhook,none};sse 自 2026-06-10 起 fail-closed(配上即死信→诚实拒绝),
        // 单独断言拒绝。webhook 必须带 params.url(同一轮收紧)。none 避免触发真实出站投递。
        const sseRejected = await rpc('notification.config.set', { targetId, rules: [{ type: '*', channel: 'sse', params: {} }] }, ADMIN_TOKEN);
        expect(sseRejected.error).toBeTruthy();
        expect(sseRejected.error.message).toMatch(/sse/);

        const rules = [
            { type: 'e2e.alert', channel: 'none', params: {} },
            { type: '*', channel: 'webhook', params: { url: 'http://127.0.0.1:9/e2e-roundtrip' } },
        ];
        const setRes = V.assertResult(await rpc('notification.config.set', { targetId, rules }, ADMIN_TOKEN), 'config.set');
        expect(setRes.targetId).toBe(targetId);

        // get:读回规则,关键字段往返一致.
        const after = V.assertResult(await rpc('notification.config.get', { targetId }, ADMIN_TOKEN), 'config.get(after)');
        expect(after.targetId).toBe(targetId);
        expect(after.rules.length).toBe(2);
        expect(after.rules.map((r) => r.channel).sort()).toEqual(['none', 'webhook']);
        expect(after.rules.find((r) => r.type === 'e2e.alert')).toBeTruthy();

        // 落库:NOTIFICATION:CONFIG:<targetId> 是普通 string(用 V.readKey/redis.get),含 rules + updatedAt.
        const stored = await V.readKey(redis, configKey);
        expect(stored).toBeTruthy();
        expect(stored.targetId).toBe(targetId);
        expect(Array.isArray(stored.rules)).toBe(true);
        expect(stored.rules.length).toBe(2);
        expect(typeof stored.updatedAt).toBe('number');
    }, 30_000);

    test('② token.status(只读):admin 能调到,返回结构化状态,不回 token 串', async () => {
        const res = await rpc('notification.token.status', {}, ADMIN_TOKEN);
        // 可达性:不是 METHOD_NOT_FOUND.
        const st = V.assertResult(res, 'token.status');
        // hasToken 永远在(无 token 时单字段 { hasToken:false };有 token 时附 sub/expiresAt/ttlMs/...).
        expect(typeof st.hasToken).toBe('boolean');
        // 安全不变量:状态里绝不能含真实 token 串.
        expect(st.token).toBeUndefined();
        if (st.hasToken) {
            // full profile harness 注入了 bot token → 校验形状(relay.status() 契约).
            expect(st.sub).toBe('system.notification');
            expect(typeof st.expiresAt).toBe('number');
            expect(typeof st.ttlMs).toBe('number');
            expect(st.ttlMs).toBeGreaterThanOrEqual(0);
            expect(typeof st.needsRotation).toBe('boolean');
            expect(typeof st.expired).toBe('boolean');
        }
    }, 20_000);
});
