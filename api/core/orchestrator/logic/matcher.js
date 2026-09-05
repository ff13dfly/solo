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
 *
 * Rollout window (2026-09-05, docs/feedback/done/event-triggered-workflow-lifecycle-drops-events.md):
 * - A workflow being PUT LIVE or REVISED is not ACTIVE for a while (PENDING_REVIEW, then a
 *   cooling period). Events arriving in that window used to be xAck'd with nothing enqueued —
 *   the ack sits OUTSIDE the `for (const wf of workflows)` loop, so an empty match set acked
 *   the entry as if it had been delivered. No run, no DLQ row, no trace.
 *   Now: if the only matching subscribers are PENDING_REVIEW, the envelope is PARKED
 *   (ack + list) and released as soon as one of them goes ACTIVE.
 * - Streams are discovered from PENDING_REVIEW subscriptions too, so (a) the consumer group
 *   exists from workflow CREATE rather than APPROVE — events emitted during review are no
 *   longer skipped by the group's '$' start position — and (b) behaviour no longer depends on
 *   whether the process happened to restart mid-window (knownStreams is a grow-only cache,
 *   so before this the same operation lost events or didn't depending on restart timing).
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

    // A workflow that will (or may) become runnable. PENDING_REVIEW counts: it is the state
    // a workflow sits in while being approved for the first time or re-approved after a
    // revision, and dropping its stream is what made rollouts lose events.
    // REJECTED / DELETED / DEPRECATED do NOT count — those are not coming back on their own.
    const WAITING_STATUS = 'PENDING_REVIEW';
    const isLive    = (wf) => wf && wf.status === 'ACTIVE';
    const isWaiting = (wf) => wf && wf.status === WAITING_STATUS;

    // Load every workflow doc once. Callers that match many events in a row (park release,
    // replay) reuse one snapshot instead of re-reading the index per event.
    async function loadWorkflows() {
        const ids = await redis.sMembers(R.workflowIndex);
        const out = [];
        for (const id of ids) {
            const wf = await redis.json.get(`${R.workflowPrefix}${id}`);
            if (wf) out.push(wf);
        }
        return out;
    }

    // Scan workflows and collect the union of their event_subscription streams.
    // Includes PENDING_REVIEW so the consumer group is created at workflow CREATE, not at
    // APPROVE — xGroupCreate uses '$', so a group born at approve time silently skips every
    // event emitted while the workflow was under review.
    async function discoverStreams() {
        const streams = new Set(C.extraStreams || []);
        for (const wf of await loadWorkflows()) {
            if (!isLive(wf) && !isWaiting(wf)) continue;
            for (const sub of (wf.event_subscriptions || [])) {
                if (sub && typeof sub.stream === 'string') streams.add(sub.stream);
            }
        }
        return [...streams];
    }

    // ── Workflow matching ──────────────────────────────────────────────────────

    // Split subscribers of `stream` matching `event` into those that can run it now (ACTIVE)
    // and those that cannot yet but will (PENDING_REVIEW). Pure given `wfs`.
    function subscribersFor(stream, event, wfs) {
        const active = [], waiting = [];
        for (const wf of wfs) {
            if (!isLive(wf) && !isWaiting(wf)) continue;
            for (const sub of (wf.event_subscriptions || [])) {
                if (!sub || sub.stream !== stream) continue;
                if (!matchesFilter(event, sub.filter)) continue;
                (isLive(wf) ? active : waiting).push(wf);
                break; // one subscription match per workflow is enough to trigger it
            }
        }
        return { active, waiting };
    }

    // Find all ACTIVE workflows that subscribe to `stream` and whose filter matches `event`.
    // Semantics unchanged (ACTIVE only) — the waiting set is a separate query on purpose.
    async function findMatchingWorkflows(stream, event) {
        return subscribersFor(stream, event, await loadWorkflows()).active;
    }

    // Subscribers that match but are not runnable yet — the reason to park rather than drop.
    async function findWaitingSubscribers(stream, event) {
        return subscribersFor(stream, event, await loadWorkflows()).waiting;
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

    // ── Enqueue one (event, workflow) pair ────────────────────────────────────

    // Returns true if a run-command was enqueued, false if the dedup guard suppressed it.
    // Shared by the live consume path, parked-event release, and admin replay so all three
    // carry identical trigger/trace/actor threading — a replay that dropped `triggerId` or
    // `actor` would re-run WITHOUT idempotency keys or past a different actor pre-check.
    async function enqueueFor(stream, entryId, event, wf) {
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
            return false;
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
        return true;
    }

    // ── Parked events (rollout / revision window) ─────────────────────────────

    async function park(client, stream, entryId, message, waiting) {
        const raw = JSON.stringify({
            stream, entryId, message,
            parkedAt: Date.now(),
            waitingFor: waiting.map(w => w.id),
        });
        await client.lPush(R.eventParkQueue, raw);
        // Bounded like every other queue here (newest at head ⇒ trim keeps 0..MAXLEN-1).
        await client.lTrim(R.eventParkQueue, 0, C.parkMaxLen - 1);
        logger.warn('matcher.parked', {
            stream, entryId, waitingFor: waiting.map(w => w.id),
            reason: 'subscribers not ACTIVE yet (under review); will be released on approval',
        });
    }

    // Release parked events whose subscriber is now ACTIVE. Runs at the top of every consume
    // cycle but costs one LLEN when the list is empty (the normal case).
    async function releaseParked(client) {
        let len = 0;
        try { len = await client.lLen(R.eventParkQueue); } catch (_) { return 0; }
        if (!len) return 0;

        const raws = await client.lRange(R.eventParkQueue, 0, C.parkReleaseBatch - 1);
        const wfs = await loadWorkflows();
        let released = 0;
        for (const raw of raws) {
            let rec = null;
            try { rec = JSON.parse(raw); } catch (_) { /* unparseable → drop below */ }
            if (!rec || !rec.stream) { await client.lRem(R.eventParkQueue, 1, raw); continue; }

            const event = parseEntry(rec.message || {});
            const { active, waiting } = subscribersFor(rec.stream, event, wfs);

            if (active.length > 0) {
                try {
                    for (const wf of active) await enqueueFor(rec.stream, rec.entryId, event, wf);
                } catch (err) {
                    // Leave it parked; next cycle retries. Losing it here would recreate the
                    // very hole this queue exists to close.
                    logger.error('matcher.park.release_failed:', err.message);
                    continue;
                }
                await client.lRem(R.eventParkQueue, 1, raw);
                released++;
                logger.info('matcher.park.released', { stream: rec.stream, entryId: rec.entryId });
                continue;
            }

            // Nobody is coming: every waiting subscriber was rejected/deleted, or the wait
            // exceeded parkTtlMs. Drop it rather than pin the queue forever.
            const expired = Date.now() - (rec.parkedAt || 0) > C.parkTtlMs;
            if (waiting.length === 0 || expired) {
                await client.lRem(R.eventParkQueue, 1, raw);
                logger.warn('matcher.park.dropped', {
                    stream: rec.stream, entryId: rec.entryId,
                    reason: expired ? 'park ttl exceeded' : 'no subscriber left (rejected/deleted)',
                });
            }
        }
        return released;
    }

    // ── Admin replay (orchestrator.event.replay) ──────────────────────────────

    // Re-run matching over a RANGE OF AN EVENT STREAM and enqueue for ACTIVE subscribers.
    //
    // @why The park queue only helps events that arrive AFTER this version ships. Events
    //   already dropped by an older build are still in the stream — EVENT:* streams are
    //   emitted with a plain xAdd and never trimmed (router/config.js: "xAdd currently
    //   unbounded"), and an xAck marks an entry consumed for a group without removing it.
    //   So the data is recoverable; what was lost is only the delivery. This is that
    //   recovery, and it is also the answer for "the consumer group was created after the
    //   event arrived" (xGroupCreate uses '$', so those entries were never delivered at all).
    // @attention The fired-guard still applies: replaying an event a workflow ALREADY ran
    //   within firedGuardTtlSec is reported as `suppressed`, not re-run. That is deliberate —
    //   an admin recovery tool must not be able to double-fire live side effects.
    async function replayRange({ stream, from = '-', to = '+', limit = 100 } = {}) {
        if (typeof stream !== 'string' || !stream) throw new Error('replay: stream required');
        const cap = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
        const entries = await redis.xRange(stream, from, to, { COUNT: cap });
        const wfs = await loadWorkflows();
        let scanned = 0, enqueued = 0, suppressed = 0, unmatched = 0;
        for (const { id, message } of (entries || [])) {
            scanned++;
            const event = parseEntry(message);
            const { active } = subscribersFor(stream, event, wfs);
            if (active.length === 0) { unmatched++; continue; }
            for (const wf of active) {
                if (await enqueueFor(stream, id, event, wf)) enqueued++; else suppressed++;
            }
        }
        logger.info('matcher.replay', { stream, from, to, scanned, enqueued, suppressed, unmatched });
        return { stream, from, to, scanned, enqueued, suppressed, unmatched };
    }

    // ── Core consume cycle ─────────────────────────────────────────────────────

    // One read + process iteration. Exposed for testing (pass a mock client).
    async function consumeOnce(client) {
        // Release anything parked during a rollout whose subscriber has since gone ACTIVE.
        // Before the blocking read, so an approval takes effect within one cycle.
        await releaseParked(client).catch(err => logger.error('matcher.park.release_error:', err.message));

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
                    const wfs = await loadWorkflows();
                    const { active, waiting } = subscribersFor(stream, event, wfs);

                    for (const wf of active) await enqueueFor(stream, entryId, event, wf);

                    // Nobody can run it NOW, but a subscriber is under review and will be able
                    // to. Park the envelope instead of letting the ack below discard it — this
                    // is the whole rollout/revision window. (Only when no ACTIVE subscriber
                    // took it; if one did, the event has been delivered and is not "lost".)
                    if (active.length === 0 && waiting.length > 0) {
                        await park(client, stream, entryId, message, waiting);
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

    return { start, stop, discoverStreams, findMatchingWorkflows, findWaitingSubscribers,
             matchesFilter, consumeOnce, releaseParked, replayRange };
};
