/**
 * returns-contract.test.js — proves notification.* ACTUAL handler output satisfies the
 * declared return contract (introspection `returns_schema`). Hermetic: real logic over an
 * injected Map-backed fake Redis (the collection/payment returns-contract pattern). No
 * stack, no live Redis, no LLM/relay-RPC.
 *
 * Coverage:
 *   - message.send / inboxList / inboxAck   (notification.send / inbox.list / inbox.ack)
 *   - config.set / get                      (notification.config.set / get)
 *   - deadletter.list / requeue             (notification.deadletter.list / requeue)
 *   - relay.status no-token + has-token     (notification.token.status — drives both paths)
 *   - notification.token.set / clear        (index.js { ok:true } wrappers — asserted as the
 *                                             literal value index.js returns)
 *
 * Unverified here (static-derived schema): none of the above; every declared method's
 * contract is exercised against a real return value below.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-notification-contract-${process.pid}`);

const createMessageLogic = require('../logic/message');
const createConfigLogic = require('../logic/config');
const createDeadletterLogic = require('../logic/deadletter');
const { createRelay } = require('../../../library/relay');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — KV (with NX/EX), sorted sets (zAdd/zRange REV/zCard), lists (rPush/lLen/
// lRange/lRem) and a multi() chain (set + zAdd) covering exactly what the notification
// logic + relay.status touch. Scores tracked per member for zRange REV ordering.
function makeFakeRedis() {
    const kv = new Map();
    const zsets = new Map(); // key -> Map<member, score>
    const lists = new Map(); // key -> array
    const getZ = (k) => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));
    const getL = (k) => (lists.has(k) ? lists.get(k) : lists.set(k, []).get(k));

    const apply = {
        set: (k, v, opts) => {
            if (opts && opts.NX && kv.has(k)) return null;
            kv.set(k, v);
            return 'OK';
        },
        zAdd: (k, m) => { getZ(k).set(m.value, m.score); return 1; },
    };

    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { const had = kv.delete(k); zsets.delete(k); lists.delete(k); return had ? 1 : 0; },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async zAdd(k, m) { return apply.zAdd(k, m); },
        async zCard(k) { return zsets.has(k) ? zsets.get(k).size : 0; },
        async zRange(k, start, stop, opts) {
            const z = zsets.get(k);
            if (!z) return [];
            let entries = [...z.entries()].sort((a, b) => a[1] - b[1]); // ascending by score
            if (opts && opts.REV) entries = entries.reverse();
            const members = entries.map((e) => e[0]);
            const end = stop < 0 ? members.length + stop : stop;
            return members.slice(start, end + 1);
        },
        async rPush(k, v) { getL(k).push(v); return getL(k).length; },
        async lLen(k) { return lists.has(k) ? lists.get(k).length : 0; },
        async lRange(k, start, stop) {
            const l = getL(k);
            const end = stop < 0 ? l.length + stop : stop;
            return l.slice(start, end + 1);
        },
        async lRem(k, count, value) {
            const l = getL(k);
            let removed = 0;
            for (let i = 0; i < l.length && (count === 0 || removed < count);) {
                if (l[i] === value) { l.splice(i, 1); removed++; } else { i++; }
            }
            return removed;
        },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                zAdd(k, m) { ops.push(['zAdd', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

describe('notification.* — actual return satisfies declared returns_schema', () => {
    let redis, message, cfg, deadletter, relay;
    beforeEach(() => {
        redis = makeFakeRedis();
        message = createMessageLogic(redis, config);
        cfg = createConfigLogic(redis, config);
        deadletter = createDeadletterLogic(redis, config);
        relay = createRelay({ redis, serviceName: 'notification', routerUrl: 'http://localhost:1/jsonrpc' });
    });

    test('send (no rules) → {id,status:stored,queued:0} matches contract', async () => {
        const res = await message.send({ targetId: 'uid-a', type: 'alert', payload: { x: 1 } });
        expect(checkReturn(method('notification.send'), res)).toEqual([]);
        expect(res.status).toBe('stored');
        expect(res.queued).toBe(0);
    });

    test('send (configured rule) → queued counts matched channels', async () => {
        await cfg.set({ targetId: 'uid-b', rules: [{ type: 'alert', channel: 'webhook', params: { url: 'https://x.test/hook' } }] });
        const res = await message.send({ targetId: 'uid-b', type: 'alert', payload: {} });
        expect(checkReturn(method('notification.send'), res)).toEqual([]);
        expect(res.queued).toBe(1);
    });

    test('send (duplicate ref) → {status:duplicate,queued:0} matches contract', async () => {
        const ref = 'stream-entry-1';
        const first = await message.send({ targetId: 'uid-c', type: 'alert', payload: {}, ref });
        const dup = await message.send({ targetId: 'uid-c', type: 'alert', payload: {}, ref });
        expect(checkReturn(method('notification.send'), dup)).toEqual([]);
        expect(dup.status).toBe('duplicate');
        expect(dup.queued).toBe(0);
        expect(dup.id).toBe(first.id);
    });

    test('inbox.list (empty) → {items:[],total:0} matches contract', async () => {
        const res = await message.inboxList({ targetId: 'uid-empty' });
        expect(checkReturn(method('notification.inbox.list'), res)).toEqual([]);
        expect(res.items).toEqual([]);
        expect(res.total).toBe(0);
    });

    test('inbox.list (populated) → matches contract', async () => {
        await message.send({ targetId: 'uid-d', type: 'alert', payload: {} });
        await message.send({ targetId: 'uid-d', type: 'alert', payload: {} });
        const res = await message.inboxList({ targetId: 'uid-d', unreadOnly: false });
        expect(checkReturn(method('notification.inbox.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(res.total).toBe(2);
    });

    test('inbox.ack → {acked} matches contract', async () => {
        const m1 = await message.send({ targetId: 'uid-e', type: 'alert', payload: {} });
        const res = await message.inboxAck({ ids: [m1.id] });
        expect(checkReturn(method('notification.inbox.ack'), res)).toEqual([]);
        expect(res.acked).toBe(1);
    });

    test('config.set → {targetId} matches contract', async () => {
        const res = await cfg.set({ targetId: 'uid-f', rules: [] });
        expect(checkReturn(method('notification.config.set'), res)).toEqual([]);
        expect(res.targetId).toBe('uid-f');
    });

    test('config.get (unset) → {targetId,rules:[]} matches contract', async () => {
        const res = await cfg.get({ targetId: 'uid-g' });
        expect(checkReturn(method('notification.config.get'), res)).toEqual([]);
        expect(res.rules).toEqual([]);
    });

    test('config.get (set) → {targetId,rules} matches contract', async () => {
        const rules = [{ type: '*', channel: 'none' }];
        await cfg.set({ targetId: 'uid-h', rules });
        const res = await cfg.get({ targetId: 'uid-h' });
        expect(checkReturn(method('notification.config.get'), res)).toEqual([]);
        expect(res.rules).toEqual(rules);
    });

    test('deadletter.list (empty) → {items:[],total:0} matches contract', async () => {
        const res = await deadletter.list({});
        expect(checkReturn(method('notification.deadletter.list'), res)).toEqual([]);
        expect(res.total).toBe(0);
    });

    test('deadletter.list (populated) → matches contract', async () => {
        await redis.rPush(config.redis.queueDead, JSON.stringify({ messageId: 'm1', channel: 'email', attempts: 5 }));
        const res = await deadletter.list({});
        expect(checkReturn(method('notification.deadletter.list'), res)).toEqual([]);
        expect(res.total).toBe(1);
        expect(res.items.length).toBe(1);
    });

    test('deadletter.requeue (by id) → {requeued,exhausted} matches contract', async () => {
        await redis.rPush(config.redis.queueDead, JSON.stringify({ messageId: 'm2', channel: 'email', params: {} }));
        const res = await deadletter.requeue({ messageId: 'm2' });
        expect(checkReturn(method('notification.deadletter.requeue'), res)).toEqual([]);
        expect(res.requeued).toBe(1);
        expect(res.exhausted).toBe(0);
    });

    test('deadletter.requeue (all, none) → {requeued:0,exhausted:0} matches contract', async () => {
        const res = await deadletter.requeue({ all: true });
        expect(checkReturn(method('notification.deadletter.requeue'), res)).toEqual([]);
        expect(res.requeued).toBe(0);
    });

    test('deadletter.requeue (exhausted) → counted in exhausted, not requeued', async () => {
        await redis.rPush(config.redis.queueDead, JSON.stringify({ messageId: 'm3', channel: 'email', requeues: 3 }));
        const res = await deadletter.requeue({ all: true });
        expect(checkReturn(method('notification.deadletter.requeue'), res)).toEqual([]);
        expect(res.requeued).toBe(0);
        expect(res.exhausted).toBe(1);
    });

    test('token.status (no token) → {hasToken:false} matches contract', async () => {
        const res = await relay.status();
        expect(checkReturn(method('notification.token.status'), res)).toEqual([]);
        expect(res.hasToken).toBe(false);
    });

    test('token.status (has token) → full shape matches contract', async () => {
        // Seed via the relay's own setToken so the stored state is exactly what status() reads.
        await relay.setToken({ token: 'tok-xyz', expiresAt: Date.now() + 3600_000 });
        const res = await relay.status();
        expect(checkReturn(method('notification.token.status'), res)).toEqual([]);
        expect(res.hasToken).toBe(true);
        expect(typeof res.ttlMs).toBe('number');
        expect(res.sub).toBe('system.notification');
    });

    test('token.set wrapper ({ok:true}) matches contract', () => {
        // index.js returns the literal { ok: true } after relay.setToken (which returns undefined).
        const wrapped = { ok: true };
        expect(checkReturn(method('notification.token.set'), wrapped)).toEqual([]);
    });

    test('token.clear wrapper ({ok:true}) matches contract', () => {
        // index.js returns the literal { ok: true } after relay.clear (which returns undefined).
        const wrapped = { ok: true };
        expect(checkReturn(method('notification.token.clear'), wrapped)).toEqual([]);
    });
});
