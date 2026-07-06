/**
 * Event Matcher Consumer (event.md §6.1, §13 step ④).
 *
 * Reads from EVENT:* Redis Streams via an xReadGroup consumer loop. For each
 * incoming event it finds ACTIVE workflows whose `event_subscriptions` match
 * the stream + filter, then translates the event into a run-command and calls
 * worker.enqueue() — the same path async triggers always converge on.
 *
 * Design notes:
 * - Separate consumer group ('orchestrator') from nexus ('nexus-agent-delivery').
 *   Both read the same streams independently; each xAck only to its own group.
 * - Streams are discovered dynamically from ACTIVE workflow event_subscriptions
 *   (re-scanned each consumeOnce so new workflows are picked up without restart).
 * - trigger_source = 'event:{stream}'; trigger_id = stream entry ID (idempotency).
 * - payload field of the standard event envelope becomes $input to the workflow;
 *   if absent, the full event fields object is used as input (event.md §4.3).
 * - Filter is a plain object: all specified fields must exactly match the event.
 * - On match failure or enqueue error: skip xAck → re-delivered after crash/restart.
 */
const { createLogger } = require('../../../library/logger');

module.exports = (redis, { config, worker, control = null }) => {
    const logger = createLogger('orchestrator-matcher');
    const C = config.consumer;
    const R = config.redis;

    let stopRequested = false;
    // Streams we have already created consumer groups for (avoids redundant xGroupCreate).
    const knownStreams = new Set(C.extraStreams || []);

    // ── Filter ────────────────────────────────────────────────────────────────

    // Returns true if the event satisfies all fields in filter (or filter is absent).
    // Simple top-level equality: { type: 'order.paid' } means event.type === 'order.paid'.
    function matchesFilter(event, filter) {
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return true;
        for (const [k, v] of Object.entries(filter)) {
            if (event[k] !== v) return false;
        }
        return true;
    }

    // ── Stream discovery ───────────────────────────────────────────────────────

    // Scan all ACTIVE workflows and collect the union of their event_subscription streams.
    async function discoverStreams() {
        const ids = await redis.sMembers(R.workflowIndex);
        const keys = ids.map(id => `${R.workflowPrefix}${id}`);
        const streams = new Set(C.extraStreams || []);
        for (const key of keys) {
            const wf = await redis.json.get(key);
            if (!wf || wf.status !== 'ACTIVE') continue;
            for (const sub of (wf.event_subscriptions || [])) {
                if (sub && typeof sub.stream === 'string') streams.add(sub.stream);
            }
        }
        return [...streams];
    }

    // ── Workflow matching ──────────────────────────────────────────────────────

    // Find all ACTIVE workflows that subscribe to `stream` and whose filter matches `event`.
    async function findMatchingWorkflows(stream, event) {
        const ids = await redis.sMembers(R.workflowIndex);
        const keys = ids.map(id => `${R.workflowPrefix}${id}`);
        const matches = [];
        for (const key of keys) {
            const wf = await redis.json.get(key);
            if (!wf || wf.status !== 'ACTIVE') continue;
            for (const sub of (wf.event_subscriptions || [])) {
                if (sub.stream !== stream) continue;
                if (!matchesFilter(event, sub.filter)) continue;
                matches.push(wf);
                break; // one subscription match per workflow is enough to trigger it
            }
        }
        return matches;
    }

    // ── Consumer group setup ───────────────────────────────────────────────────

    async function ensureGroups(client, streams) {
        for (const stream of streams) {
            try {
                // MKSTREAM: create the stream key if it doesn't exist yet.
                // '$': start consuming from now (don't replay old events on startup).
                await client.xGroupCreate(stream, C.consumerGroup, '$', { MKSTREAM: true });
                logger.info('matcher.group.created', { stream, group: C.consumerGroup });
            } catch (err) {
                if (!String(err).includes('BUSYGROUP')) {
                    logger.warn('matcher.group.create_failed', { stream, reason: err.message });
                }
            }
        }
    }

    // ── Event parsing ──────────────────────────────────────────────────────────

    // Redis stream entries are flat string maps; parse JSON-looking string values.
    function parseEntry(message) {
        const out = { ...message };
        for (const k of Object.keys(out)) {
            const v = out[k];
            if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
                try { out[k] = JSON.parse(v); } catch (_) { /* keep string */ }
            }
        }
        return out;
    }

    // ── Core consume cycle ─────────────────────────────────────────────────────

    // One read + process iteration. Exposed for testing (pass a mock client).
    async function consumeOnce(client) {
        // Re-discover streams so new event_subscriptions are picked up without restart.
        const currentStreams = await discoverStreams();
        const newStreams = currentStreams.filter(s => !knownStreams.has(s));
        if (newStreams.length > 0) {
            await ensureGroups(client, newStreams);
            newStreams.forEach(s => knownStreams.add(s));
        }

        if (knownStreams.size === 0) return 0;

        const streamArgs = [...knownStreams].map(s => ({ key: s, id: '>' }));
        let result;
        try {
            result = await client.xReadGroup(
                C.consumerGroup,
                C.consumerName,
                streamArgs,
                { COUNT: C.batchSize, BLOCK: C.blockMs }
            );
        } catch (err) {
            // A subscribed stream (or its group) was deleted/trimmed away — one missing
            // group fails the WHOLE combined read with NOGROUP. Drop the stream cache and
            // re-sync next tick (discoverStreams prunes streams no ACTIVE workflow needs;
            // ensureGroups MKSTREAM-recreates a still-needed one) instead of wedging the
            // matcher on NOGROUP forever. Mirrors nexus stream.js recovery.
            if (String(err).includes('NOGROUP')) { knownStreams.clear(); return 0; }
            throw err;
        }
        if (!result) return 0;

        let processed = 0;
        for (const { name: stream, messages } of result) {
            for (const { id: entryId, message } of messages) {
                try {
                    const event = parseEntry(message);
                    const workflows = await findMatchingWorkflows(stream, event);

                    for (const wf of workflows) {
                        // Event payload becomes $input; fall back to full event fields.
                        const input = (event.payload && typeof event.payload === 'object')
                            ? event.payload : event;

                        // toFix §6.2① — at-most-once per (event, workflow). Ack happens
                        // AFTER enqueue, so a crash in between re-delivers this entry;
                        // the SETNX guard keeps the re-delivery from firing a second run.
                        // Stable event_id preferred (survives stream trim/re-emit);
                        // stream entry id is the fallback identity. Enqueue failure
                        // releases the guard so the re-delivery CAN fire (mirrors the
                        // nexus emit guard in stream.js).
                        const eventIdentity = (typeof event.event_id === 'string' && event.event_id) || entryId;
                        const firedKey = `${R.firedGuardPrefix}${eventIdentity}:${wf.id}`;
                        const fresh = await redis.set(firedKey, '1', { NX: true, EX: C.firedGuardTtlSec });
                        if (!fresh) {
                            logger.info('matcher.dedup.suppressed', { stream, entryId, workflowId: wf.id });
                            continue;
                        }

                        try {
                            await worker.enqueue({
                                workflowId: wf.id,
                                input,
                                triggerSource: `event:${stream}`,
                                triggerId: entryId,
                                // Chain correlation: carry the envelope's trace into the run —
                                // the worker threads it into every step call (X-Trace-* headers),
                                // so downstream WAL rows / emitted events stay on the same chain.
                                trace: event.trace_id || null,
                                depth: parseInt(event.depth, 10) || 0,
                                parentEventId: event.event_id || null,
                                // Actor-claim threading (governance.md §4 / AUDIT C4 minimal tier):
                                // actor  = envelope provenance ("what principal caused this") —
                                //          trusted per the emit-path rules, may be a uid or a
                                //          prefixed claim like 'sentinel:{id}'.
                                // source = the Router-AUTHENTICATED emitter identity (unforgeable).
                                // Both land on the run entity (audit) and feed the opt-in
                                // require_actor_permit pre-check in runner.run().
                                actor: (typeof event.actor === 'string' && event.actor) || null,
                                actorSource: (typeof event.source === 'string' && event.source) || null,
                            });
                        } catch (err) {
                            await redis.del(firedKey).catch(() => {});
                            throw err;
                        }
                        logger.info('matcher.enqueued', { stream, entryId, workflowId: wf.id });
                    }

                    // Ack after all enqueues succeed — if enqueue throws, we don't ack
                    // and the entry will be re-delivered.
                    await client.xAck(stream, C.consumerGroup, entryId);
                    processed++;
                } catch (err) {
                    logger.error(`matcher.process.failed ${stream} ${entryId}:`, err.message);
                    // No xAck → re-delivered after consumer restart.
                }
            }
        }
        return processed;
    }

    // ── Start / Stop ───────────────────────────────────────────────────────────

    async function loop(client) {
        logger.info('Event matcher started');
        while (!stopRequested) {
            try {
                // Runtime pause: stop auto-spawning workflow runs from inbound events
                // (degrade to manual). Manual orchestrator.run still works.
                if (control && await control.isPaused()) { await new Promise(r => setTimeout(r, C.blockMs)); continue; }
                await consumeOnce(client);
                // consumeOnce only BLOCKs (and thus paces this loop) when it has at least one
                // subscribed stream to xReadGroup. With no event-subscribing ACTIVE workflow,
                // knownStreams stays empty, consumeOnce returns instantly, and without this idle
                // wait the loop hot-spins — re-scanning WORKFLOW_INDEX (SMEMBERS) + CONTROL:PAUSED
                // (GET) thousands of times a second and burning a full CPU core. Mirror the
                // xReadGroup BLOCK so an idle orchestrator costs one cycle per blockMs, not a spin.
                if (knownStreams.size === 0 && C.blockMs > 0) await new Promise(r => setTimeout(r, C.blockMs));
            } catch (err) {
                logger.error('matcher.loop.error:', err.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        logger.info('Event matcher stopped');
    }

    async function start() {
        const streams = await discoverStreams();
        streams.forEach(s => knownStreams.add(s));
        const client = redis.duplicate();
        await client.connect();
        await ensureGroups(client, [...knownStreams]);
        loop(client).catch(err => logger.error('matcher.loop.crashed:', err.message));
    }

    async function stop() {
        stopRequested = true;
    }

    return { start, stop, discoverStreams, findMatchingWorkflows, matchesFilter, consumeOnce };
};
