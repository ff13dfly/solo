/**
 * send-validation.test.js — the fail-fast layer in front of every outbound call
 * (gateway-gaps G15 / G16 / G17 + the plain-text template part G14 + cc/bcc/replyTo).
 *
 * Everything here used to be silent: an incomplete template crashed inside interpolate()
 * with `undefined.replace is not a function`, a typo'd address burned 5 retry attempts at
 * the provider, an omitted variable shipped a literal `{{code}}` to the recipient, and the
 * text/plain part was the raw HTML source.
 *
 * Hermetic: real logic factory + Entity Factory over a fake Redis, mock email/sms channel
 * (nothing leaves the process).
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-gateway-validation-${process.pid}`);
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';

const createLogic = require('../logic');
const baseConfig = require('../config');
const { makeFakeRedis, silentLogger } = require('./helpers/fake-redis');

// Force the mock channels regardless of the developer's local .env.
const config = {
    ...baseConfig,
    email: { ...baseConfig.email, channel: 'mock' },
    sms: { ...baseConfig.sms, channel: 'mock' },
};

const build = (overrides = {}) => createLogic(makeFakeRedis(), {
    serviceName: 'gateway',
    config: { ...config, ...overrides },
    logger: silentLogger,
});

let M;
beforeEach(() => { M = build(); });

// ─── G15: incomplete templates fail with a readable error, not a TypeError ────

describe('template completeness', () => {
    test('email template create requires name/subject/html (Entity Factory does not enforce them)', async () => {
        await expect(M.email.template.create({ name: 'welcome', subject: 'hi' }))
            .rejects.toMatchObject({ code: -32602, message: /'html' is required/ });
        await expect(M.email.template.create({ subject: 'hi', html: '<p>x</p>' }))
            .rejects.toMatchObject({ code: -32602, message: /'name' is required/ });
        await expect(M.email.template.create({ name: 'welcome', subject: '   ', html: '<p>x</p>' }))
            .rejects.toMatchObject({ code: -32602, message: /'subject' is required/ });
    });

    test('sms template create requires name/channel/providerCode', async () => {
        await expect(M.sms.template.create({ name: 'otp', channel: 'mock' }))
            .rejects.toMatchObject({ code: -32602, message: /'providerCode' is required/ });
    });

    test('wrong types are rejected on create AND update', async () => {
        await expect(M.email.template.create({ name: 'a', subject: 's', html: '<p/>', variables: 'code' }))
            .rejects.toMatchObject({ code: -32602, message: /'variables' must be an array/ });

        const tpl = await M.email.template.create({ name: 'a', subject: 's', html: '<p/>' });
        await expect(M.email.template.update({ id: tpl.id, html: 42 }))
            .rejects.toMatchObject({ code: -32602, message: /'html' must be a string/ });
        await expect(M.sms.template.create({ name: 'a', channel: 'mock', providerCode: 'S1', variableOrder: 'code' }))
            .rejects.toMatchObject({ code: -32602, message: /'variableOrder' must be an array/ });
    });

    test('update only checks the fields being written (partial update stays legal)', async () => {
        const tpl = await M.email.template.create({ name: 'a', subject: 's', html: '<p/>' });
        const updated = await M.email.template.update({ id: tpl.id, subject: 'new subject' });
        expect(updated.subject).toBe('new subject');
    });

    test('a template that predates the check still fails READABLY at send time', async () => {
        // Simulate legacy data: write through the raw entity, bypassing the new guard.
        const redis = makeFakeRedis();
        const EntityFactory = require('../../../library/entity');
        const raw = EntityFactory(redis, { serviceName: 'gateway', entityName: 'email_template' });
        const legacy = await raw.create({ name: 'legacy', subject: 'Hi {{name}}' });   // no html
        const logic = createLogic(redis, { serviceName: 'gateway', config, logger: silentLogger });

        await expect(logic.email.send({ to: 'a@example.com', templateId: legacy.id, variables: { name: 'X' } }))
            .rejects.toMatchObject({ code: -32602, message: /is incomplete: 'html' is missing/ });
    });
});

// ─── G17: recipient format is checked before any provider call ─────────────────

describe('recipient validation', () => {
    test.each([
        ['not-an-email'],
        ['a@b'],
        ['a b@example.com'],
        [''],
        [42],
        [null],
    ])('email.send rejects to=%p with -32602', async (to) => {
        await expect(M.email.send({ to, subject: 's', content: 'c' }))
            .rejects.toMatchObject({ code: -32602 });
    });

    test('email.send accepts a single address and an array', async () => {
        await expect(M.email.send({ to: 'a@example.com', subject: 's', content: 'c' }))
            .resolves.toMatchObject({ provider: 'mock' });
        await expect(M.email.send({ to: ['a@example.com', 'b@example.org'], subject: 's', content: 'c' }))
            .resolves.toMatchObject({ provider: 'mock' });
        await expect(M.email.send({ to: [], subject: 's', content: 'c' }))
            .rejects.toMatchObject({ code: -32602, message: /must not be empty/ });
    });

    test('cc / bcc / replyTo are validated too, and the error names the right field', async () => {
        await expect(M.email.send({ to: 'a@example.com', cc: 'nope', subject: 's', content: 'c' }))
            .rejects.toMatchObject({ code: -32602, message: /'cc' is not a valid email/ });
        await expect(M.email.send({ to: 'a@example.com', bcc: ['ok@example.com', 'bad'], subject: 's', content: 'c' }))
            .rejects.toMatchObject({ code: -32602, message: /'bcc' is not a valid email/ });
        await expect(M.email.send({ to: 'a@example.com', replyTo: 'x@', subject: 's', content: 'c' }))
            .rejects.toMatchObject({ code: -32602, message: /'replyTo' is not a valid email/ });
    });

    test('sms.send rejects malformed phone numbers before the provider', async () => {
        const tpl = await M.sms.template.create({ name: 'otp', channel: 'mock', providerCode: 'SMS_1' });
        for (const phone of ['abc', '12', '', null, '+++']) {
            await expect(M.sms.send({ templateId: tpl.id, phone, variables: {} }))
                .rejects.toMatchObject({ code: -32602 });
        }
        await expect(M.sms.send({ templateId: tpl.id, phone: '13800138000', variables: {} }))
            .resolves.toMatchObject({ provider: 'mock' });
    });

    test('the twilio channel additionally requires E.164 (aliyun accepts domestic numbers)', async () => {
        const twilioTpl = await M.sms.template.create({ name: 'otp', channel: 'twilio', providerCode: 'HX1' });
        await expect(M.sms.send({ templateId: twilioTpl.id, phone: '13800138000', variables: {} }))
            .rejects.toMatchObject({ code: -32602, message: /must be E\.164/ });

        // Aliyun: the same domestic number must PASS validation. Stub the provider so the
        // assertion never depends on "this machine happens to have no SMS credentials" —
        // with credentials present, the real sendAliyun would try to reach dysmsapi.
        const smsProvider = require('../logic/sms');
        const spy = jest.spyOn(smsProvider, 'send').mockResolvedValue({ success: true, messageId: 'x', provider: 'aliyun' });
        try {
            const logic = createLogic(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger });
            const aliyunTpl = await logic.sms.template.create({ name: 'otp2', channel: 'aliyun', providerCode: 'SMS_2' });
            const res = await logic.sms.send({ templateId: aliyunTpl.id, phone: '13800138000', variables: {} });
            expect(res.provider).toBe('aliyun');
            expect(spy).toHaveBeenCalledWith(
                expect.objectContaining({ channel: 'aliyun' }),
                expect.objectContaining({ phone: '13800138000', templateCode: 'SMS_2' }),
            );
        } finally {
            spy.mockRestore();
        }
    });

    test('sms.send without templateId is MISSING_PARAM (template-only channel)', async () => {
        await expect(M.sms.send({ phone: '13800138000' }))
            .rejects.toMatchObject({ code: -32602, message: /templateId/ });
    });
});

// ─── G14: plain-text part is text, not HTML source ────────────────────────────

describe('template rendering', () => {
    test('declared text field is interpolated and used as the text/plain part', async () => {
        const tpl = await M.email.template.create({
            name: 'welcome',
            subject: 'Hi {{name}}',
            html: '<p>Hello <b>{{name}}</b></p>',
            text: 'Hello {{name}}',
            variables: ['name'],
        });
        const sent = [];
        const logic = build();
        // Intercept at the provider boundary: the mock channel returns before any network.
        const emailProvider = require('../logic/email');
        const spy = jest.spyOn(emailProvider, 'send').mockImplementation(async (_cfg, p) => {
            sent.push(p);
            return { success: true, messageId: 'm1', provider: 'mock' };
        });
        try {
            // The factory captured the module object, so the spy applies.
            const M2 = require('../logic')(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger });
            const t2 = await M2.email.template.create({
                name: 'welcome', subject: 'Hi {{name}}', html: '<p>Hello <b>{{name}}</b></p>', text: 'Hello {{name}}',
            });
            await M2.email.send({ to: 'a@example.com', templateId: t2.id, variables: { name: 'Ada' } });
        } finally {
            spy.mockRestore();
        }

        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe('Hi Ada');
        expect(sent[0].html).toBe('<p>Hello <b>Ada</b></p>');
        expect(sent[0].content).toBe('Hello Ada');       // the text part — NOT the html source
        expect(tpl.text).toBe('Hello {{name}}');
        expect(logic).toBeTruthy();
    });

    test('no text field → a derived plain-text part (tags stripped, entities decoded)', async () => {
        const emailProvider = require('../logic/email');
        const sent = [];
        const spy = jest.spyOn(emailProvider, 'send').mockImplementation(async (_cfg, p) => {
            sent.push(p);
            return { success: true, messageId: 'm1', provider: 'mock' };
        });
        try {
            const M2 = require('../logic')(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger });
            const tpl = await M2.email.template.create({
                name: 'r', subject: 'S',
                html: '<style>b{}</style><h1>Title</h1><p>Line&nbsp;1 &amp; more</p><br/><p>Line 2</p>',
            });
            await M2.email.send({ to: 'a@example.com', templateId: tpl.id, variables: {} });
        } finally {
            spy.mockRestore();
        }

        // `</p><br/>` = end of block + explicit break → one blank line between paragraphs.
        expect(sent[0].content).toBe('Title\nLine 1 & more\n\nLine 2');
        expect(sent[0].content).not.toContain('<');
        expect(sent[0].content).not.toContain('&nbsp;');
    });
});

// ─── G16: strict variables (opt-in) ───────────────────────────────────────────

describe('strict variables', () => {
    test('default (off): a missing variable ships the literal placeholder — documented behavior', async () => {
        const emailProvider = require('../logic/email');
        const sent = [];
        const spy = jest.spyOn(emailProvider, 'send').mockImplementation(async (_cfg, p) => {
            sent.push(p); return { success: true, messageId: 'm', provider: 'mock' };
        });
        try {
            const M2 = require('../logic')(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger });
            const tpl = await M2.email.template.create({ name: 'otp', subject: 'Code {{code}}', html: '<p>{{code}}</p>', variables: ['code'] });
            await M2.email.send({ to: 'a@example.com', templateId: tpl.id, variables: {} });
        } finally {
            spy.mockRestore();
        }
        expect(sent[0].subject).toBe('Code {{code}}');
    });

    test('strictVariables:true → the send is refused instead (email)', async () => {
        const strict = build({ strictVariables: true });
        const tpl = await strict.email.template.create({ name: 'otp', subject: 'Code {{code}}', html: '<p>{{code}}</p>' });
        await expect(strict.email.send({ to: 'a@example.com', templateId: tpl.id, variables: {} }))
            .rejects.toMatchObject({ code: -32602, message: /missing variables \[code\]/ });

        await expect(strict.email.send({ to: 'a@example.com', templateId: tpl.id, variables: { code: '1234' } }))
            .resolves.toMatchObject({ provider: 'mock' });
    });

    test('strictVariables:true → declared sms variables must all be supplied', async () => {
        const strict = build({ strictVariables: true });
        const tpl = await strict.sms.template.create({
            name: 'otp', channel: 'mock', providerCode: 'SMS_1', variables: ['code', 'ttl'],
        });
        await expect(strict.sms.send({ templateId: tpl.id, phone: '13800138000', variables: { code: '1' } }))
            .rejects.toMatchObject({ code: -32602, message: /missing variables \[ttl\]/ });
        await expect(strict.sms.send({ templateId: tpl.id, phone: '13800138000', variables: { code: '1', ttl: '5' } }))
            .resolves.toMatchObject({ provider: 'mock' });
    });
});
