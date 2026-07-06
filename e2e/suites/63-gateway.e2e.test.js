/**
 * 63 · gateway 全量方法覆盖(补 25-gateway 的缺口).
 *
 * 25-gateway 只覆盖了 email.template.create/get/list + smtp.create/list。
 * 本套补齐其余无 e2e 覆盖的方法:
 *   - gateway.echo                         (最简:回环 params)
 *   - smtp.get / update / delete / test    (SMTP 账号 CRUD;test 连不上 → 结构化错误,不崩)
 *   - email.template.update / delete       (邮件模版剩余 CRUD)
 *   - sms.template.create/get/list/update/delete (短信模版全量 CRUD — 全仓首次覆盖)
 *   - email.send / sms.send / rmbg.cutout  (依赖外部服务 → 只验"可达契约":缺参/缺资源
 *                                           返回结构化错误,断言 err.code≠-32601,不断真实投递)
 *
 * full profile;管理操作用 ADMIN_TOKEN(allow_all)。
 * 实体键(EntityFactory):GATEWAY:{ENTITY}:{id} + GATEWAY:{ENTITY}:INDEX;afterAll 兜底清理。
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const wal = require('../lib/wal');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

// JSON-RPC 标准码;可达 = 非 METHOD_NOT_FOUND(-32601)。
const METHOD_NOT_FOUND = -32601;

gate('63 · gateway full method coverage', () => {
    let redis;
    let smtpId;        // gateway.smtp 实体
    let emailTplId;    // gateway.email_template 实体
    let smsTplId;      // gateway.sms_template 实体

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        // 兜底清理(测试用例多数自删,残留时直接 del key + 从 INDEX 移除)。
        if (smtpId)     { await redis.del(`GATEWAY:SMTP:${smtpId}`);                 await redis.sRem('GATEWAY:SMTP:INDEX', smtpId); }
        if (emailTplId) { await redis.del(`GATEWAY:EMAIL_TEMPLATE:${emailTplId}`);   await redis.sRem('GATEWAY:EMAIL_TEMPLATE:INDEX', emailTplId); }
        if (smsTplId)   { await redis.del(`GATEWAY:SMS_TEMPLATE:${smsTplId}`);       await redis.sRem('GATEWAY:SMS_TEMPLATE:INDEX', smsTplId); }
        await redis.quit();
    });

    // ── echo ──────────────────────────────────────────────────────────────────
    test('gateway.echo — 回环 params', async () => {
        const payload = { ping: `e2e-${process.pid}`, n: 42 };
        const r = V.assertResult(await rpc('gateway.echo', payload, ADMIN_TOKEN), 'echo');
        expect(r.echo).toBeTruthy();
        expect(r.echo.ping).toBe(payload.ping);   // 透传原样回来
        expect(r.echo.n).toBe(42);
    });

    // ── SMTP CRUD + test ───────────────────────────────────────────────────────
    test('smtp.get / update / delete / test (连不上 → 结构化错误)', async () => {
        // create(本套自有,独立于 25 的 smtp 用例)
        const SECRET = 'pw-63';
        const created = V.assertResult(await rpc('gateway.smtp.create', {
            name: `e2e-smtp-${process.pid}`, host: '127.0.0.1', port: 1, secure: false,
            user: 'u@example.com', pass: SECRET, from: 'noreply@example.com'
        }, ADMIN_TOKEN), 'smtp.create');
        smtpId = created.id;
        expect(created.pass).toBeUndefined();   // 响应不外泄明文

        // get — pass 省略,字段回读
        const got = V.assertResult(await rpc('gateway.smtp.get', { id: smtpId }, ADMIN_TOKEN), 'smtp.get');
        expect(got.id).toBe(smtpId);
        expect(got.host).toBe('127.0.0.1');
        expect(got.pass).toBeUndefined();

        // update — 改 name,回读生效
        const upd = V.assertResult(await rpc('gateway.smtp.update', { id: smtpId, name: 'renamed-smtp' }, ADMIN_TOKEN), 'smtp.update');
        expect(upd.name).toBe('renamed-smtp');
        await V.assertRecord(redis, `GATEWAY:SMTP:${smtpId}`, { name: 'renamed-smtp' });   // ②落库

        // test — 127.0.0.1:1 必拒连;断言结构化错误(可达,非 METHOD_NOT_FOUND),不崩。
        const testRes = await rpc('gateway.smtp.test', { id: smtpId }, ADMIN_TOKEN);
        const err = V.assertRpcError(testRes, undefined, 'smtp.test on unreachable host');
        expect(err.code).not.toBe(METHOD_NOT_FOUND);
        expect(typeof err.message).toBe('string');

        // delete — 硬删:key 消失 + 从 INDEX 移除
        const del = V.assertResult(await rpc('gateway.smtp.delete', { id: smtpId }, ADMIN_TOKEN), 'smtp.delete');
        expect(del.success).toBe(true);
        expect(await redis.exists(`GATEWAY:SMTP:${smtpId}`)).toBe(0);
        expect(await redis.sIsMember('GATEWAY:SMTP:INDEX', smtpId)).toBe(false);
        smtpId = null;   // 已删,afterAll 无需再清
    });

    // ── Email template update / delete ──────────────────────────────────────────
    test('email.template.update / delete', async () => {
        const created = V.assertResult(await rpc('gateway.email.template.create', {
            name: `e2e-emailtpl-${process.pid}`, subject: 'Hi {{name}}', html: '<p>{{name}}</p>', variables: ['name']
        }, ADMIN_TOKEN), 'email.template.create');
        emailTplId = created.id;

        const upd = V.assertResult(await rpc('gateway.email.template.update', { id: emailTplId, subject: 'Hello {{name}}' }, ADMIN_TOKEN), 'email.template.update');
        expect(upd.subject).toBe('Hello {{name}}');
        await V.assertRecord(redis, `GATEWAY:EMAIL_TEMPLATE:${emailTplId}`, { subject: 'Hello {{name}}' });   // ②落库

        const tplList = V.assertResult(await rpc('gateway.email.template.list', {}, ADMIN_TOKEN), 'email.template.list');
        expect(Array.isArray(tplList.items || tplList)).toBe(true);   // list 可用、返回模版集合(成员性受默认分页影响,不强断)

        const del = V.assertResult(await rpc('gateway.email.template.delete', { id: emailTplId }, ADMIN_TOKEN), 'email.template.delete');
        expect(del.success).toBe(true);
        expect(await redis.exists(`GATEWAY:EMAIL_TEMPLATE:${emailTplId}`)).toBe(0);
        emailTplId = null;
    });

    // ── SMS template CRUD(全仓首次覆盖)──────────────────────────────────────────
    test('sms.template.create / get / list / update / delete', async () => {
        // create
        const created = V.assertResult(await rpc('gateway.sms.template.create', {
            name: `e2e-smstpl-${process.pid}`, channel: 'mock', providerCode: 'SMS_0001', variables: ['code']
        }, ADMIN_TOKEN), 'sms.template.create');
        smsTplId = created.id;
        expect(created.name).toBe(`e2e-smstpl-${process.pid}`);
        await V.assertRecord(redis, `GATEWAY:SMS_TEMPLATE:${smsTplId}`,
            { providerCode: 'SMS_0001' }, { indexKey: 'GATEWAY:SMS_TEMPLATE:INDEX' });   // ②落库 + 索引

        // get
        const got = V.assertResult(await rpc('gateway.sms.template.get', { id: smsTplId }, ADMIN_TOKEN), 'sms.template.get');
        expect(got.id).toBe(smsTplId);
        expect(got.providerCode).toBe('SMS_0001');

        // list — 含本条
        const list = V.assertResult(await rpc('gateway.sms.template.list', {}, ADMIN_TOKEN), 'sms.template.list');
        expect(list.items.some((x) => x.id === smsTplId)).toBe(true);

        // update
        const upd = V.assertResult(await rpc('gateway.sms.template.update', { id: smsTplId, providerCode: 'SMS_0002' }, ADMIN_TOKEN), 'sms.template.update');
        expect(upd.providerCode).toBe('SMS_0002');
        await V.assertRecord(redis, `GATEWAY:SMS_TEMPLATE:${smsTplId}`, { providerCode: 'SMS_0002' });

        // delete
        const del = V.assertResult(await rpc('gateway.sms.template.delete', { id: smsTplId }, ADMIN_TOKEN), 'sms.template.delete');
        expect(del.success).toBe(true);
        expect(await redis.exists(`GATEWAY:SMS_TEMPLATE:${smsTplId}`)).toBe(0);
        expect(await redis.sIsMember('GATEWAY:SMS_TEMPLATE:INDEX', smsTplId)).toBe(false);
        smsTplId = null;
    });

    // ── External-dependent sends: 只验可达契约,不验真实投递 ───────────────────────
    // email.send 缺必填(to/subject/content) → logic 抛错 → 结构化 -32603,不崩。
    test('email.send (no recipient) → 结构化错误,非 crash/非 METHOD_NOT_FOUND', async () => {
        const res = await rpc('gateway.email.send', { subject: 's', content: 'c' }, ADMIN_TOKEN);   // 缺 to
        const err = V.assertRpcError(res, undefined, 'email.send missing recipient');
        expect(err.code).not.toBe(METHOD_NOT_FOUND);   // 可达(方法存在,只是契约校验失败)
        expect(typeof err.message).toBe('string');
    });

    // SUCCESS path: full params + no SMTP/API key in the harness → mock channel honestly delivers
    // and writes a file-WAL row. Closes the gap where both gateway suites only hit the error contract.
    test('email.send (full params) → success via mock channel + gateway WAL row', async () => {
        const to = `e2e-63-${process.pid}@example.com`;
        const r = V.assertResult(await rpc('gateway.email.send', { to, subject: 'e2e-63-subject', content: 'hello' }, ADMIN_TOKEN), 'email.send');
        expect(r.success).toBe(true);

        // mock channel writes an honest audit row; poll for the async file flush (mirrors suite 100)
        let row = null;
        for (let i = 0; i < 24 && !row; i++) {
            row = (wal.query(`email:${to}`) || []).find((x) => x.op === 'email.send');
            if (!row) await new Promise((res) => setTimeout(res, 250));
        }
        expect(row).toBeTruthy();
        expect(row.to).toBe(to);
        expect(row.channel).toBe('mock');   // no SMTP/API key → mock, honestly recorded (not a real send)
    });

    // sms.send 缺 templateId → logic 抛 'Missing required field: templateId' → 结构化错误。
    test('sms.send (no templateId) → 结构化错误,非 crash/非 METHOD_NOT_FOUND', async () => {
        const res = await rpc('gateway.sms.send', { phone: '+10000000000', variables: {} }, ADMIN_TOKEN);
        const err = V.assertRpcError(res, undefined, 'sms.send missing templateId');
        expect(err.code).not.toBe(METHOD_NOT_FOUND);
        expect(typeof err.message).toBe('string');
    });

    // rmbg.cutout 缺 image → logic 抛 'Missing required field: image (base64)' → 结构化错误。
    // (传 image 时会尝试本地 ONNX(localhost:3099)→ 无 REMOVEBG_API_KEY → 也抛错;
    //  缺 image 路径更快更确定,同样验证了"方法可达 + 结构化错误"契约。)
    test('rmbg.cutout (no image) → 结构化错误,非 crash/非 METHOD_NOT_FOUND', async () => {
        const res = await rpc('gateway.rmbg.cutout', {}, ADMIN_TOKEN);
        const err = V.assertRpcError(res, undefined, 'rmbg.cutout missing image');
        expect(err.code).not.toBe(METHOD_NOT_FOUND);
        expect(typeof err.message).toBe('string');
    });
});
