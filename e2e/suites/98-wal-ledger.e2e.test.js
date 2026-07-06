/**
 * 98 · WAL 原子账本 — 数据写 + 账本进同一个 MULTI(entity.js walMulti),
 *      归档器把流账本落盘成文件 WAL(walarchiver.js,灾备/审计第二故障域)。
 *
 * 链路(全部经 Router 真实签名转发):
 *   collection.payment.record  → 实体 create + WAL:STREAM 账本行(同一事务)
 *   collection.payment.settle  → 实体 update + 账本行(CAS MULTI 内)
 *   collection 进程内 archiver → 消费 WAL:STREAM → LOG_DIR 文件(lib/wal.js 可读)
 *
 * 断言四层:
 *   ① 每次变更恰好一条账本行(原子:RPC 返回即可见,无 write-behind 滞后);
 *   ② 行内容:op / before→after 链(update.before === create.after)/ user=调用者 / txn;
 *   ③ 敏感与体积治理不在此测(library 单测覆盖),此处测真实跨进程行为;
 *   ④ 文件副本最终一致:轮询 lib/wal.query 直到归档行出现,内容与流一致(含 ref=流条目id)。
 *
 * lite profile 即可(user + collection)。WAL:STREAM 是默认流名(服务未设 WAL_STREAM env)。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const wal = require('../lib/wal');
const { ADMIN_TOKEN } = require('../harness/identity');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.pid;
const STREAM = 'WAL:STREAM';          // library/constants.js WAL.STREAM 默认值
const ADMIN_UID = 'e2e-admin';        // harness 注入的 admin 会话 uid(setup.js step 2)

describe('98 · WAL atomic ledger (entity MULTI → stream → archiver → file)', () => {
    let redis;
    let paymentId;
    let key;
    let createRow;
    let updateRow;

    beforeAll(async () => {
        redis = await redisLib.connect();
    });

    afterAll(async () => {
        if (redis) await redis.quit().catch(() => {});
    });

    // 该 key 在 WAL:STREAM 里的全部账本行(流序 = 提交序),快照字段解析回对象。
    async function ledgerFor(k) {
        const entries = await redis.xRange(STREAM, '-', '+');
        return entries
            .filter(({ message }) => message.key === k)
            .map(({ id, message }) => ({
                sid: id,
                op: message.op,
                before: JSON.parse(message.before),
                after: JSON.parse(message.after),
                user: message.user,
                txn: message.txn,
                stamp: parseInt(message.stamp, 10),
            }));
    }

    test('1. record(create)→ 恰好一条账本行,与数据写同事务可见', async () => {
        const p = V.assertResult(await rpc('collection.payment.record', {
            amount: 4242, currency: 'CNY', orderId: `wal-98-${PID}`, source: 'e2e-98',
        }, ADMIN_TOKEN), 'payment.record');
        paymentId = p.id;
        key = `COLLECTION:PAYMENT:${paymentId}`;

        // 原子语义:RPC 已返回 ⇒ 账本行必须已在(同一个 MULTI),不允许 write-behind 滞后。
        const rows = await ledgerFor(key);
        expect(rows).toHaveLength(1);
        createRow = rows[0];
        expect(createRow.op).toBe('create');
        expect(createRow.before).toBeNull();
        expect(createRow.after.id).toBe(paymentId);
        expect(createRow.after.amount).toBe(4242);
        expect(createRow.user).toBe(ADMIN_UID);     // 调用者归因,不是服务身份
        expect(createRow.txn).toBeTruthy();
    });

    test('2. settle(update)→ 第二条行,before 严格等于上一条 after(账本链)', async () => {
        V.assertResult(await rpc('collection.payment.settle', { id: paymentId }, ADMIN_TOKEN), 'payment.settle');

        const rows = await ledgerFor(key);
        expect(rows).toHaveLength(2);
        updateRow = rows[1];
        expect(updateRow.op).toBe('update');
        // 链性质:CAS MULTI 内 xAdd 才能保证;write-behind 在并发下会断链。
        expect(updateRow.before).toEqual(createRow.after);
        // collection 的业务态在 state(RECEIVED→SETTLED);status 是工厂生命周期字段(恒 ACTIVE)
        expect(createRow.after.state).toBe('RECEIVED');
        expect(updateRow.after.state).toBe('SETTLED');
        expect(updateRow.after.settledAt).toBeTruthy();
        expect(updateRow.user).toBe(ADMIN_UID);
        // 两次 RPC = 两个请求作用域 → txn 不同(txn 把"同一请求内多实体操作"捆成一组)
        expect(updateRow.txn).not.toBe(createRow.txn);
    });

    test('3. 归档器把账本落盘:文件行与流一致(含 ref 回指流条目)', async () => {
        let fileRows = [];
        for (let i = 0; i < 50; i++) {           // 归档是异步副本,轮询 ≤10s
            fileRows = wal.query(key);
            if (fileRows.length >= 2) break;
            await sleep(200);
        }
        expect(fileRows.length).toBeGreaterThanOrEqual(2);

        const byRef = new Map(fileRows.map((r) => [r.ref, r]));
        for (const streamRow of [createRow, updateRow]) {
            const f = byRef.get(streamRow.sid);
            expect(f).toBeDefined();
            expect(f.op).toBe(streamRow.op);
            expect(f.after).toEqual(streamRow.after);
            expect(f.user).toBe(streamRow.user);
            expect(f.stamp).toBe(streamRow.stamp);  // 原始时间戳保留 → 灾备回放按 stamp 重序
        }
    });

    test('4. 账本只增不漏:该 key 无多余行,失败请求不记账', async () => {
        // 对不存在的 id settle → 业务失败,不得产生账本行
        const bad = await rpc('collection.payment.settle', { id: 'no-such-payment' }, ADMIN_TOKEN);
        expect(bad.error).toBeDefined();

        const rows = await ledgerFor(key);
        expect(rows).toHaveLength(2);
        const all = await redis.xRange(STREAM, '-', '+');
        const phantom = all.filter(({ message }) => (message.key || '').includes('no-such-payment'));
        expect(phantom).toHaveLength(0);
    });
});
