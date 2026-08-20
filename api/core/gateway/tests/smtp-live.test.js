/**
 * smtp-live.test.js — LIVE: 真的连一台 SMTP 服务器，真的把信发出去。
 *
 * 为什么单独开一套：gateway 的 SMTP **出站**路径此前零覆盖。仓库里既有的套覆盖了它的
 * 外围——25-gateway 验账号 CRUD 与密码加密落库、63-gateway 把 host 指向 127.0.0.1:1 验
 * 连不上时的结构化错误、returns-contract 验返回契约（走 mock）——唯独没有一处让
 * `logic/email.js sendSmtp()` 或 `logic/smtp.js getTransporter()` 对着真服务器跑过。
 *
 * 🔴 而这条路径的失败是**静默**的：`resolveChannel()`(logic/email.js:15) 在
 *    EMAIL_SMTP_HOST 为空时回落 mock，mock 同样返回 `{success:true}`（:118 的注释自己
 *    写着 "Callers must check provider !== 'mock'"）。所以只断言 success 的测试会永远
 *    绿着，而一封信都没发出去。本套每个投递用例都**显式断言 provider === 'smtp'**。
 *
 * 两级门（照 core/agent/tests/decide.test.js:127 的 LIVE 惯例，凭据不在就 skip）：
 *   ① 连接+认证：需要 EMAIL_SMTP_HOST / EMAIL_SMTP_USER / EMAIL_SMTP_PASS
 *   ② 真投递：还需要 EMAIL_LIVE_TO —— 没设就只验到认证为止，不往任何人的信箱里塞东西
 *
 * 跑法（凭据只走环境变量，别写进任何进 git 的文件）：
 *   EMAIL_SMTP_HOST=smtp.gmail.com EMAIL_SMTP_PORT=587 EMAIL_SMTP_SECURE=false \
 *   EMAIL_SMTP_USER='you@gmail.com' EMAIL_SMTP_PASS='<16位应用专用密码,无空格>' \
 *   EMAIL_FROM='you@gmail.com' EMAIL_LIVE_TO='dest@example.com' \
 *   npx jest core/gateway/tests/smtp-live.test.js
 *
 * Gmail 专属注意：
 *   - 必须先开两步验证再生成「应用专用密码」（账号登录密码一定 535）。
 *   - from 必须等于认证账号，否则 Gmail 会把 From 改写回去。
 *   - 🔴 **应用专用密码全是小写字母，抄的时候当心 `l`(小写L) / `I`(大写i) / `1`**。Google
 *     展示用的那个字体里三者几乎同形；2026-08-20 首次接通就卡在这——把 `lnmb…` 读成
 *     `Inmb…`，连试 4 种端口/大小写组合全是 `535-5.7.8 BadCredentials`，看起来像密码失效
 *     或被风控，实际只错了一个字母。**`5.7.8` 只说"用户名密码不对"，不指向具体哪里错。**
 *
 * 实测时序（2026-08-20，本机经 Clash 代理出境，Gmail）：认证约 12–17s，带投递的完整档
 * 约 44–50s——比同仓任何一套都慢一个量级，TIMEOUT 因此设到 45s，别按普通单测的 5s 去卡。
 * 完整档实跑 3 轮，green/green/1 例失败（失败的是实体路那条，未留下原因；同轮次里对 Gmail
 * 连开三条认证连接，疑似撞到它的连接频率限制）。**偶发一次别当回归**，重跑一轮再判断。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-gateway-smtplive-${process.pid}`);
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';

const createLogic = require('../logic');
const baseConfig = require('../config');
const emailProvider = require('../logic/email');
const { makeFakeRedis, silentLogger: logger } = require('./helpers/fake-redis');

const HAS_CREDS = Boolean(process.env.EMAIL_SMTP_HOST && process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS);
const HAS_TARGET = Boolean(process.env.EMAIL_LIVE_TO);
const liveSmtp = HAS_CREDS ? describe : describe.skip;
const liveSend = HAS_CREDS && HAS_TARGET ? describe : describe.skip;

// 代理/跨境链路下一次握手就要好几秒，默认 5s 必挂。
const TIMEOUT = 45000;

// config.js 在模块加载时读 env，本套跑之前 env 就已就位，直接用它——这样测的是
// 服务真正会用的那份配置，而不是测试自己拼的一份。
const cfg = baseConfig.email;
const smtpAccount = () => ({
    name: `live-${process.pid}`,
    host: process.env.EMAIL_SMTP_HOST,
    port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
    secure: process.env.EMAIL_SMTP_SECURE === 'true',
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS,
    from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER,
});

liveSmtp('gateway SMTP — LIVE 连接与认证', () => {
    test('resolveChannel 落在 smtp，而不是静默回落 mock', () => {
        // 这条先跑：后面所有断言的前提。落到 mock 的话下面全都会"通过"却什么也没发。
        expect(emailProvider.resolveChannel(cfg)).toBe('smtp');
    });

    test('env 路：transporter.verify() 通过（连接 + 认证）', async () => {
        await expect(emailProvider.getSmtpTransporter(cfg)).resolves.toBeDefined();
    }, TIMEOUT);

    test('实体路：加密落库的密码解出来能真的连上（gateway.smtp.test）', async () => {
        // 这一步是 25-gateway 与本套的接缝：那边验了 pass 落库是密文，但没验过
        // 「解密出来的那份还能用」。加密与真实连接必须放在一起测，否则中间的
        // encrypt/decrypt 往返坏了，两边各自的测试都还是绿的。
        const M = createLogic(makeFakeRedis(), { serviceName: 'gateway', config: baseConfig, logger });
        const created = await M.smtp.create(smtpAccount());
        expect(created.pass).toBeUndefined();               // 密码不出现在响应里

        const res = await M.smtp.test({ id: created.id });
        expect(res.success).toBe(true);
    }, TIMEOUT);
});

liveSend('gateway SMTP — LIVE 投递', () => {
    const stamp = () => new Date().toISOString();

    test('env 路：email.send 真的把信发出去，provider === smtp', async () => {
        const r = await emailProvider.send(cfg, {
            to: process.env.EMAIL_LIVE_TO,
            subject: `[solo] LIVE env 路 ${stamp()}`,
            content: '由 logic/email.js sendSmtp() 发出（env 配置路径）。',
            html: '<p>由 <code>logic/email.js</code> <code>sendSmtp()</code> 发出（env 配置路径）。</p>',
        });
        expect(r.provider).toBe('smtp');      // ← 不是 'mock'，信真的走了
        expect(r.success).toBe(true);
        expect(typeof r.messageId).toBe('string');
        expect(r.messageId.length).toBeGreaterThan(0);
    }, TIMEOUT);

    test('实体路：email.send {smtpId} 用指定账号发出，provider === smtp', async () => {
        const M = createLogic(makeFakeRedis(), { serviceName: 'gateway', config: baseConfig, logger });
        const acct = await M.smtp.create(smtpAccount());

        const r = await M.email.send({
            smtpId: acct.id,
            to: process.env.EMAIL_LIVE_TO,
            subject: `[solo] LIVE 实体路 ${stamp()}`,
            content: '由 logic/index.js 的 smtpId 分支发出（账号存 Redis、密码加密落库）。',
        });
        expect(r.provider).toBe('smtp');
        expect(r.success).toBe(true);
        expect(typeof r.messageId).toBe('string');
    }, TIMEOUT);
});

// 凭据缺席时留一条可见的记录，免得"全绿"被误读成"发信验过了"。
(HAS_CREDS ? test.skip : test)('LIVE SMTP 未运行（没有 EMAIL_SMTP_* 凭据，按设计 skip）', () => {
    expect(HAS_CREDS).toBe(false);
});
