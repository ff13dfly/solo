/**
 * smtp-transport-options.test.js — `options` 透传档的合并规则（hermetic，不联网）。
 *
 * 背景：换邮箱厂商（Gmail → 163 / QQ / Outlook / SES-SMTP）**不需要写 adapter**，
 * 因为 SMTP 是 RFC 5321 标准协议，差异落在 host/port/secure 上、属于配置。但 nodemailer
 * 还有一批开关是 host/port/secure 表达不了的（requireTLS、tls.ciphers、pool 限速、
 * EHLO name、各类 timeout），此前 `createTransport` 写死了 4 个字段，一个都传不进去。
 * `options` 就是补这一档。
 *
 * 本套锁死两件事：
 *   ① 合并方向：options 先铺底、显式字段后盖 —— options **劫持不了** host/port/auth。
 *      这条是安全边界：SMTP 账号可由管理员经 gateway.smtp.create 写入，如果 options
 *      能覆盖 host/auth，一条记录就能把凭据发去任意服务器。
 *   ② env 路与实体路走的是**同一个函数**。两边各写一遍必然漂，而"env 路支持 requireTLS、
 *      实体路不支持"这种不一致，症状只会是某一条路莫名连不上，极难定位。
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-gateway-smtpopt-${process.pid}`);
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';

const { buildTransportOptions, createSmtpEntity } = require('../logic/smtp');
const { makeFakeRedis } = require('./helpers/fake-redis');

const BASE = { host: 'smtp.example.com', port: 587, secure: false, user: 'u@example.com', pass: 's3cret' };

describe('buildTransportOptions — 合并规则', () => {
    test('不给 options 时，只产出四个显式字段', () => {
        expect(buildTransportOptions(BASE)).toEqual({
            host: 'smtp.example.com', port: 587, secure: false,
            auth: { user: 'u@example.com', pass: 's3cret' },
        });
    });

    test('options 里的 nodemailer 开关被透传', () => {
        const out = buildTransportOptions({
            ...BASE,
            options: { requireTLS: true, tls: { rejectUnauthorized: false, ciphers: 'SSLv3' }, pool: true, rateLimit: 5, name: 'mail.mycorp.com', connectionTimeout: 20000 },
        });
        expect(out.requireTLS).toBe(true);
        expect(out.tls).toEqual({ rejectUnauthorized: false, ciphers: 'SSLv3' });
        expect(out.pool).toBe(true);
        expect(out.rateLimit).toBe(5);
        expect(out.name).toBe('mail.mycorp.com');
        expect(out.connectionTimeout).toBe(20000);
    });

    test('🔴 options 劫持不了连接目标与凭据（安全边界）', () => {
        const out = buildTransportOptions({
            ...BASE,
            options: { host: 'evil.example.com', port: 2525, secure: true, auth: { user: 'attacker', pass: 'x' } },
        });
        expect(out.host).toBe('smtp.example.com');           // 不是 evil
        expect(out.port).toBe(587);
        expect(out.secure).toBe(false);
        expect(out.auth).toEqual({ user: 'u@example.com', pass: 's3cret' });
    });

    test.each([
        ['字符串', 'requireTLS=true'],
        ['数组', [{ requireTLS: true }]],
        ['null', null],
        ['undefined', undefined],
        ['数字', 42],
    ])('options 是%s 时安全忽略，不炸也不污染', (_label, bad) => {
        expect(buildTransportOptions({ ...BASE, options: bad })).toEqual({
            host: 'smtp.example.com', port: 587, secure: false,
            auth: { user: 'u@example.com', pass: 's3cret' },
        });
    });
});

describe('gateway.smtp 实体 — options 随记录存取', () => {
    test('create 存进去、getDecrypted 取回来，且 pass 仍不外泄', async () => {
        const entity = createSmtpEntity(makeFakeRedis());
        const opts = { requireTLS: true, tls: { ciphers: 'TLSv1.2' } };

        const created = await entity.create({ name: 'a', ...BASE, from: 'noreply@example.com', options: opts });
        expect(created.pass).toBeUndefined();                 // 响应里没有密码
        expect(created.options).toEqual(opts);                // options 不是敏感字段，照常返回

        const full = await entity.getDecrypted(created.id);
        expect(full.options).toEqual(opts);
        expect(full.pass).toBe('s3cret');                     // 解密回明文供建 transporter

        // 端到端：取出来的这份配置喂给合并函数，nodemailer 该看到的都在
        const t = buildTransportOptions(full);
        expect(t).toEqual({
            host: 'smtp.example.com', port: 587, secure: false,
            auth: { user: 'u@example.com', pass: 's3cret' },
            requireTLS: true, tls: { ciphers: 'TLSv1.2' },
        });
    });
});

describe('config.js — EMAIL_SMTP_OPTIONS 解析', () => {
    const load = (raw) => {
        jest.resetModules();
        const prev = process.env.EMAIL_SMTP_OPTIONS;
        if (raw === undefined) delete process.env.EMAIL_SMTP_OPTIONS;
        else process.env.EMAIL_SMTP_OPTIONS = raw;
        try { return require('../config').email.smtp.options; }
        finally {
            if (prev === undefined) delete process.env.EMAIL_SMTP_OPTIONS;
            else process.env.EMAIL_SMTP_OPTIONS = prev;
        }
    };

    test('未设置 → undefined（默认行为不变）', () => expect(load(undefined)).toBeUndefined());

    test('合法 JSON 对象 → 解析成对象', () => {
        expect(load('{"requireTLS":true,"tls":{"ciphers":"SSLv3"}}')).toEqual({ requireTLS: true, tls: { ciphers: 'SSLv3' } });
    });

    // 静默忽略一个配错的 tls 选项，表现是"连不上"，排查方向会被引到网络上去 —— 所以当场炸。
    test('JSON 语法错 → 当场抛，不静默忽略', () => expect(() => load('{requireTLS:true}')).toThrow(/EMAIL_SMTP_OPTIONS 不是合法 JSON/));
    test('是 JSON 但不是对象 → 当场抛', () => expect(() => load('[1,2]')).toThrow(/必须是 JSON 对象/));
});
