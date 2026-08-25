/**
 * 100 · 投递面闭环(toFix 一.3 + 二.notification)+ 机器身份(二.identity C1/C2)
 *
 * A 包验证(经 Router 全真实路径,notification worker 异步投递):
 *   1. email 默认出站地址:user 注册带 email → 规则只写 channel,不写地址
 *      → worker 解析 user.profile.email → gateway.email.send(无 SMTP → mock,诚实标记)
 *      → 断言:gateway 文件 WAL 留痕 `email:{address}`(to=profile email、channel=mock),
 *        且无重试/无死信(mock ≠ 失败);payload 的 subject/content 真正到达 gateway。
 *   2. webhook 出站:测试内起本地 HTTP 监听器当"外部系统",规则带 url+secret
 *      → 断言收到 POST:HMAC-SHA256 签名可验、payload 完整、trace 头无关(机器对机器)。
 *   3. 降级:无 email 的用户 + email 规则 → 不失败不重试,inbox 副本即投递。
 *   4. sse fail-closed:config.set 直接拒绝(不再"配上即死信")。
 *
 * C 包验证(suspend 即时咬活 session = C1 Scheme F bot 键 + C2 写侧 setter 联动):
 *   5. bot 发证 → 可调 → suspend → 同 token 立即被拒 → resume+重发证 → 恢复。
 *
 * 仅 full profile(要 notification worker + gateway + user 全为本轮新代码)。
 */
const http = require('http');
const crypto = require('crypto');
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const wal = require('../lib/wal');
const { ADMIN_TOKEN } = require('../harness/identity');
const { sha256, randomHex } = require('../lib/crypto');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.pid;
const EMAIL = `e2e-100-${PID}@example.com`;
const WH_SECRET = `wh-secret-${PID}`;

gate('100 · delivery plane + reversible bot suspension', () => {
    let redis;
    let mailUserId;     // 带 email 的用户
    let bareUserId;     // 无 email 的用户(降级路径)
    let whServer;
    let whPort;
    const whReceived = [];

    beforeAll(async () => {
        redis = await redisLib.connect();

        // "外部系统":本地 HTTP 监听器收 webhook
        await new Promise((resolve) => {
            whServer = http.createServer((req, res) => {
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => {
                    whReceived.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
                    res.statusCode = 200; res.end('ok');
                });
            });
            whServer.listen(0, '127.0.0.1', () => { whPort = whServer.address().port; resolve(); });
        });

        // 两个用户:带 email / 不带(register 实际返回 { success, uid })
        // salt + hash 是 user.register 的必填项(handlers/introspection.js 里两个都
        // required:true,router GUIDE §2b 也写明"注册必须客户端自带")。本套只需要 uid、
        // 从不以这两个用户身份登录,所以随机派生即可——但**不能省**:省掉的表现是
        // [-32602] missing mandatory field 'salt',整套 7 个用例全红。
        // 这处漂移在 CI 里烂了很久没人发现,因为 CI 的 npm ci 一直失败、e2e 从没跑到过
        // (见 CHANGELOG v1.2.4)。
        const mkCreds = () => { const salt = randomHex(16); return { salt, hash: sha256(`e2e-100-pw${salt}` + salt) }; };
        mailUserId = V.assertResult(await rpc('user.register', { name: `mail-${PID}`, email: EMAIL, ...mkCreds() }, ADMIN_TOKEN), 'register mail user').uid;
        bareUserId = V.assertResult(await rpc('user.register', { name: `bare-${PID}`, ...mkCreds() }, ADMIN_TOKEN), 'register bare user').uid;
    }, 30_000);

    afterAll(async () => {
        if (whServer) await new Promise((r) => whServer.close(r));
        if (redis) await redis.quit().catch(() => {});
    });

    test('1. email 经 profile 默认地址投递(mock 诚实:留痕但不算失败)', async () => {
        V.assertResult(await rpc('notification.config.set', {
            targetId: mailUserId,
            rules: [{ type: 'alert', channel: 'email' }],   // 规则不写地址 → profile email
        }, ADMIN_TOKEN), 'config.set email');

        V.assertResult(await rpc('notification.send', {
            targetId: mailUserId, type: 'alert',
            payload: { subject: `S-${PID}`, content: `C-${PID}` },
        }, ADMIN_TOKEN), 'send');

        // worker 异步:轮询 gateway 的 email 文件 WAL(mock 通道也写审计行)
        let rows = [];
        for (let i = 0; i < 40 && rows.length === 0; i++) {
            await sleep(500);
            rows = wal.query(`email:${EMAIL}`);
        }
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const row = rows[rows.length - 1];
        expect(row.op).toBe('email.send');
        expect(row.to).toBe(EMAIL);                   // 地址来自 user.profile,规则里没写
        expect(row.subject).toBe(`S-${PID}`);         // msg.payload 不再被丢弃
        expect(row.channel).toBe('mock');             // 无 SMTP → mock,诚实记录

        // mock ≠ 失败:不进重试、不进死信
        const dead = await redis.lRange('NOTIFICATION:QUEUE:DEADLETTER', 0, -1);
        expect(dead.filter((s) => s.includes(mailUserId))).toHaveLength(0);
    }, 30_000);

    test('2. webhook 出站:外部端点收到带 HMAC 签名的完整 payload', async () => {
        V.assertResult(await rpc('notification.config.set', {
            targetId: `hook-target-${PID}`,
            rules: [{ type: 'hook', channel: 'webhook', params: { url: `http://127.0.0.1:${whPort}/cb`, secret: WH_SECRET } }],
        }, ADMIN_TOKEN), 'config.set webhook');

        V.assertResult(await rpc('notification.send', {
            targetId: `hook-target-${PID}`, type: 'hook',
            payload: { event: 'payment.settled', orderId: `ord-${PID}` },
        }, ADMIN_TOKEN), 'send hook');

        for (let i = 0; i < 40 && whReceived.length === 0; i++) await sleep(500);
        expect(whReceived.length).toBeGreaterThanOrEqual(1);

        const { headers, body } = whReceived[0];
        const parsed = JSON.parse(body);
        expect(parsed.type).toBe('hook');
        expect(parsed.payload).toEqual({ event: 'payment.settled', orderId: `ord-${PID}` });
        // 收件方验签:对原始 body 重算 HMAC
        const expected = 'sha256=' + crypto.createHmac('sha256', WH_SECRET).update(body).digest('hex');
        expect(headers['x-solo-signature']).toBe(expected);
    }, 30_000);

    test('3. 无地址 → 降级回 inbox:不失败、不重试、站内可读', async () => {
        V.assertResult(await rpc('notification.config.set', {
            targetId: bareUserId,
            rules: [{ type: 'alert', channel: 'email' }],
        }, ADMIN_TOKEN), 'config.set bare');

        const sent = V.assertResult(await rpc('notification.send', {
            targetId: bareUserId, type: 'alert', payload: { content: 'degrade-me' },
        }, ADMIN_TOKEN), 'send bare');

        await sleep(4000);   // 给 worker 一轮处理时间

        // inbox 副本在(send 时写入),投递语义=降级成功
        const inbox = V.assertResult(await rpc('notification.inbox.list', { targetId: bareUserId, unreadOnly: true }, ADMIN_TOKEN), 'inbox');
        expect(inbox.items.map((m) => m.id)).toContain(sent.id);

        // 不在重试队列、不在死信
        const retry = await redis.zRange('NOTIFICATION:QUEUE:RETRY', 0, -1);
        expect(retry.filter((s) => s.includes(sent.id))).toHaveLength(0);
        const dead = await redis.lRange('NOTIFICATION:QUEUE:DEADLETTER', 0, -1);
        expect(dead.filter((s) => s.includes(sent.id))).toHaveLength(0);
    }, 30_000);

    test('4. sse fail-closed:配置即拒绝,不再静默死信', async () => {
        const res = await rpc('notification.config.set', {
            targetId: mailUserId,
            rules: [{ type: 'x', channel: 'sse' }],
        }, ADMIN_TOKEN);
        expect(res.error).toBeDefined();
        expect(res.error.message).toMatch(/sse/i);
    });

    // ── 投递台账 / 幂等键 / 投递事件(gateway-gaps G5·G7·G8,2026-07-30) ──────────
    //
    // 这三条只能在真链路上验:hermetic 套证明不了 `_event` 真被 Router 抽走并写进流
    // (一个 `{type}` 缺 `stream` 的信封在单测里长得完全正常,在 Router 里被静默 skip)。
    test('6. 出站台账 + 事件落流 + 幂等回放(经真 Router)', async () => {
        const STREAM = 'EVENT:GATEWAY:DELIVERY';
        const before = await redis.xLen(STREAM).catch(() => 0);
        const idemKey = `e2e-100-${PID}-idem`;

        // 直调 gateway(不经 notification):mock 通道 → provider:'mock'
        const first = V.assertResult(await rpc('gateway.email.send', {
            to: `ledger-${PID}@example.com`,
            subject: `L-${PID}`, content: 'body',
            idempotencyKey: idemKey,
        }, ADMIN_TOKEN), 'gateway.email.send #1');

        expect(first.provider).toBe('mock');
        expect(typeof first.deliveryId).toBe('string');
        // Router 必须把 `_event` 从结果里摘掉,不能漏给客户端
        expect(first._event).toBeUndefined();

        // ① 台账可查(经 Router 的新方法)
        const row = V.assertResult(await rpc('gateway.delivery.get', { id: first.deliveryId }, ADMIN_TOKEN), 'delivery.get');
        expect(row.channel).toBe('email');
        expect(row.target).toBe(`ledger-${PID}@example.com`);
        expect(row.deliveryStatus).toBe('MOCKED');      // 无凭证 → 什么都没真发出去
        expect(row.idempotencyKey).toBe(idemKey);

        const listed = V.assertResult(await rpc('gateway.delivery.list', { limit: 20 }, ADMIN_TOKEN), 'delivery.list');
        expect(listed.items.some((r) => r.id === first.deliveryId)).toBe(true);

        // ② 事件真的写进了 Redis 流(注册表放行 + Router 盖信封)
        let entries = [];
        for (let i = 0; i < 20 && entries.length === 0; i++) {
            await sleep(250);
            const after = await redis.xLen(STREAM).catch(() => 0);
            if (after > before) {
                entries = await redis.xRange(STREAM, '-', '+');
            }
        }
        expect(entries.length).toBeGreaterThan(0);
        const mine = entries
            .map((e) => e.message)
            .filter((m) => (m.payload || '').includes(first.deliveryId));
        expect(mine).toHaveLength(1);
        expect(mine[0].type).toBe('gateway.delivery.mocked');
        expect(mine[0].source).toBe('gateway');          // Router 盖的 source,不可伪造
        expect(mine[0].event_id).toBeTruthy();
        expect(JSON.parse(mine[0].payload)).toMatchObject({
            channel: 'email', provider: 'mock', status: 'MOCKED', deliveryId: first.deliveryId,
        });

        // ③ 同幂等键 → 回放首次结果,不重发、不新增台账行
        const replay = V.assertResult(await rpc('gateway.email.send', {
            to: `ledger-${PID}@example.com`,
            subject: `L-${PID}`, content: 'body',
            idempotencyKey: idemKey,
        }, ADMIN_TOKEN), 'gateway.email.send #2 (same key)');

        expect(replay.deduplicated).toBe(true);
        expect(replay.messageId).toBe(first.messageId);
        expect(replay.deliveryId).toBe(first.deliveryId);

        const after2 = V.assertResult(await rpc('gateway.delivery.list', { limit: 50 }, ADMIN_TOKEN), 'delivery.list #2');
        expect(after2.items.filter((r) => r.idempotencyKey === idemKey)).toHaveLength(1);
    }, 40_000);

    // ── 回执回流 + 失败事件 + 通道探针(gateway-gaps G6·G8失败侧·G12,2026-07-30) ──
    test('7. 回执推进 + 失败事件落流 + 探针只读(经真 Router)', async () => {
        const STREAM = 'EVENT:GATEWAY:DELIVERY';

        // ① 回执:webhook 发一条(真 SENT 行) → delivery.update 推进 DELIVERED → 迟到 BOUNCED
        const sent = V.assertResult(await rpc('gateway.webhook.send', {
            url: `http://127.0.0.1:${whPort}/receipt-${PID}`, payload: { r: 1 },
        }, ADMIN_TOKEN), 'webhook.send for receipt');
        expect(sent.provider).toBe('webhook');

        const delivered = V.assertResult(await rpc('gateway.delivery.update', {
            id: sent.deliveryId, deliveryStatus: 'DELIVERED',
        }, ADMIN_TOKEN), 'delivery.update DELIVERED');
        expect(delivered.deliveryStatus).toBe('DELIVERED');
        expect(typeof delivered.receiptAt).toBe('number');

        const bounced = V.assertResult(await rpc('gateway.delivery.update', {
            id: sent.deliveryId, deliveryStatus: 'BOUNCED', detail: 'late bounce',
        }, ADMIN_TOKEN), 'delivery.update BOUNCED');
        expect(bounced.deliveryStatus).toBe('BOUNCED');

        // 非法转移被拒(MOCKED 是终态)
        const mocked = V.assertResult(await rpc('gateway.email.send', {
            to: `receipt-${PID}@example.com`, subject: 'R', content: 'r',
        }, ADMIN_TOKEN), 'mock email');
        const illegal = await rpc('gateway.delivery.update', { id: mocked.deliveryId, deliveryStatus: 'DELIVERED' }, ADMIN_TOKEN);
        expect(illegal.error).toBeDefined();
        expect(illegal.error.message).toMatch(/illegal receipt transition MOCKED/);

        // ② 失败事件:打一个必然连接失败的端口 → FAILED 台账行 + relay event.emit 落流
        //    (system.gateway bot 由 harness 从 bot-permits.js 播种;gateway.token.set 收 token)
        const failRes = await rpc('gateway.webhook.send', { url: 'http://127.0.0.1:1/dead', payload: {} }, ADMIN_TOKEN);
        expect(failRes.error).toBeDefined();

        let failedEvent = null;
        for (let i = 0; i < 20 && !failedEvent; i++) {
            await sleep(250);
            const entries = await redis.xRange(STREAM, '-', '+').catch(() => []);
            failedEvent = entries.map((e) => e.message).find((m) => m.type === 'gateway.delivery.failed') || null;
        }
        expect(failedEvent).not.toBeNull();
        expect(failedEvent.source).toBe('system.gateway');       // relay 路径,Router 按 bot 身份盖章
        const failPayload = JSON.parse(failedEvent.payload);
        expect(failPayload.channel).toBe('webhook');
        expect(failPayload.status).toBe('FAILED');
        expect(typeof failPayload.error).toBe('string');

        // ③ 探针:mock 通道诚实报"什么都不会发";只读、零投递副作用
        const probeRes = V.assertResult(await rpc('gateway.channel.test', { channel: 'email' }, ADMIN_TOKEN), 'channel.test');
        expect(probeRes.resolved).toBe('mock');
        expect(probeRes.ok).toBe(true);
        expect(probeRes.note).toMatch(/nothing will actually be sent/i);
    }, 40_000);

    test('5. 可逆 bot 暂停:suspend 即时咬活 token,resume 后恢复', async () => {
        const BOT = `system.e2e100-${PID}`;
        // 建 bot + 授一个无害读权限 + 发证
        V.assertResult(await rpc('user.bot.create', {
            uid: BOT, permit: { allow_all: false, services: { collection: ['collection.payment.list'] } },
        }, ADMIN_TOKEN), 'bot.create');
        const { token } = V.assertResult(await rpc('user.bot.issue.token', { uid: BOT }, ADMIN_TOKEN), 'issue');

        // 活 token 可调
        V.assertResult(await rpc('collection.payment.list', { pageSize: 1 }, token), 'bot call before suspend');

        // suspend → Scheme F 读 bot 键,同 token 立即被拒(不等 TTL)
        const sus = V.assertResult(await rpc('user.bot.suspend', { uid: BOT }, ADMIN_TOKEN), 'suspend');
        expect(sus.status).toBe('SUSPENDED');
        const blocked = await rpc('collection.payment.list', { pageSize: 1 }, token);
        expect(blocked.error).toBeDefined();

        // resume + 重新发证 → 恢复
        V.assertResult(await rpc('user.bot.resume', { uid: BOT }, ADMIN_TOKEN), 'resume');
        const { token: token2 } = V.assertResult(await rpc('user.bot.issue.token', { uid: BOT }, ADMIN_TOKEN), 're-issue');
        V.assertResult(await rpc('collection.payment.list', { pageSize: 1 }, token2), 'bot call after resume');

        // 清理
        await rpc('user.bot.delete', { uid: BOT }, ADMIN_TOKEN);
    }, 30_000);
});
