/**
 * 30 · 注入/模糊测试 —— 向各服务的输入面灌恶意载荷(异常字符/超长/JS·模板/Redis 命令/
 * 路径穿越/XSS/SQL 风格),实际打到真服务,断言**安全**:
 *   ① 服务不崩(/auth/seed 还 200)  ② 库没被擦(canary 还在,即没被 FLUSHALL)
 *   ③ 原型没被污染绕过鉴权(behavioral canary)
 * "安全" = 任意载荷下都安全处理(接受或拒绝都行),不崩/不擦/不逃逸/不绕权.
 */
const assert = require('assert');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const SEC = require('../lib/security');
const attacks = require('../lib/attacks');
const { ADMIN_TOKEN, sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const A = ADMIN_TOKEN;
const FAR = 4102444800000;
const B64 = Buffer.from('x').toString('base64');

gate('30 · injection / fuzzing (each API stays safe)', () => {
    let redis;
    const CANARY = `E2E:CANARY:${process.pid}`;

    // 每个目标:在 field 灌 battery,其余必填字段给最小合法值.
    const TARGETS = [
        { svc: 'user',         method: 'user.register',                field: 'name',       base: {},                                              token: null },
        { svc: 'user',         method: 'user.account.list',            field: 'keyword',    base: { page: 1 },                                     token: A },
        { svc: 'user',         method: 'user.permit.get',              field: 'uid',        base: {},                                              token: A },
        { svc: 'collection',   method: 'collection.payment.get',       field: 'id',         base: {},                                              token: A },
        { svc: 'collection',   method: 'collection.payment.record',    field: 'orderId',    base: { amount: 1, currency: 'CNY' },                  token: A },
        { svc: 'planner',      method: 'planner.todo.create',          field: 'name',       base: { content: 'x' },                                token: A },
        { svc: 'storage',      method: 'storage.asset.get',            field: 'id',         base: {},                                              token: A },
        { svc: 'storage',      method: 'storage.asset.upload',         field: 'filename',   base: { file: B64, mimeType: 'text/plain' },           token: A },
        { svc: 'gateway',      method: 'gateway.email.template.create', field: 'html',      base: { name: 'fz', subject: 's', variables: [] },     token: A },
        { svc: 'notification', method: 'notification.send',            field: 'targetId',   base: { type: 't', payload: {} },                      token: A },
        { svc: 'approval',     method: 'approval.record.request',      field: 'target',     base: { payload: [{ op: 'UPDATE', field: 'f' }] },     token: A },
        { svc: 'nexus',        method: 'nexus.schedule.create',        field: 'schedule_id', base: { fire_at: FAR, recurrence_ms: null, action: { kind: 'emit_event', stream: 'EVENT:X', type: 't' } }, token: A },
        { svc: 'fulfillment',  method: 'fulfillment.instance.create',  field: 'sourceId',   base: { profileId: 'nope' },                           token: A },
    ];

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
        // 加固后:整套模糊测试不应往 ERROR:QUEUE 增加任何条目
        // —— 客户端错误不入队(logger 加固)+ 怪输入不再抛 INTERNAL_ERROR(nexus 加固).
        expect(after).toBe(eqBaseline);
    });

    for (const t of TARGETS) {
        test(`fuzz ${t.method} [${t.field}] — 不崩/不擦库`, async () => {
            for (const [label, payload] of attacks.STRING_BATTERY) {
                const params = { ...t.base, [t.field]: payload };
                let res;
                try { res = await rpc(t.method, params, t.token, { timeout: 8000 }); }
                catch (e) { /* transport timeout 也算线索;下面 alive 断言会兜住 DoS */ }
                // 加固断言:坏输入要"干净拒绝"(client 错误码),不能抛 -32603 INTERNAL_ERROR.
                if (res?.error) assert.notStrictEqual(res.error.code, -32603, `${t.method} [${label}] 未干净拒绝(抛 INTERNAL_ERROR):${JSON.stringify(res.error.message)}`);
                // 每打一发就核对:库没被擦、服务没崩(带 label 便于定位)
                assert.strictEqual(await redis.get(CANARY), 'alive', `${t.method} [${label}] 疑似擦库(canary 没了)`);
                assert.ok(await SEC.svcAlive(t.svc), `${t.method} [${label}] 打挂了 ${t.svc}(/auth/seed 不通)`);
            }
        }, 30_000);
    }

    test('prototype pollution 不能绕过鉴权', async () => {
        const vname = `e2e-sec-victim-${process.pid}`;
        const { uid: u2, token: t2 } = await sessionUser(redis, vname, {});   // 最小权限用户(无 admin)

        // 向几个对象参数的 admin 接口灌 __proto__/constructor.prototype 污染载荷
        for (const m of ['user.permit.update', 'user.bot.create', 'user.account.update']) {
            try { await rpc(m, attacks.protoPollutionParams({ uid: 'system.x' }), A); } catch (e) { /* ignore */ }
        }

        // 关键:若原型被污染(Object.prototype.allow_all=true),非 admin 也会过鉴权.
        // 断言最小权限用户 STILL 调不动 admin 方法 → 没被绕.
        const denied = await rpc('user.account.list', { page: 1 }, t2);
        V.assertRpcError(denied, undefined, '非 admin 必须仍被拒(无原型污染绕权)');

        await SEC.assertAlive('user');
        await SEC.assertCanary(redis, CANARY);
        SEC.assertNoProtoPollution();
        await cleanupUser(redis, { uid: u2, name: vname });
    }, 30_000);
});
