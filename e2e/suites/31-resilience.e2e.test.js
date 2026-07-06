/**
 * 31 · 韧性 —— 超大载荷(不 OOM/不挂)、类型混淆(Router 类型校验边界)、glob DoS(不 hang)。
 */
const assert = require('assert');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const SEC = require('../lib/security');
const attacks = require('../lib/attacks');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const A = ADMIN_TOKEN;

gate('31 · resilience (oversize / type-confusion / glob)', () => {
    let redis;
    const CANARY = `E2E:CANARY2:${process.pid}`;

    let eqBaseline = 0;
    async function errorQueueTotal() {
        let n = 0;
        for (const k of await redisLib.scanAll(redis, 'ERROR:QUEUE:*')) n += await redis.lLen(k);
        return n;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        await redis.set(CANARY, 'alive');
        eqBaseline = await errorQueueTotal();
    }, 20_000);
    afterAll(async () => {
        const after = await errorQueueTotal();
        await redis.del(CANARY);
        await redis.quit();
        expect(after).toBe(eqBaseline);   // 加固后:韧性测试也不增 ERROR:QUEUE
    });

    test('超大字符串(2MB)不 OOM、不挂死', async () => {
        // 灌进文本字段;期望服务在超时内给出响应(接受或拒绝),且不崩.
        for (const [svc, method, params] of [
            ['planner', 'planner.todo.create', { name: 'big', content: attacks.HUGE }],
            ['gateway', 'gateway.email.template.create', { name: 'big', subject: 's', html: attacks.HUGE, variables: [] }],
            ['notification', 'notification.send', { targetId: 'big', type: 't', payload: { blob: attacks.HUGE } }],
        ]) {
            let threw = false;
            try { await rpc(method, params, A, { timeout: 12_000 }); } catch (e) { threw = true; }
            assert.ok(await SEC.svcAlive(svc), `${method} 被 2MB 载荷打挂(${svc} 不通)`);
            assert.strictEqual(await redis.get(CANARY), 'alive', `${method} 超大载荷疑似擦库`);
            // threw=true(传输超时)也是 DoS 信号,但只要服务还活就算安全降级;记录不强断言.
        }
    }, 60_000);

    test('类型混淆(array/object/number/bool 灌进 string 字段)不崩', async () => {
        // Router 按 introspection 校验类型,理应拒绝;即便透传,服务也不能崩.
        for (const [label, val] of attacks.TYPE_CONFUSION) {
            for (const [svc, method, field, base] of [
                ['collection', 'collection.payment.get', 'id', {}],
                ['collection', 'collection.payment.record', 'currency', { amount: 1, orderId: 'x' }],
                ['approval', 'approval.record.request', 'target', { payload: [{ op: 'UPDATE', field: 'f' }] }],
                ['user', 'user.permit.get', 'uid', {}],
            ]) {
                try { await rpc(method, { ...base, [field]: val }, A, { timeout: 8000 }); } catch (e) { /* transport */ }
                assert.ok(await SEC.svcAlive(svc), `${method} 被类型混淆[${label}]打挂(${svc})`);
            }
        }
        await SEC.assertCanary(redis, CANARY);
    }, 60_000);

    test('glob/KEYS DoS(keyword=*)不 hang、服务存活', async () => {
        // user.account.list 关键字会进 KEYS user:name:*{kw}* —— '*' 不能让它挂死或扫爆.
        const t0 = Date.now();
        let resolved = true;
        try { await rpc('user.account.list', { page: 1, keyword: attacks.GLOB }, A, { timeout: 10_000 }); }
        catch (e) { resolved = false; }   // 超时 = 潜在 DoS
        assert.ok(resolved, 'user.account.list keyword="*" 超时未返回(潜在 glob DoS)');
        assert.ok(Date.now() - t0 < 10_000, 'glob 查询耗时过长');
        await SEC.assertAlive('user');
        await SEC.assertCanary(redis, CANARY);
    }, 30_000);
});
