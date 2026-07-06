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
        mailUserId = V.assertResult(await rpc('user.register', { name: `mail-${PID}`, email: EMAIL }, ADMIN_TOKEN), 'register mail user').uid;
        bareUserId = V.assertResult(await rpc('user.register', { name: `bare-${PID}` }, ADMIN_TOKEN), 'register bare user').uid;
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
