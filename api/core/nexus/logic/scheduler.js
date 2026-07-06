/**
 * Nexus time-driven scheduler (event.md §6.2, decision D6).
 *
 * Runs as a same-process setInterval loop alongside the existing stream
 * consumer. On each tick it atomically pops due schedule entries from a
 * Redis zset and executes their declared action:
 *
 *   run_command  → lPush run-command to ORCHESTRATOR:RUNQ:PENDING
 *                  (both services share the same Redis; no Router round-trip)
 *   emit_event   → relay.call('event.emit', ...) via Router
 *                  (gracefully fails until Router gains event.emit support)
 *
 * Idempotency: each fired entry gets trigger_id = '{schedule_id}:{fire_at}'
 * so that deduplication is possible end-to-end (event.md §6.2).
 *
 * Multi-instance safety: ZPOPMIN is atomic — only one nexus instance claims
 * each entry. Future entries accidentally popped (score > now) are re-added.
 *
 * Recurrence: if recurrence_ms is set, next fire_at = fired_at + recurrence_ms
 * and the entry is re-added to the zset. null = one-shot (no re-add).
 */
const crypto = require('crypto');
const { createLogger } = require('../../../library/logger');

// toFix §6.2② — stable event_id for emitted slot events. Must satisfy the
// Router's EVENT_ID_RE (/^[A-Za-z0-9_-]{8,64}$/): squash other chars, clamp, pad.
function stableEventId(s) {
    const cleaned = String(s).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    return cleaned.length >= 8 ? cleaned : (cleaned + '--------').slice(0, 8);
}

module.exports = (redis, { config, relay, control = null }) => {
    const logger = createLogger('nexus-scheduler');
    const C = config.scheduler;
    const R = config.redis;

    let stopRequested = false;

    // ── Action execution ───────────────────────────────────────────────────────

    async function executeAction(def, firedAt) {
        const { action, schedule_id } = def;
        const triggerId = `${schedule_id}:${firedAt}`;

        if (action.kind === 'run_command') {
            const cmd = JSON.stringify({
                runId:         'run_' + crypto.randomBytes(6).toString('hex'),
                workflowId:    action.workflow_id,
                input:         action.input || {},
                triggerSource: `cron:${schedule_id}`,
                triggerId,
                enqueuedAt:    Date.now(),
                attempts:      0,
            });
            await redis.lPush(R.orchRunQueuePending, cmd);
            logger.info('scheduler.run_command', { schedule_id, workflowId: action.workflow_id, triggerId });

        } else if (action.kind === 'emit_event') {
            // Provenance lives in the envelope `actor` field (= cron:{schedule_id}),
            // NOT smuggled into payload. Router honours this actor via trustEventActor.
            // payload stays purely the user-defined business data. A failure here
            // PROPAGATES (event.emit is live) — the tick handles it (recurring survives,
            // see below); the old "not yet in Router" swallow hid real registry blocks.
            await relay.call('event.emit', {
                stream:  action.stream,
                type:    action.type,
                actor:   `cron:${schedule_id}`,
                // toFix §6.2② — stable per-slot identity: a retried/re-fired slot
                // re-sends the SAME id, so Router EVENT:DEDUP suppresses the duplicate.
                event_id: stableEventId(`sch-${schedule_id}-${firedAt}`),
                payload: action.payload || {},
            });
            logger.info('scheduler.emit_event', { schedule_id, stream: action.stream, triggerId });
        } else {
            logger.warn('scheduler.unknown_action_kind', { schedule_id, kind: action.kind });
        }
    }

    // ── One tick ───────────────────────────────────────────────────────────────

    // Pop up to 100 lowest-score entries, process due ones, re-add future ones.
    // Exposed for testing (call tick() directly without starting the interval).
    async function tick(now = Date.now()) {
        // Runtime pause: skip firing due tasks (degrade to manual). Guards both the
        // interval loop and any direct tick() call. Schedule CRUD RPCs keep working.
        if (control && await control.isPaused()) return 0;
        // node-redis v5: zPopMin(key) pops a single member and returns ONE object
        // (not an array); the count form is zPopMinCount(key, count). Calling
        // zPopMin(key, 100) silently returned a single {value,score}, so the loop
        // below threw "items is not iterable" every tick and the scheduler never
        // fired. (Regression from the node-redis v5 upgrade; caught by e2e suite 51.)
        const items = await redis.zPopMinCount(R.scheduleZset, 100);
        if (!items || items.length === 0) return 0;

        const future = [];
        let fired = 0;

        for (const { value: scheduleId, score: firedAt } of items) {
            if (firedAt > now) {
                // Not due yet — re-add immediately (no side effects).
                future.push({ score: firedAt, value: scheduleId });
                continue;
            }

            try {
                const def = await redis.json.get(`${R.scheduleDefPrefix}${scheduleId}`);
                if (!def) {
                    logger.warn('scheduler.def.missing', { scheduleId });
                    continue;
                }
                if (!def.enabled) {
                    logger.debug('scheduler.skip.disabled', { scheduleId });
                    // Don't re-add: disabled entries stay off the zset.
                    continue;
                }

                // Action failure must NOT kill a recurring schedule — a single bad fire
                // (e.g. a transient event.emit error) is logged, but the SCHEDULE survives
                // and the next occurrence is still enqueued below (cron semantics).
                let actionError = null;
                try {
                    await executeAction(def, firedAt);
                    fired++;
                } catch (err) {
                    actionError = err;
                    logger.error('scheduler.action.failed', { scheduleId, kind: def.action && def.action.kind, error: err.message });
                }

                def.last_fired_at = now;

                if (def.recurrence_ms != null) {
                    // Recurring: compute next fire_at and re-enqueue (even if this fire failed).
                    const nextFireAt = firedAt + def.recurrence_ms;
                    def.fire_at = nextFireAt;
                    await redis.json.set(`${R.scheduleDefPrefix}${scheduleId}`, '$', def);
                    await redis.zAdd(R.scheduleZset, { score: nextFireAt, value: scheduleId });
                    logger.info('scheduler.rescheduled', { scheduleId, nextFireAt, afterError: !!actionError });
                } else {
                    // One-shot: persist last_fired_at, no re-enqueue (a failed one-shot is
                    // not retried — the operator re-creates it).
                    await redis.json.set(`${R.scheduleDefPrefix}${scheduleId}`, '$', def);
                    logger.info('scheduler.fired.oneshot', { scheduleId, firedAt, afterError: !!actionError });
                }
            } catch (err) {
                // Infrastructure failure (def read / json.set / zAdd) — NOT the action.
                // Don't re-add on an infra error (avoid double-fire); surface for ops.
                logger.error(`scheduler.entry.failed ${scheduleId}:`, err.message);
            }
        }

        // Re-add future entries that were popped but aren't due yet.
        for (const item of future) {
            await redis.zAdd(R.scheduleZset, item);
        }

        return fired;
    }

    // ── Start / Stop ───────────────────────────────────────────────────────────

    async function start() {
        logger.info('Scheduler started', { tickMs: C.tickMs });

        const loop = async () => {
            while (!stopRequested) {
                try {
                    await tick();
                } catch (err) {
                    logger.error('scheduler.loop.error:', err.message);
                }
                await new Promise(r => setTimeout(r, C.tickMs));
            }
            logger.info('Scheduler stopped');
        };

        loop().catch(err => logger.error('scheduler.loop.crashed:', err.message));
    }

    function stop() {
        stopRequested = true;
    }

    return { start, stop, tick };
};
