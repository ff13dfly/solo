/**
 * Run entity state machine (event.md §5.4 / §9, decision D8).
 *
 * A "run" tracks one async workflow execution from enqueue to terminal state.
 * Only async sources (worker) create run entities — sync RPC executes inline
 * and discards the result (D5/D8).
 *
 * State machine:
 *   RUNNING → DONE          (all steps finished successfully)
 *   RUNNING → FAILED        (a non-ignore step failed; side-effects of earlier steps
 *                            are committed — cleanupManifest lists them for a human)
 *   RUNNING → STALLED       (worker died mid-run: blPop already consumed the command,
 *                            nothing will ever finish this run — flagged by the stall
 *                            scanner so an operator investigates instead of nobody)
 *   RUNNING → PAUSED_AWAITING_HUMAN  (H6 NeedsGrantError — bot permit insufficient)
 *   PAUSED  → RESUMING      (human granted one-shot permission)
 *   RESUMING→ RUNNING        (worker picked it up again — via create() upsert)
 *   PAUSED  → ABORTED       (human rejected / timed out)
 *   RUNNING → DEADLETTER    (genuine transient failure exhausted maxRetries)
 *   STALLED → RESUMING      (operator re-drives via run.requeue; re-run from the top, with
 *                            idempotency_key making committed steps dedup downstream)
 *
 * Storage: ORCHESTRATOR:RUN:{id}  (JSON document)
 *          ORCHESTRATOR:RUN:{id}:GRANT  (one-shot grant, cleared after use)
 *
 * compensationProgress (v1-implementation-plan.md P2, 2026-07-03): a Saga rollback that
 * crashes mid-compensation (STALLED, then requeue()'d) resumes from this persisted cursor
 * instead of blindly re-running every compensation from scratch — see compensationCheckpoint()
 * below and runner.js's runCompensations(). A per-step attempt count survives the restart too,
 * so a compensation whose failure is a genuine bug (not a transient fault) stops auto-retrying
 * after config.worker.compensationMaxAttempts rounds instead of looping forever.
 */
const crypto = require('crypto');
const jsonrpc = require('../handlers/jsonrpc');
const config = require('../config');

module.exports = (redis) => {
    const R = config.redis;

    function key(id)      { return `${R.runPrefix}${id}`; }
    function grantKey(id) { return `${R.runPrefix}${id}:GRANT`; }

    // Create or resume a run entity.
    // - First call (no existing doc): creates with status RUNNING.
    // - Subsequent call (resume after PAUSED→RESUMING): updates status to RUNNING.
    async function create(cmd) {
        const id = cmd.runId;
        if (!id) throw new Error('run.create: runId required');

        const existing = await redis.json.get(key(id));
        if (existing) {
            const updated = { ...existing, status: 'RUNNING', resumedAt: Date.now() };
            await redis.json.set(key(id), '$', updated);
            await redis.sAdd(R.runIndex, id);
            return updated;
        }

        const run = {
            id,
            workflowId: cmd.workflowId,
            input: cmd.input || {},
            triggerSource: cmd.triggerSource,
            triggerId: cmd.triggerId || null,
            // Chain correlation: which trace/event caused this run (observability join key)
            trace: cmd.trace || null,
            parentEventId: cmd.parentEventId || null,
            // Actor-claim audit (AUDIT C4 minimal tier): the triggering principal (actor)
            // and the Router-authenticated emitter (actorSource) — permanent attribution
            // of "who caused this run", distinct from the bot identity that executes it.
            actor: cmd.actor || null,
            actorSource: cmd.actorSource || null,
            enqueuedAt: cmd.enqueuedAt || Date.now(),
            attempts: cmd.attempts || 0,
            status: 'RUNNING',
            startedAt: Date.now(),
        };
        await redis.json.set(key(id), '$', run);
        await redis.sAdd(R.runIndex, id);   // 维护 run id 索引(list 用 SMEMBERS,非 KEYS)
        return run;
    }

    async function _load(id) {
        return redis.json.get(key(id));
    }

    async function _save(run) {
        await redis.json.set(key(run.id), '$', run);
        return run;
    }

    async function get(id) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const run = await _load(id);
        if (!run) throw jsonrpc.NOT_FOUND('Run');
        return run;
    }

    // Transition to PAUSED_AWAITING_HUMAN (H6 NeedsGrantError caught by worker).
    async function pause(id, { missingMethods }) {
        const run = await _load(id);
        if (!run) return null;
        return _save({ ...run, status: 'PAUSED_AWAITING_HUMAN', missingMethods, pausedAt: Date.now() });
    }

    // Transition to DONE and clear the one-shot grant (if any).
    // workflowVersion (toFix §6.6): which immutable definition snapshot executed.
    async function done(id, { workflowVersion = null } = {}) {
        const run = await _load(id);
        if (!run) return null;
        await redis.json.del(grantKey(id)).catch(() => {});
        return _save({ ...run, status: 'DONE', workflowVersion, doneAt: Date.now() });
    }

    // Transition to FAILED (toFix §6.1 — a non-ignore step failed). Distinct from
    // DONE so operators can filter, and from DEADLETTER (which means the run never
    // executed). cleanupManifest = committed side-effects a human may need to undo.
    async function fail(id, { failedStep = null, error = null, cleanupManifest = null, compensation = null, workflowVersion = null } = {}) {
        const run = await _load(id);
        if (!run) return null;
        await redis.json.del(grantKey(id)).catch(() => {});
        return _save({
            ...run,
            status: 'FAILED',
            failedStep,
            lastError: error,
            cleanupManifest: Array.isArray(cleanupManifest) ? cleanupManifest : null,
            // Saga rollback outcome ({ ran, failed, entries:[{forStep, compensate, method, status}] })
            // so the operator UI can show what was undone (in reverse order) and what failed.
            compensation: compensation && typeof compensation === 'object' ? compensation : null,
            workflowVersion,
            failedAt: Date.now(),
        });
    }

    // Transition to STALLED (toFix §6.1④ — worker consumed the command via blPop and
    // died mid-run; nothing will ever complete this run). Guarded: only flips runs
    // still RUNNING whose last activity is older than the threshold, so a run that
    // finished while the scanner iterated is left alone (done()/fail() simply wins).
    async function stall(id, { thresholdMs }) {
        const run = await _load(id);
        if (!run || run.status !== 'RUNNING') return null;
        // lastActivity includes per-step checkpoints, so a long but PROGRESSING run keeps
        // resetting the clock and is not false-flagged — only a truly stuck run trips this.
        const lastActivity = Math.max(run.startedAt || 0, run.resumedAt || 0, run.lastActivity || 0);
        if (Date.now() - lastActivity < thresholdMs) return null;
        return _save({ ...run, status: 'STALLED', stalledAt: Date.now() });
    }

    // Record a committed step (toFix §6.1④ companion). A lightweight progress marker so a
    // STALLED run's alert can list what committed (and so the stall timer resets on progress).
    // Best-effort — only touches RUNNING runs; the worker calls it fire-and-forget per step.
    async function checkpoint(id, stepId) {
        const run = await _load(id);
        if (!run || run.status !== 'RUNNING') return null;
        const committedSteps = Array.isArray(run.committedSteps) ? run.committedSteps : [];
        if (stepId && !committedSteps.includes(stepId)) committedSteps.push(stepId);
        return _save({ ...run, committedSteps, lastActivity: Date.now() });
    }

    // Saga compensation checkpoint (v1-implementation-plan.md P2, 2026-07-03 — durable
    // compensation across restarts). Called per compensation-step ATTEMPT — BEFORE executing
    // (status:'attempting', so a crash mid-call still leaves the attempt counted — that's what
    // makes the retry cap durable instead of resetting to zero on every restart) and again
    // after (status:'success'|'failed'|'exhausted'). A run resumed via requeue() carries this
    // forward (create() spreads the existing doc), so runner.runCompensations can skip entries
    // already 'success' and refuse to keep retrying ones already 'exhausted' — see runner.js.
    // Mirrors checkpoint() above: best-effort, RUNNING-only, resets the stall timer (compensation
    // progress previously did NOT touch lastActivity — a slow-but-progressing Saga rollback
    // could be false-flagged STALLED).
    async function compensationCheckpoint(id, { forStep, compensate, status, attempts, error } = {}) {
        if (!forStep) return null;
        const run = await _load(id);
        if (!run || run.status !== 'RUNNING') return null;
        const compensationProgress = { ...(run.compensationProgress || {}) };
        const prior = compensationProgress[forStep];
        compensationProgress[forStep] = {
            compensate: compensate || (prior && prior.compensate) || null,
            status,
            attempts: typeof attempts === 'number' ? attempts : ((prior && prior.attempts) || 0),
            lastError: status === 'failed' ? (error || null) : ((prior && prior.lastError) || null),
            lastAttemptAt: Date.now(),
        };
        return _save({ ...run, compensationProgress, lastActivity: Date.now() });
    }

    // Re-drive a STALLED run (the recovery the deferred-durability gap left open). It re-runs
    // from the top — the run's ORIGINAL triggerId is PRESERVED so the re-run's idempotency
    // keys MATCH, making committed steps (and already-run compensations) dedup downstream
    // instead of double-committing. SAFE ONLY FOR IDEMPOTENCY-AWARE DOWNSTREAMS (the at-least-once
    // contract). Only STALLED is eligible (RUNNING is in-flight; DONE/FAILED/ABORTED terminal;
    // PAUSED uses grant). Returns { run, cmd } — caller (index.js) re-enqueues, like grant.
    async function requeue({ id, byUid } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const run = await _load(id);
        if (!run) throw jsonrpc.NOT_FOUND('Run');
        if (run.status !== 'STALLED')
            throw jsonrpc.FORBIDDEN(`Only STALLED runs can be requeued (status: ${run.status})`);
        const updated = await _save({ ...run, status: 'RESUMING', requeuedBy: byUid || null, requeuedAt: Date.now() });
        return {
            run: updated,
            cmd: {
                runId: run.id,
                workflowId: run.workflowId,
                input: run.input || {},
                triggerSource: run.triggerSource,
                triggerId: run.triggerId,            // PRESERVED → re-run idempotency keys match
                trace: run.trace || null,
                parentEventId: run.parentEventId || null,
                actor: run.actor || null,            // PRESERVED → re-run passes the same actor pre-check
                actorSource: run.actorSource || null,
            },
        };
    }

    // Transition to DEADLETTER (retries exhausted or non-retriable error).
    async function deadletter(id, { error } = {}) {
        const run = await _load(id);
        if (!run) return null;
        return _save({ ...run, status: 'DEADLETTER', lastError: error || null, deadletteredAt: Date.now() });
    }

    // Grant one-shot permission and transition PAUSED → RESUMING.
    // Returns { run, grant } — caller (index.js) re-enqueues separately.
    async function grant({ id, methods, grantedBy }) {
        if (!id)      throw jsonrpc.MISSING_PARAM('id');
        if (!methods || !Array.isArray(methods) || methods.length === 0)
            throw jsonrpc.INVALID_PARAMS('methods must be a non-empty array');

        const run = await _load(id);
        if (!run) throw jsonrpc.NOT_FOUND('Run');
        if (run.status !== 'PAUSED_AWAITING_HUMAN')
            throw jsonrpc.FORBIDDEN(`Run is not paused (status: ${run.status})`);

        const grantDoc = { runId: id, methods, grantedBy: grantedBy || null, grantedAt: Date.now() };
        await redis.json.set(grantKey(id), '$', grantDoc);

        const updated = await _save({ ...run, status: 'RESUMING', grantedBy: grantedBy || null, grantedAt: Date.now() });
        return { run: updated, grant: grantDoc };
    }

    // Abort a paused run (human rejected / timed out).
    async function abort({ id, abortedBy, reason } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');

        const run = await _load(id);
        if (!run) throw jsonrpc.NOT_FOUND('Run');
        if (run.status !== 'PAUSED_AWAITING_HUMAN')
            throw jsonrpc.FORBIDDEN(`Can only abort paused runs (status: ${run.status})`);

        await redis.json.del(grantKey(id)).catch(() => {});
        return _save({ ...run, status: 'ABORTED', abortedBy: abortedBy || null, abortReason: reason || null, abortedAt: Date.now() });
    }

    // Load the one-shot grant (null if none / already cleared).
    async function getGrant(id) {
        return redis.json.get(grantKey(id));
    }

    // List run entities, optionally filtered by status.
    // Uses the run id index (SMEMBERS) — O(runs), not O(keyspace) KEYS scan.
    async function list({ status } = {}) {
        const ids = await redis.sMembers(R.runIndex);
        const runs = [];
        for (const id of ids) {
            const r = await redis.json.get(key(id));
            if (r && (!status || r.status === status)) runs.push(r);
        }
        return runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    }

    // One-time backfill of the run id index from existing docs (legacy). KEYS here
    // runs ONCE at boot, never on a hot path.
    async function rebuildIndex() {
        const ks = await redis.keys(`${R.runPrefix}*`);
        const ids = ks.filter(k => !k.endsWith(':GRANT')).map(k => k.slice(R.runPrefix.length)).filter(Boolean);
        if (ids.length) await redis.sAdd(R.runIndex, ids);
        return ids.length;
    }

    return { create, get, pause, done, fail, stall, checkpoint, compensationCheckpoint, deadletter, grant, abort, requeue, getGrant, list, rebuildIndex };
};
