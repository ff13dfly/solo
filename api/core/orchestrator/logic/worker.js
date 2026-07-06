const crypto = require('crypto');
const { createLogger } = require('../../../library/logger');
const config = require('../config');
const { NeedsGrantError } = require('./NeedsGrantError');

/**
 * Async run-queue worker (event.md §5).
 *
 * Async triggers (event/cron — not yet built) enqueue *run-commands*; this
 * worker drains them and executes each workflow exactly once under the service
 * bot identity. Sync RPC (workflow.run) does NOT use this path — it runs
 * runner.run() inline so the caller gets a low-latency response (event.md §6).
 *
 * Mirrors notification's worker (PENDING list + RETRY zset + DEADLETTER list,
 * exponential backoff). See core/notification/logic/worker.js.
 *
 * @param ctx.relay   service bot relay (for the bot token used as step auth)
 * @param ctx.runner  the runner logic module (exposes run())
 */
module.exports = (redis, { relay, runner, run = null, control = null } = {}) => {
    const W = config.worker;
    const R = config.redis;
    const logger = createLogger('orchestrator-worker');

    // Thrown errors happen BEFORE any step side-effect (gate checks: status,
    // allowed_triggers, footprint, missing inputs). Most are permanent — the
    // same run-command will fail identically, so retrying is pointless and just
    // delays the deadletter. Only treat genuinely transient failures as
    // retryable: INTERNAL_ERROR (e.g. user.permit.get unreachable) and
    // non-jsonrpc errors (network/unexpected).
    function isRetryable(err) {
        if (!err || err.code === undefined || err.code === null) return true; // non-jsonrpc → transient
        return err.code === -32603; // INTERNAL_ERROR
    }

    function backoffMs(attempts) {
        return Math.min(W.retryBaseMs * (2 ** attempts), W.retryMaxMs);
    }

    // Promote retry-queue entries whose backoff has elapsed back onto pending.
    async function promoteDueRetries(client) {
        const now = Date.now();
        const due = await client.zRangeByScore(R.runQueueRetry, 0, now);
        for (const raw of due) {
            const removed = await client.zRem(R.runQueueRetry, raw);
            if (removed > 0) await client.lPush(R.runQueuePending, raw);
        }
    }

    /**
     * Enqueue a run-command for async execution.
     * @param cmd { workflowId, input?, triggerSource, triggerId?, runId? }
     *
     * A runId is generated for new commands (D8 — run entity tracking for async
     * sources). For resume calls (from run.grant), cmd.runId is already set and
     * preserved so the existing run entity is reused.
     */
    async function enqueue(cmd, client = redis) {
        if (!cmd || !cmd.workflowId) throw new Error('enqueue: workflowId required');
        const runId = cmd.runId || ('run_' + crypto.randomBytes(6).toString('hex'));
        const runCommand = {
            runId,
            workflowId: cmd.workflowId,
            input: cmd.input || {},
            triggerSource: cmd.triggerSource || 'event',
            triggerId: cmd.triggerId || null,
            // Chain correlation (matcher passes the triggering envelope's values;
            // absent for manual/sync enqueues — the step calls then start a chain).
            trace: cmd.trace || null,
            depth: Number.isFinite(cmd.depth) ? cmd.depth : 0,
            parentEventId: cmd.parentEventId || null,
            // Actor-claim (AUDIT C4 minimal tier): triggering principal (actor) +
            // authenticated emitter (actorSource) from the event envelope. Audited on
            // the run entity; enforced only by opt-in require_actor_permit workflows.
            actor: cmd.actor || null,
            actorSource: cmd.actorSource || null,
            enqueuedAt: Date.now(),
            attempts: cmd.attempts || 0,
        };
        await client.lPush(R.runQueuePending, JSON.stringify(runCommand));
        return runCommand;
    }

    async function processOne(client, raw) {
        let cmd;
        try {
            cmd = JSON.parse(raw);
        } catch (e) {
            logger.error('Malformed run-command, dropping:', raw);
            return;
        }

        // Build bot-authenticated headers so runner's downstream step calls (and
        // the footprint pre-check's user.permit.get) execute as the service bot.
        let headers = {};
        try {
            const token = await relay.getToken();
            headers = { authorization: `Bearer ${token}` };
            // Chain correlation: every step call carries the triggering event's trace,
            // so the Router inherits the chain (and the steps' own emits get depth+1).
            if (cmd.trace) {
                headers['x-trace-id'] = String(cmd.trace);
                headers['x-trace-depth'] = String(Number.isFinite(cmd.depth) ? cmd.depth : 0);
            }
        } catch (err) {
            // No usable bot token → can't run anything. Transient (admin must
            // seed/refresh the token); retry rather than deadletter.
            return scheduleRetryOrDeadletter(client, cmd, err, 'no bot token');
        }

        // D8: create or resume run entity for this async execution. On resume (a STALLED
        // run requeue()'d), create() spreads the existing doc — runDoc.compensationProgress
        // (if any) is this run's Saga-rollback cursor from a prior round (P2, 2026-07-03).
        let runDoc = null;
        if (run && cmd.runId) {
            runDoc = await run.create(cmd).catch(e => { logger.warn('run.create failed:', e.message); return null; });
        }

        // Load one-shot grant if this is a resume (event.md §9 — RESUMING path).
        let oneTimeGrant = null;
        if (run && cmd.runId) {
            oneTimeGrant = await run.getGrant(cmd.runId).catch(() => null);
        }

        try {
            const result = await runner.run(
                {
                    workflowId: cmd.workflowId,
                    input: cmd.input || {},
                    triggerSource: cmd.triggerSource || 'event',
                    triggerId: cmd.triggerId || null,
                    runId: cmd.runId || null,   // joins trace-audit records to the run entity ops already see in run.list/get
                    oneTimeGrant,
                    // Actor-claim: who caused the triggering event (vs W.botUid = who EXECUTES).
                    // runner records it as $context.trigger_actor and, for workflows that opt
                    // in via require_actor_permit, pre-checks the actor's OWN permit.
                    actorClaim: (cmd.actor || cmd.actorSource)
                        ? { actor: cmd.actor || null, source: cmd.actorSource || null }
                        : null,
                    // Per-step checkpoint (async only): records committed steps + resets the
                    // stall timer. Fire-and-forget; a checkpoint failure must not affect the run.
                    onStepCommit: (run && cmd.runId)
                        ? (stepId) => run.checkpoint(cmd.runId, stepId).catch(() => {})
                        : null,
                    // Saga-compensation durability (async only, P2 2026-07-03): the persisted
                    // cursor from a prior round (resume) + a checkpoint callback so runner can
                    // persist each attempt as it happens — see runner.js's runCompensations.
                    compensationProgress: (runDoc && runDoc.compensationProgress) || null,
                    onCompensationCommit: (run && cmd.runId)
                        ? (entry) => run.compensationCheckpoint(cmd.runId, entry).catch(() => {})
                        : null,
                },
                headers,
                W.botUid
            );
            // runner RETURNED (didn't throw) ⇒ the workflow executed. Whether the
            // outcome is 'completed' or 'failed', steps may have produced
            // side-effects, so we must NOT re-run. Ack by simply returning.
            logger.info('run.done', {
                workflowId: cmd.workflowId,
                triggerSource: cmd.triggerSource,
                status: result && result.status,
                failedStep: result && result.failedStep,
            });
            if (result && result.status === 'failed') {
                // toFix §6.1 — a failed run must be visible (FAILED, not DONE), carry
                // its cleanup manifest, and pull a human in (same seam as NEEDS_GRANT).
                if (run && cmd.runId) {
                    await run.fail(cmd.runId, {
                        failedStep: result.failedStep || null,
                        error: result.error || null,
                        cleanupManifest: result.cleanup_manifest || null,
                        compensation: result.compensation || null,   // Saga rollback outcome → run doc (operator UI)
                        workflowVersion: result.workflowVersion || null,
                    }).catch(e => logger.warn('run.fail failed:', e.message));
                }
                await notifyRunFailed(cmd, result);
            } else if (run && cmd.runId) {
                await run.done(cmd.runId, { workflowVersion: (result && result.workflowVersion) || null })
                    .catch(e => logger.warn('run.done failed:', e.message));
            }
        } catch (err) {
            if (err instanceof NeedsGrantError) {
                // D7: runner signals permission gap; worker decides to pause.
                return handleNeedsGrant(client, cmd, err);
            }
            // runner THREW a non-NeedsGrant error ⇒ a gate rejected it before any
            // side-effect. Safe to retry transient ones; deadletter permanent.
            return handleThrown(client, cmd, err);
        }
    }

    // event.md §9 — bot permit insufficient; pause the run and wait for human grant.
    // This is NOT a failure that should retry — retrying with the same bot permit
    // would produce the same result. The run stays paused until a human intervenes.
    async function handleNeedsGrant(client, cmd, err) {
        logger.warn('run.paused', {
            runId: cmd.runId,
            workflowId: cmd.workflowId,
            missingMethods: err.missing,
        });

        if (run && cmd.runId) {
            await run.pause(cmd.runId, { missingMethods: err.missing })
                .catch(e => logger.warn('run.pause failed:', e.message));
        }

        // Emit NEEDS_GRANT onto the bus (event.emit IS live; the registry allows
        // system.orchestrator → EVENT:WORKFLOW:NEEDS_GRANT) so any consumer can react.
        try {
            await relay.call('event.emit', {
                stream: 'EVENT:WORKFLOW:NEEDS_GRANT',
                type: 'workflow.needs_grant',
                payload: {
                    runId: cmd.runId || null,
                    workflowId: cmd.workflowId,
                    missingMethods: err.missing,
                    triggerSource: cmd.triggerSource,
                    pausedAt: Date.now(),
                },
            });
        } catch (e) {
            logger.warn('run.needs_grant.emit_failed:', e.message);
        }

        // auto→human seam: PULL a human in (not just polling). Deliver an alert to the
        // shared ops inbox so an operator can grant via orchestrator.run.grant. Fail-soft —
        // a notify hiccup must not undo the pause. Idempotent on (ops, ref).
        try {
            await relay.call('notification.send', {
                targetId: config.opsInbox,
                type: 'ops.needs_grant',
                payload: {
                    runId: cmd.runId || null,
                    workflowId: cmd.workflowId,
                    missingMethods: err.missing,
                    actor: cmd.actor || null,           // who caused the triggering event (audit)
                    grantVia: 'orchestrator.run.grant',
                    pausedAt: Date.now(),
                },
                sourceId: 'orchestrator',
                ref: 'needs_grant:' + (cmd.runId || cmd.workflowId),
            });
        } catch (e) {
            logger.warn('run.needs_grant.notify_failed:', e.message);
        }
    }

    // toFix §6.1② — failure seam, mirroring handleNeedsGrant's notify: deliver an
    // alert (with the cleanup manifest) to the shared ops inbox. Fail-soft — a
    // notify hiccup must not turn a recorded failure into a retry. Async path only:
    // sync callers get the failed result back directly and need no second channel.
    async function notifyRunFailed(cmd, result) {
        try {
            await relay.call('notification.send', {
                targetId: config.opsInbox,
                type: 'ops.run_failed',
                payload: {
                    runId: cmd.runId || null,
                    workflowId: cmd.workflowId,
                    failedStep: result.failedStep || null,
                    error: result.error || null,
                    cleanupManifest: result.cleanup_manifest || [],
                    trace: cmd.trace || null,
                    actor: cmd.actor || null,           // who caused the triggering event (audit)
                    failedAt: Date.now(),
                },
                sourceId: 'orchestrator',
                ref: 'run_failed:' + (cmd.runId || cmd.workflowId),
            });
        } catch (e) {
            logger.warn('run.failed.notify_failed:', e.message);
        }
    }

    // toFix §6.1④ — stall scanner. blPop is a destructive read: if the worker dies
    // mid-run the command is gone and the run entity sits RUNNING forever with
    // nobody coming back for it. Periodically sweep RUNNING runs whose last
    // activity predates the stall threshold, flag them STALLED, and alert ops.
    let lastStallScanAt = 0;
    async function scanStalledRuns() {
        if (!run) return [];
        const now = Date.now();
        if (now - lastStallScanAt < W.stallScanMs) return [];
        lastStallScanAt = now;

        const running = await run.list({ status: 'RUNNING' }).catch(() => []);
        const stalled = [];
        for (const r of running) {
            const flipped = await run.stall(r.id, { thresholdMs: W.stallMs })
                .catch(e => { logger.warn('run.stall failed:', e.message); return null; });
            if (!flipped) continue;
            stalled.push(flipped);
            logger.error('run.stalled', { runId: r.id, workflowId: r.workflowId });
            try {
                await relay.call('notification.send', {
                    targetId: config.opsInbox,
                    type: 'ops.run_stalled',
                    payload: {
                        runId: r.id,
                        workflowId: r.workflowId,
                        committedSteps: flipped.committedSteps || [],
                        startedAt: r.startedAt || null,
                        stalledAt: flipped.stalledAt,
                        hint: 'worker died mid-run. committedSteps lists what already ran. Re-drive idempotency-safely via orchestrator.run.retry (re-runs from top; committed steps dedup), or clean up manually.',
                    },
                    sourceId: 'orchestrator',
                    ref: 'run_stalled:' + r.id,
                });
            } catch (e) {
                logger.warn('run.stalled.notify_failed:', e.message);
            }
        }
        return stalled;
    }

    async function handleThrown(client, cmd, err) {
        if (!isRetryable(err)) {
            // A non-retryable error here is a CLIENT/gate rejection (a real jsonrpc code that
            // is NOT -32603 — e.g. cooling-period / footprint / status FORBIDDEN), thrown
            // before any side-effect. It's an expected business rejection, NOT a system fault,
            // so it goes to the DLQ for visibility but must NOT pollute ERROR:QUEUE — use warn
            // (logger.error is what feeds ERROR:QUEUE). Keeps the e2e ERROR:QUEUE guard honest.
            logger.warn('run.rejected.permanent', {
                workflowId: cmd.workflowId, code: err.code, reason: err.message,
            });
            await client.lPush(R.runQueueDeadletter,
                JSON.stringify({ ...cmd, lastError: err.message, lastCode: err.code }));
            // Close out the run entity too. processOne created it (RUNNING) BEFORE the
            // gate rejection, so without this it lingers RUNNING until the stall scanner
            // flips it STALLED and pages ops with a false "worker died mid-run" story.
            // DEADLETTER is the honest terminal state (mirrors the DLQ push above).
            if (run && cmd.runId) {
                await run.deadletter(cmd.runId, { error: err.message })
                    .catch(e => logger.warn('run.deadletter failed:', e.message));
            }
            return;
        }
        return scheduleRetryOrDeadletter(client, cmd, err, 'transient');
    }

    async function scheduleRetryOrDeadletter(client, cmd, err, why) {
        const attempts = (cmd.attempts || 0) + 1;
        if (attempts >= W.maxRetries) {
            logger.error('run.deadletter', {
                workflowId: cmd.workflowId, attempts, why, reason: err.message,
            });
            await client.lPush(R.runQueueDeadletter,
                JSON.stringify({ ...cmd, attempts, lastError: err.message }));
            // Same run-entity closeout as the permanent path — retries are exhausted,
            // nobody is coming back for this run doc.
            if (run && cmd.runId) {
                await run.deadletter(cmd.runId, { error: err.message })
                    .catch(e => logger.warn('run.deadletter failed:', e.message));
            }
        } else {
            const delay = backoffMs(attempts);
            await client.zAdd(R.runQueueRetry,
                { score: Date.now() + delay, value: JSON.stringify({ ...cmd, attempts }) });
            logger.warn('run.retry', {
                workflowId: cmd.workflowId, attempts, dueInMs: delay, why, reason: err.message,
            });
        }
    }

    async function start() {
        const client = redis.duplicate();
        await client.connect();
        logger.info('Worker started, polling queue:', R.runQueuePending);

        (async () => {
            while (true) {
                try {
                    // Runtime pause: stop draining the async queue (degrade to manual).
                    // Sync RPCs (workflow.run, run.grant/abort/list) keep working — they
                    // run in the handler, not this loop.
                    if (control && await control.isPaused()) { await new Promise(r => setTimeout(r, W.blpopTimeout * 1000)); continue; }
                    await promoteDueRetries(redis);
                    await scanStalledRuns();
                    const result = await client.blPop(R.runQueuePending, W.blpopTimeout);
                    if (result) await processOne(redis, result.element);
                } catch (err) {
                    logger.error('Worker loop error:', err.message);
                    await new Promise(r => setTimeout(r, W.loopBackoffMs));
                }
            }
        })();
    }

    return { start, enqueue, processOne, promoteDueRetries, isRetryable, scanStalledRuns };
};
