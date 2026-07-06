/**
 * returns-contract.test.js — proves gateway.* ACTUAL handler output satisfies the declared
 * return contract (introspection `returns_schema`). Hermetic: the real logic factory
 * (logic/index.js) + real Entity Factory over an injected Map-backed fake Redis, plus a real
 * loopback http.Server for the one outbound path that is cleanly testable (webhook.send).
 * No live Redis, no SMTP/SMS/vision provider, no Router.
 *
 * Why this matters: orchestration/AI bind to these return shapes (fulfillment meta_field
 * source.pick, agent tool-result handling). A drifting returns_schema silently mis-binds, so
 * the schema MUST match what the handler actually returns today.
 *
 * NOT covered here (return shape is static-derived — see `unverified` in the task report):
 *   - gateway.smtp.test   → needs a real SMTP server (nodemailer transporter.verify()).
 *   - gateway.rmbg.cutout → needs a local ONNX server OR a remove.bg API key.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-gateway-contract-${process.pid}`);
// Needed by logic/smtp.js encryptPass() when an SMTP account is created WITH a pass.
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';
// Loopback is the "external endpoint" for the webhook.send happy-path (same escape hatch e2e uses).
process.env.WEBHOOK_ALLOW_LOOPBACK = '1';

const http = require('http');
const createLogic = require('../logic');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — Entity-Factory (string storage) command surface, per the collection
// returns-contract test / sample item.test.js pattern. No xAdd → walFile (best-effort,
// never throws) path is used; no RedisJSON needed (gateway entities are string storage).
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

// Silent logger — logic/index.js calls logger.info on the send paths.
const logger = { info() {}, warn() {}, error() {}, debug() {}, setRedis() {} };

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];
const ok = (n, result) => expect(checkReturn(method(n), result)).toEqual([]);

describe('gateway.* — actual return satisfies declared returns_schema', () => {
    let M;
    beforeEach(() => { M = createLogic(makeFakeRedis(), { serviceName: 'gateway', config, logger }); });

    test('gateway.echo → { echo }', async () => {
        const res = await M.gateway.echo({ hello: 'world' });
        ok('gateway.echo', res);
        expect(res.echo).toEqual({ hello: 'world' });
    });

    describe('SMTP account CRUD', () => {
        test('create → get → update → list → delete all match contract', async () => {
            const created = await M.smtp.create({ name: 'acct', host: 'smtp.example.com', port: 587, secure: false, user: 'u@example.com', pass: 's3cret', from: 'noreply@example.com' });
            ok('gateway.smtp.create', created);
            expect(created.pass).toBeUndefined();          // stripPass
            expect(created.status).toBe('ACTIVE');

            const got = await M.smtp.get({ id: created.id });
            ok('gateway.smtp.get', got);
            expect(got.pass).toBeUndefined();

            const updated = await M.smtp.update({ id: created.id, name: 'acct2' });
            ok('gateway.smtp.update', updated);
            expect(updated.name).toBe('acct2');

            const list = await M.smtp.list({});
            ok('gateway.smtp.list', list);
            expect(Array.isArray(list.items)).toBe(true);
            expect(typeof list.total).toBe('number');

            const del = await M.smtp.delete({ id: created.id });
            ok('gateway.smtp.delete', del);
            expect(del.success).toBe(true);
        });
    });

    describe('Email template CRUD', () => {
        test('create → get → update → list → delete all match contract', async () => {
            const created = await M.email.template.create({ name: 'welcome', subject: 'Hi {{name}}', html: '<p>{{name}}</p>', variables: ['name'] });
            ok('gateway.email.template.create', created);

            ok('gateway.email.template.get', await M.email.template.get({ id: created.id }));
            ok('gateway.email.template.update', await M.email.template.update({ id: created.id, subject: 'Hello {{name}}' }));

            const list = await M.email.template.list({});
            ok('gateway.email.template.list', list);

            ok('gateway.email.template.delete', await M.email.template.delete({ id: created.id }));
        });
    });

    describe('SMS template CRUD', () => {
        test('create → get → update → list → delete all match contract', async () => {
            const created = await M.sms.template.create({ name: 'verify', channel: 'mock', providerCode: 'SMS_123', variables: ['code'] });
            ok('gateway.sms.template.create', created);

            ok('gateway.sms.template.get', await M.sms.template.get({ id: created.id }));
            ok('gateway.sms.template.update', await M.sms.template.update({ id: created.id, providerCode: 'SMS_456' }));

            const list = await M.sms.template.list({});
            ok('gateway.sms.template.list', list);

            ok('gateway.sms.template.delete', await M.sms.template.delete({ id: created.id }));
        });
    });

    describe('Send paths (mock provider — no outbound network)', () => {
        test('email.send (direct, mock channel) → { success, messageId, provider }', async () => {
            // config.email.channel='auto' with no api.key/smtp.host configured resolves to 'mock'.
            const res = await M.email.send({ to: 'a@example.com', subject: 'Hi', content: 'body' });
            ok('gateway.email.send', res);
            expect(res.success).toBe(true);
            expect(res.provider).toBe('mock');
            expect(typeof res.messageId).toBe('string');
        });

        test('email.send (via template) → { success, messageId, provider }', async () => {
            const tpl = await M.email.template.create({ name: 't', subject: 'S {{x}}', html: '<b>{{x}}</b>' });
            const res = await M.email.send({ to: 'a@example.com', templateId: tpl.id, variables: { x: '1' } });
            ok('gateway.email.send', res);
            expect(res.provider).toBe('mock');
        });

        test('sms.send (template channel=mock) → { success, messageId, provider }', async () => {
            const tpl = await M.sms.template.create({ name: 'v', channel: 'mock', providerCode: 'SMS_1' });
            const res = await M.sms.send({ templateId: tpl.id, phone: '+10000000000', variables: { code: '42' } });
            ok('gateway.sms.send', res);
            expect(res.success).toBe(true);
            expect(res.provider).toBe('mock');
            expect(typeof res.messageId).toBe('string');
        });
    });

    describe('webhook.send (real loopback http endpoint)', () => {
        let server;
        let port;
        beforeAll((done) => {
            server = http.createServer((req, res) => {
                req.on('data', () => {});
                req.on('end', () => { res.statusCode = 200; res.end('{"ok":true}'); });
            });
            server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
        });
        afterAll((done) => { server.close(done); });

        test('send → { success, status, provider, messageId }', async () => {
            const res = await M.webhook.send({ url: `http://127.0.0.1:${port}/cb`, payload: { a: 1 }, type: 'alert' });
            ok('gateway.webhook.send', res);
            expect(res.success).toBe(true);
            expect(res.status).toBe(200);
            expect(res.provider).toBe('webhook');
            expect(typeof res.messageId).toBe('string');
        });
    });
});
