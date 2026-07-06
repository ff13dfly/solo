/**
 * 25 · gateway 出站通道配置 CRUD(只配置,不真发).
 * email_template 走四连(entity-factory 有 WAL,但 gateway 无 walContext → WAL user=null,不断言 user).
 * smtp 验敏感字段:pass 不出现在响应、落库里是密文(≠ 明文).
 * 危险方法(*.send / *.delete / rmbg)一律排除.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('25 · gateway smtp/template config', () => {
    let redis, uid, token, tplId, smtpId;
    const name = `e2e-gateway-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { gateway: ['*'] }));
    }, 20_000);
    afterAll(async () => {
        if (tplId) { await redis.del(`GATEWAY:EMAIL_TEMPLATE:${tplId}`); await redis.sRem('GATEWAY:EMAIL_TEMPLATE:INDEX', tplId); }
        if (smtpId) { await redis.del(`GATEWAY:SMTP:${smtpId}`); await redis.sRem('GATEWAY:SMTP:INDEX', smtpId); }
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('email.template.create → ①API ②落库(+SET 索引)③WAL(user=null,gateway 无 walContext)', async () => {
        const t = V.assertResult(await rpc('gateway.email.template.create', { name: 'Welcome', subject: 'Hi {{name}}', html: '<p>{{name}}</p>', variables: ['name'] }, token), 'template.create');
        tplId = t.id;
        const key = `GATEWAY:EMAIL_TEMPLATE:${tplId}`;
        await V.assertRecord(redis, key, { name: 'Welcome', subject: 'Hi {{name}}' }, { indexKey: 'GATEWAY:EMAIL_TEMPLATE:INDEX' });  // ②
        V.assertWal(undefined, key, 'create');   // ③ 有 create 行(before:null);gateway 不注入 user,故不断言 user
        await V.assertNoErrors(redis, ['gateway']);
    });

    test('smtp.create → 敏感字段 pass 不外泄,落库为密文', async () => {
        const SECRET = 'secretpass123';
        const s = V.assertResult(await rpc('gateway.smtp.create', { name: 'Test SMTP', host: 'smtp.example.com', port: 587, secure: false, user: 'u@example.com', pass: SECRET, from: 'noreply@example.com' }, token), 'smtp.create');
        smtpId = s.id;
        expect(s.pass).toBeUndefined();   // 响应不含明文 pass

        const rec = await V.assertRecord(redis, `GATEWAY:SMTP:${smtpId}`, { host: 'smtp.example.com', port: 587 });
        if (rec.pass !== undefined) expect(rec.pass).not.toBe(SECRET);   // 落库里若有 pass,必为密文
    });

    test('list / get reflect both', async () => {
        expect(V.assertResult(await rpc('gateway.smtp.list', {}, token)).items.some((x) => x.id === smtpId)).toBe(true);
        expect(V.assertResult(await rpc('gateway.email.template.get', { id: tplId }, token)).id).toBe(tplId);
    });
});
