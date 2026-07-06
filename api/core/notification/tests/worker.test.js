const config = require('../config');
const createWorker = require('../logic/worker');
const createDeadletter = require('../logic/deadletter');

const R = config.redis;
const W = config.worker;

// Minimal in-memory redis fake covering only the commands these modules use.
function makeFakeRedis() {
    const kv = new Map();
    const lists = new Map();
    const zsets = new Map();
    const getList = k => (lists.has(k) ? lists.get(k) : lists.set(k, []).get(k));
    const getZ = k => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));

    return {
        _lists: lists,
        _zsets: zsets,
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v) { kv.set(k, v); return 'OK'; },
        async rPush(k, v) { return getList(k).push(v); },
        async lLen(k) { return getList(k).length; },
        async lTrim(k, start, end) {
            const arr = getList(k);
            const s = start < 0 ? Math.max(0, arr.length + start) : start;
            const e = end < 0 ? arr.length + end : end;
            lists.set(k, arr.slice(s, e + 1));
            return 'OK';
        },
        async lRange(k, start, end) {
            const arr = getList(k);
            const e = end < 0 ? arr.length + end : end;
            return arr.slice(start, e + 1);
        },
        async lRem(k, count, value) {
            const arr = getList(k);
            let removed = 0;
            for (let i = 0; i < arr.length && (count === 0 || removed < count);) {
                if (arr[i] === value) { arr.splice(i, 1); removed++; } else i++;
            }
            return removed;
        },
        async zAdd(k, { score, value }) { getZ(k).set(value, score); return 1; },
        async zRangeByScore(k, min, max) {
            return [...getZ(k).entries()]
                .filter(([, s]) => s >= min && s <= max)
                .sort((a, b) => a[1] - b[1])
                .map(([m]) => m);
        },
        async zRem(k, member) { return getZ(k).delete(member) ? 1 : 0; },
    };
}

const storeMsg = async (redis, id) =>
    redis.set(R.msgPrefix + id, JSON.stringify({
        id, targetId: 't1', type: 'alert',
        payload: { subject: 'S-alert', content: 'C-body' },
    }));

describe('notification delivery reliability', () => {
    let redis;
    beforeEach(() => { redis = makeFakeRedis(); });

    test('transient failure schedules a retry, not a dead-letter', async () => {
        await storeMsg(redis, 'm1');
        const relay = { call: jest.fn().mockRejectedValue(new Error('boom')) };
        const worker = createWorker(redis, config, { relay });

        // explicit `to` skips address resolution → the gateway call is the failure
        await worker.processOne({ messageId: 'm1', channel: 'email', params: { to: 'a@b.c' }, attempts: 0 });

        expect(redis._zsets.get(R.queueRetry)?.size).toBe(1);
        expect(redis._lists.get(R.queueDead)?.length || 0).toBe(0);
    });

    test('missing relay retries rather than dropping the message', async () => {
        await storeMsg(redis, 'm-nr');
        const worker = createWorker(redis, config, {}); // no relay injected

        await worker.processOne({ messageId: 'm-nr', channel: 'email', params: {}, attempts: 0 });

        expect(redis._zsets.get(R.queueRetry)?.size).toBe(1);
    });

    test('exhausting retries moves the task to the dead-letter queue', async () => {
        await storeMsg(redis, 'm2');
        const relay = { call: jest.fn().mockRejectedValue(new Error('boom')) };
        const worker = createWorker(redis, config, { relay });

        await worker.processOne({ messageId: 'm2', channel: 'email', params: { to: 'a@b.c' }, attempts: W.maxRetries - 1 });

        const dead = redis._lists.get(R.queueDead);
        expect(dead?.length).toBe(1);
        expect(JSON.parse(dead[0]).messageId).toBe('m2');
        expect(redis._zsets.get(R.queueRetry)?.size || 0).toBe(0);
    });

    test('PERMANENT error (e.g. METHOD_NOT_FOUND) dead-letters immediately — no retry burn', async () => {
        await storeMsg(redis, 'm-perm');
        const err = new Error('Method not found');
        err.rpcCode = -32601;
        const relay = { call: jest.fn().mockRejectedValue(err) };
        const worker = createWorker(redis, config, { relay });

        await worker.processOne({ messageId: 'm-perm', channel: 'email', params: { to: 'a@b.c' }, attempts: 0 });

        const dead = redis._lists.get(R.queueDead);
        expect(dead?.length).toBe(1);
        const entry = JSON.parse(dead[0]);
        expect(entry.permanent).toBe(true);
        expect(redis._zsets.get(R.queueRetry)?.size || 0).toBe(0);
    });

    test('address resolution: user profile email becomes the default `to`, payload becomes content', async () => {
        await storeMsg(redis, 'm-addr');
        const relay = {
            call: jest.fn(async (method) => {
                if (method === 'user.profile') return { id: 't1', email: 'fuu@example.com' };
                return { success: true, messageId: 'g1', provider: 'smtp' };
            }),
        };
        const worker = createWorker(redis, config, { relay });

        await worker.processOne({ messageId: 'm-addr', channel: 'email', params: {}, attempts: 0 });

        const gatewayCall = relay.call.mock.calls.find(([m]) => m === 'gateway.email.send');
        expect(gatewayCall).toBeDefined();
        expect(gatewayCall[1].to).toBe('fuu@example.com');
        expect(gatewayCall[1].subject).toBe('S-alert');     // msg.payload no longer dropped
        expect(gatewayCall[1].content).toBe('C-body');
        expect(redis._zsets.get(R.queueRetry)?.size || 0).toBe(0);
        expect(redis._lists.get(R.queueDead)?.length || 0).toBe(0);
    });

    test('no address anywhere → degrade to inbox (ack, no gateway call, no failure)', async () => {
        await storeMsg(redis, 'm-deg');
        const relay = {
            call: jest.fn(async (method) => {
                if (method === 'user.profile') return { id: 't1' };   // no email on profile
                throw new Error('gateway should not be called');
            }),
        };
        const worker = createWorker(redis, config, { relay });

        await worker.processOne({ messageId: 'm-deg', channel: 'email', params: {}, attempts: 0 });

        expect(relay.call.mock.calls.every(([m]) => m === 'user.profile')).toBe(true);
        expect(redis._zsets.get(R.queueRetry)?.size || 0).toBe(0);
        expect(redis._lists.get(R.queueDead)?.length || 0).toBe(0);
    });

    test('gateway mock fallback is acked but never recorded as a real delivery', async () => {
        await storeMsg(redis, 'm-mock');
        const relay = { call: jest.fn(async () => ({ success: true, messageId: 'g2', provider: 'mock' })) };
        const worker = createWorker(redis, config, { relay });

        // deliver() resolves ok+mocked — assert via the public surface: no retry, no DLQ.
        await worker.processOne({ messageId: 'm-mock', channel: 'email', params: { to: 'a@b.c' }, attempts: 0 });

        expect(redis._zsets.get(R.queueRetry)?.size || 0).toBe(0);
        expect(redis._lists.get(R.queueDead)?.length || 0).toBe(0);
    });

    test('a vanished message is dropped, not retried', async () => {
        const relay = { call: jest.fn() };
        const worker = createWorker(redis, config, { relay });

        await worker.processOne({ messageId: 'gone', channel: 'email', params: {}, attempts: 0 });

        expect(relay.call).not.toHaveBeenCalled();
        expect(redis._zsets.get(R.queueRetry)?.size || 0).toBe(0);
        expect(redis._lists.get(R.queueDead)?.length || 0).toBe(0);
    });

    test('promoteDueRetries moves elapsed tasks back to pending', async () => {
        const due = JSON.stringify({ messageId: 'm3', channel: 'email', params: {}, attempts: 1 });
        const future = JSON.stringify({ messageId: 'm4', channel: 'email', params: {}, attempts: 1 });
        await redis.zAdd(R.queueRetry, { score: Date.now() - 1000, value: due });
        await redis.zAdd(R.queueRetry, { score: Date.now() + 60000, value: future });

        const worker = createWorker(redis, config, { relay: {} });
        await worker.promoteDueRetries(redis);

        expect(redis._lists.get(R.queuePending)?.length).toBe(1);
        expect(JSON.parse(redis._lists.get(R.queuePending)[0]).messageId).toBe('m3');
        expect(redis._zsets.get(R.queueRetry)?.size).toBe(1); // future task untouched
    });
});

describe('notification.deadletter', () => {
    let redis;
    beforeEach(() => { redis = makeFakeRedis(); });

    test('list returns parsed items and total', async () => {
        await redis.rPush(R.queueDead, JSON.stringify({ messageId: 'd1', channel: 'sms', attempts: 5 }));
        const dl = createDeadletter(redis, config);

        const { items, total } = await dl.list({});

        expect(total).toBe(1);
        expect(items[0].messageId).toBe('d1');
    });

    test('requeue moves a dead task back to pending with reset attempts + requeue counter', async () => {
        await redis.rPush(R.queueDead, JSON.stringify({ messageId: 'd2', channel: 'sms', params: { x: 1 }, attempts: 5, failedAt: 1 }));
        const dl = createDeadletter(redis, config);

        const res = await dl.requeue({ messageId: 'd2' });

        expect(res.requeued).toBe(1);
        expect(redis._lists.get(R.queueDead)?.length || 0).toBe(0);
        const pending = redis._lists.get(R.queuePending);
        expect(pending.length).toBe(1);
        expect(JSON.parse(pending[0])).toEqual({ messageId: 'd2', channel: 'sms', params: { x: 1 }, attempts: 0, requeues: 1 });
    });

    test('loop guard: a task re-burned MAX times stays in the DLQ (poison containment)', async () => {
        await redis.rPush(R.queueDead, JSON.stringify({ messageId: 'd3', channel: 'sms', params: {}, attempts: 5, requeues: 3 }));
        const dl = createDeadletter(redis, config);

        const res = await dl.requeue({ all: true });

        expect(res.requeued).toBe(0);
        expect(res.exhausted).toBe(1);
        expect(redis._lists.get(R.queueDead)?.length).toBe(1);   // still parked for a human
        expect(redis._lists.get(R.queuePending)?.length || 0).toBe(0);
    });

    test('requeue without messageId or all throws', async () => {
        const dl = createDeadletter(redis, config);
        await expect(dl.requeue({})).rejects.toBeDefined();
    });
});

describe('DLQ depth alert scanner (toFix §6.5 minimal alerting)', () => {
    let redis;
    beforeEach(() => {
        redis = makeFakeRedis();
        // scanner also reads stream depth (nexus DLQ) — extend the fake
        redis.xLen = async () => 0;
    });

    const sentAlerts = () => [];

    function makeMessageSpy() {
        const sent = [];
        return {
            sent,
            async send(p) { sent.push(p); return { id: 'm1', status: 'sent' }; },
        };
    }

    test('own deadletter over threshold → ops inbox alert with queue + depth', async () => {
        const message = makeMessageSpy();
        const worker = createWorker(redis, config, { relay: null, message });
        for (let i = 0; i < W.dlqAlertThreshold; i++) await redis.rPush(R.queueDead, `dead-${i}`);

        const alerted = await worker.scanDlqDepths(Date.now());

        expect(alerted).toEqual([{ queue: 'notification_deadletter', depth: W.dlqAlertThreshold }]);
        expect(message.sent).toHaveLength(1);
        expect(message.sent[0]).toMatchObject({
            targetId: W.opsInbox,
            type: 'ops.dlq_depth',
            ref: 'dlq_depth:notification_deadletter',
        });
        expect(message.sent[0].payload.depth).toBe(W.dlqAlertThreshold);
    });

    test('below threshold → silent; scan throttled within the interval', async () => {
        const message = makeMessageSpy();
        const worker = createWorker(redis, config, { relay: null, message });
        await redis.rPush(R.queueDead, 'one-dead-entry');

        const now = Date.now();
        expect(await worker.scanDlqDepths(now)).toEqual([]);
        expect(message.sent).toHaveLength(0);

        // immediate re-sweep is a no-op even if depth spikes (interval gate)
        for (let i = 0; i < W.dlqAlertThreshold + 5; i++) await redis.rPush(R.queueDead, `d${i}`);
        expect(await worker.scanDlqDepths(now + 1000)).toEqual([]);
    });

    test('cross-service stream DLQ (nexus) watched via xLen', async () => {
        const message = makeMessageSpy();
        redis.xLen = async (key) => (key === 'NEXUS:DLQ' ? W.dlqAlertThreshold + 3 : 0);
        const worker = createWorker(redis, config, { relay: null, message });

        const alerted = await worker.scanDlqDepths(Date.now());
        expect(alerted).toEqual([{ queue: 'nexus_dlq', depth: W.dlqAlertThreshold + 3 }]);
    });

    test('duplicate alert inside the dedup window is not re-counted', async () => {
        const message = {
            async send() { return { id: 'm1', status: 'duplicate' }; },
        };
        const worker = createWorker(redis, config, { relay: null, message });
        for (let i = 0; i < W.dlqAlertThreshold; i++) await redis.rPush(R.queueDead, `dead-${i}`);

        expect(await worker.scanDlqDepths(Date.now())).toEqual([]);
    });

    test('no message logic injected → scanner disabled (worker still constructs)', async () => {
        const worker = createWorker(redis, config, { relay: null });
        expect(await worker.scanDlqDepths(Date.now())).toEqual([]);
    });
});
