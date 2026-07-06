/**
 * 66 · nexus dynamic subscription streams (§2.1).
 *
 * Before: nexus consumed a HARDCODED 2-stream set (EVENT:WORKFLOW:STATUS/RESULT),
 * so an agent subscribing to any other stream was a silent no-op (suite 65 had to
 * subscribe to a DEFAULT stream to be reachable).
 *
 * This proves the fix: an agent subscribing to a CUSTOM (non-default) stream gets
 * the event delivered to its inbox — nexus discovers the stream from the agent
 * registry and consumes it without a restart. The agent itself is a plain polling
 * receiver (no context/autorun); we only assert the event REACHES it ("模拟打到").
 *
 * Full-profile gated (nexus consumer runs only in full; needs system.nexus relay +
 * notification.send permit, both configured by the full harness).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P = process.pid;
// A CUSTOM stream that is NOT in config.consumer.streams — the whole point.
const STREAM = `EVENT:E2ELOOP:${P}`;
const MARKER = `dyn-${P}`;

gate('66 · nexus dynamic streams (arbitrary event → subscribed agent)', () => {
    let redis;
    let agentId;

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        if (agentId) {
            await redis.del(`NEXUS:SENTINEL:${agentId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', agentId);
            await redis.sRem(`NEXUS:SUB:${STREAM}`, agentId);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${agentId}`);
            const ids = await redis.zRange(`NOTIFICATION:INBOX:${agentId}`, 0, -1);
            for (const id of ids) await redis.del(`NOTIFICATION:MSG:${id}`);
            await redis.del(`NOTIFICATION:INBOX:${agentId}`);
        }
        try { await redis.del(STREAM); } catch (_) {}  // drops the stream + its consumer group
        await redis.quit();
    });

    test('agent subscribed to a custom stream is reached by an event injected on it', async () => {
        // plain polling agent — no context/autorun; we only verify delivery
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-dyn-${P}`,
            authorityRole: 'test:dyn',
            eventSubscriptions: [STREAM],
            reachability: 'polling',
        }, ADMIN_TOKEN), 'agent.create');
        agentId = a.id;

        // subscription recorded …
        expect(await redis.sIsMember(`NEXUS:SUB:${STREAM}`, agentId)).toBeTruthy();
        // … and the consumer group on the custom stream was established at subscribe time
        // (MKSTREAM created the stream even before any event).
        expect(await redis.exists(STREAM)).toBe(1);

        await sleep(800); // let the consumer's discover tick pick up the new stream

        // inject a business-style event on the CUSTOM stream
        await redis.xAdd(STREAM, '*', { marker: MARKER, kind: 'e2e', n: '1' });

        // poll the agent inbox — delivery proves nexus dynamically consumed this stream
        // (consumer BLOCK is 5s + discover, so allow ~25s)
        let msg = null;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const r = await rpc('notification.inbox.list', { targetId: agentId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            msg = items.find((m) => m.payload && m.payload.marker === MARKER);
            if (msg) break;
        }

        expect(msg).toBeTruthy();
        expect(msg.type).toBe(STREAM);
        expect(msg.payload.kind).toBe('e2e');
    }, 60_000);
});
