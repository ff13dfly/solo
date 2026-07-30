/**
 * delivery.test.js — the outbound ledger, the idempotency key, and the delivery events
 * (gateway-gaps G5 / G7 / G8). All three hang off one moment: "a send just resolved".
 *
 * What used to be true and is asserted here as fixed:
 *   G5 — the only record of an outbound send was an md5-addressed local WAL file: nothing
 *        queryable, nothing per-attempt. Now every attempt is a `delivery` entity row.
 *   G7 — no de-dup at all: the notification worker retries 5×, so a provider that accepted
 *        then timed out received the same message again. Now an idempotencyKey replays the
 *        first result instead of re-sending.
 *   G8 — `events.js` emits was empty, so no Sentinel could react to "nothing actually left
 *        the system". Now sends carry `_event` for the Router to publish.
 *
 * Hermetic: fake Redis, mock channels, no network.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-gateway-delivery-${process.pid}`);
process.env.GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY || 'test-gateway-secret';
process.env.WEBHOOK_ALLOW_LOOPBACK = '1';
process.env.CLOCK_TEST_MODE = 'true';

const http = require('http');
const createLogic = require('../logic');
const baseConfig = require('../config');
const introspection = require('../handlers/introspection');
const entities = require('../handlers/entities');
const events = require('../handlers/events');
const { checkReturn } = require('../../../library/contract');
const { IDEM_PREFIX } = require('../logic/delivery');
const { makeFakeRedis, silentLogger } = require('./helpers/fake-redis');

const config = {
    ...baseConfig,
    email: { ...baseConfig.email, channel: 'mock' },
    sms: { ...baseConfig.sms, channel: 'mock' },
};

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const contractOk = (n, result) => expect(checkReturn(byName[n], result)).toEqual([]);

let redis;
let M;
beforeEach(() => {
    redis = makeFakeRedis();
    M = createLogic(redis, { serviceName: 'gateway', config, logger: silentLogger });
});

// ─── G5: the ledger ───────────────────────────────────────────────────────────

describe('delivery ledger', () => {
    test('a mock email send is recorded as MOCKED and is queryable', async () => {
        const res = await M.email.send({ to: 'ada@example.com', subject: 'Hi', content: 'body' });
        expect(res.provider).toBe('mock');
        expect(typeof res.deliveryId).toBe('string');

        const row = await M.delivery.get({ id: res.deliveryId });
        expect(row).toMatchObject({
            channel: 'email',
            target: 'ada@example.com',
            provider: 'mock',
            deliveryStatus: 'MOCKED',       // NOT 'SENT' — nothing left the system
            subject: 'Hi',
            providerMessageId: res.messageId,
            status: 'ACTIVE',               // entity lifecycle, distinct from deliveryStatus
        });
        contractOk('gateway.delivery.get', row);

        const listed = await M.delivery.list({});
        expect(listed.total).toBe(1);
        expect(listed.items[0].id).toBe(res.deliveryId);
        contractOk('gateway.delivery.list', listed);
    });

    test('an SMS send records channel/phone/templateId', async () => {
        const tpl = await M.sms.template.create({ name: 'otp', channel: 'mock', providerCode: 'SMS_1' });
        const res = await M.sms.send({ templateId: tpl.id, phone: '13800138000', variables: { code: '1' } });

        const row = await M.delivery.get({ id: res.deliveryId });
        expect(row).toMatchObject({ channel: 'sms', target: '13800138000', templateId: tpl.id, deliveryStatus: 'MOCKED' });
    });

    test('a real (non-mock) provider is recorded as SENT — webhook against a local listener', async () => {
        const server = http.createServer((req, res) => { res.statusCode = 200; res.end('{}'); });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
            const url = `http://127.0.0.1:${server.address().port}/cb`;
            const res = await M.webhook.send({ url, payload: { a: 1 } });
            const row = await M.delivery.get({ id: res.deliveryId });
            expect(row).toMatchObject({ channel: 'webhook', target: url, provider: 'webhook', deliveryStatus: 'SENT' });
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    test('a FAILED attempt is recorded with the reason, and the error still propagates', async () => {
        // Loopback is allowed here, but an unroutable port fails at connect time.
        const url = 'http://127.0.0.1:1/cb';
        await expect(M.webhook.send({ url, payload: {} })).rejects.toThrow();

        const listed = await M.delivery.list({});
        expect(listed.total).toBe(1);
        expect(listed.items[0]).toMatchObject({ channel: 'webhook', target: url, deliveryStatus: 'FAILED', provider: null });
        expect(typeof listed.items[0].error).toBe('string');
        expect(listed.items[0].error.length).toBeGreaterThan(0);
    });

    test('a ledger write failure never fails a delivery the provider accepted', async () => {
        const flaky = makeFakeRedis();
        const realMulti = flaky.multi.bind(flaky);
        let sends = 0;
        flaky.multi = () => {
            // Break only the ledger row's MULTI/EXEC (the first entity write of this test).
            if (sends++ === 0) return { set: () => { throw new Error('redis down'); } };
            return realMulti();
        };
        const logic = createLogic(flaky, { serviceName: 'gateway', config, logger: silentLogger });

        const res = await logic.email.send({ to: 'ada@example.com', subject: 'S', content: 'c' });
        expect(res.success).toBe(true);          // delivery still succeeded
        expect(res.deliveryId).toBeUndefined();  // …the audit row is simply absent
        contractOk('gateway.email.send', res);
    });
});

// ─── G7: idempotency ──────────────────────────────────────────────────────────

describe('idempotency key', () => {
    test('the same key replays the first result instead of sending again', async () => {
        const emailProvider = require('../logic/email');
        const spy = jest.spyOn(emailProvider, 'send');
        try {
            const logic = createLogic(makeFakeRedis(), { serviceName: 'gateway', config, logger: silentLogger });
            const a = await logic.email.send({ to: 'ada@example.com', subject: 'S', content: 'c', idempotencyKey: 'msg-1' });
            const b = await logic.email.send({ to: 'ada@example.com', subject: 'S', content: 'c', idempotencyKey: 'msg-1' });

            expect(spy).toHaveBeenCalledTimes(1);             // provider hit exactly once
            expect(b.messageId).toBe(a.messageId);            // same provider message id
            expect(b.deduplicated).toBe(true);
            expect(a.deduplicated).toBeUndefined();
            contractOk('gateway.email.send', b);

            const listed = await logic.delivery.list({});
            expect(listed.total).toBe(1);                     // and only ONE ledger row
        } finally {
            spy.mockRestore();
        }
    });

    test('different keys are independent', async () => {
        const a = await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c', idempotencyKey: 'k1' });
        const b = await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c', idempotencyKey: 'k2' });
        expect(b.messageId).not.toBe(a.messageId);
        expect((await M.delivery.list({})).total).toBe(2);
    });

    test('no key → no de-dup (unchanged behavior for existing callers)', async () => {
        const a = await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c' });
        const b = await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c' });
        expect(b.messageId).not.toBe(a.messageId);
        expect(b.deduplicated).toBeUndefined();
    });

    test('a failed send RELEASES the key, so a retry is allowed to really re-send', async () => {
        const url = 'http://127.0.0.1:1/cb';
        await expect(M.webhook.send({ url, payload: {}, idempotencyKey: 'wh-1' })).rejects.toThrow();
        expect(await redis.get(IDEM_PREFIX + 'wh-1')).toBeNull();

        // Second attempt is a real attempt (fails again for the same reason, not a replay).
        await expect(M.webhook.send({ url, payload: {}, idempotencyKey: 'wh-1' })).rejects.toThrow();
        expect((await M.delivery.list({})).total).toBe(2);
    });

    test('a concurrent duplicate (still IN_FLIGHT) is refused as retryable, never double-sent', async () => {
        // Pre-claim the key to simulate a sibling attempt mid-flight.
        await redis.set(IDEM_PREFIX + 'inflight-1', JSON.stringify({ state: 'IN_FLIGHT', at: 1 }), { NX: true, EX: 60 });

        const emailProvider = require('../logic/email');
        const spy = jest.spyOn(emailProvider, 'send');
        try {
            const logic = createLogic(redis, { serviceName: 'gateway', config, logger: silentLogger });
            const err = await logic.email.send({
                to: 'a@example.com', subject: 'S', content: 'c', idempotencyKey: 'inflight-1',
            }).catch((e) => e);

            expect(err.message).toMatch(/already in flight/);
            expect(err.retryable).toBe(true);
            expect(err.httpStatus).toBeUndefined();   // temporary → worker retries, no DLQ
            expect(spy).not.toHaveBeenCalled();       // and nothing was sent
        } finally {
            spy.mockRestore();
        }
    });
});

// ─── G8: delivery events ──────────────────────────────────────────────────────

describe('delivery events (_event piggyback)', () => {
    // The Router's contract, asserted verbatim: router/handlers/events.js:143 destructures
    // { stream, type, payload } and SKIPS any item missing `stream` (a v1 of this code
    // shipped `{type: 'EVENT:GATEWAY:…'}` — well-formed to the eye, silently dropped on
    // the wire). Every event this service emits must satisfy this.
    const assertRouterWireShape = (event) => {
        expect(typeof event.stream).toBe('string');
        expect(event.stream.length).toBeGreaterThan(0);
        expect(typeof event.type).toBe('string');
        expect(event.type.length).toBeGreaterThan(0);
        expect(typeof event.payload).toBe('object');
        // The stream is the Redis stream name; the type is a dotted logical name (fleet
        // convention — see core/{ingress,orchestrator}/handlers/events.js).
        expect(event.stream).toMatch(/^EVENT:[A-Z0-9:_*]+$/);
        expect(event.type).toMatch(/^[a-z0-9]+(\.[a-z0-9_]+)+$/);
    };

    test('a mock send carries gateway.delivery.mocked — "nothing actually left the system"', async () => {
        const res = await M.email.send({ to: 'ada@example.com', subject: 'S', content: 'c' });
        expect(res._event).toHaveLength(1);
        assertRouterWireShape(res._event[0]);
        expect(res._event[0].stream).toBe('EVENT:GATEWAY:DELIVERY');
        expect(res._event[0].type).toBe('gateway.delivery.mocked');
        expect(res._event[0].payload).toMatchObject({
            channel: 'email',
            target: 'ada@example.com',
            provider: 'mock',
            status: 'MOCKED',
            deliveryId: res.deliveryId,
        });
    });

    test('a real provider carries gateway.delivery.sent', async () => {
        const server = http.createServer((req, res) => { res.statusCode = 200; res.end('{}'); });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
            const res = await M.webhook.send({ url: `http://127.0.0.1:${server.address().port}/cb`, payload: {} });
            assertRouterWireShape(res._event[0]);
            expect(res._event[0].type).toBe('gateway.delivery.sent');
            expect(res._event[0].payload).toMatchObject({ channel: 'webhook', provider: 'webhook', status: 'SENT' });
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    test('an idempotent replay does NOT re-emit (the first send already published it)', async () => {
        await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c', idempotencyKey: 'k' });
        const replay = await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c', idempotencyKey: 'k' });
        expect(replay._event).toBeUndefined();
        expect(replay.deduplicated).toBe(true);
    });

    test('what is emitted matches what handlers/events.js declares (stream + type + payload keys)', async () => {
        // Router builds its registry view from this declaration, so a drift here means the
        // event is either blocked (undeclared triple) or advertised but never sent.
        const declared = events.emits.map((e) => `${e.stream}|${e.type}`);
        expect(new Set(declared)).toEqual(new Set([
            'EVENT:GATEWAY:DELIVERY|gateway.delivery.sent',
            'EVENT:GATEWAY:DELIVERY|gateway.delivery.mocked',
        ]));
        for (const e of events.emits) assertRouterWireShape({ ...e, payload: e.payload || {} });

        const res = await M.email.send({ to: 'a@example.com', subject: 'S', content: 'c' });
        const emitted = res._event[0];
        expect(declared).toContain(`${emitted.stream}|${emitted.type}`);

        // Declared payload keys must actually be present on the wire.
        const spec = events.emits.find((e) => e.type === emitted.type);
        for (const key of Object.keys(spec.payload)) {
            expect(Object.keys(emitted.payload)).toContain(key);
        }
    });
});

// ─── declaration hygiene ──────────────────────────────────────────────────────

describe('declarations', () => {
    test('the delivery entity is declared and separates deliveryStatus from entity status', () => {
        expect(entities.delivery).toBeDefined();
        expect(entities.delivery.fields.deliveryStatus.options).toEqual(['SENT', 'MOCKED', 'FAILED']);
        expect(entities.delivery.fields.status.options).toEqual(['ACTIVE', 'DELETED']);
    });

    test('send methods declare idempotencyKey, and the ledger methods exist', () => {
        for (const m of ['gateway.email.send', 'gateway.sms.send', 'gateway.webhook.send']) {
            expect(byName[m].params).toContain('idempotencyKey');
        }
        expect(byName['gateway.delivery.get']).toBeDefined();
        expect(byName['gateway.delivery.list']).toBeDefined();
    });
});
