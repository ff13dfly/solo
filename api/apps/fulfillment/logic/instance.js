const crypto = require('crypto');
const jsonrpc = require('../../../library/jsonrpc');
const rules = require('./rules');
const { createLogger } = require('../../../library/logger');
const { walContext } = require('../../../library/entity');
const { optimisticUpdate } = require('../../../library/optimistic');
const clock = require('../../../library/clock');

const logger = createLogger('fulfillment:instance');
const DEFAULT_CALLBACK_TTL_MS = 60 * 60 * 1000;          // 1 hour
const MAX_CALLBACK_TTL_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_CALLBACKS   = 16;
const STATE_NAME_RE           = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROTO_KEYS              = new Set(['__proto__', 'constructor', 'prototype']);
// ADR-002: never persist bearer capability tokens into instance.meta / history.meta_update.
const sensitiveFields         = ['callbackToken', 'callback_token'];
const SENSITIVE_META_KEY_RE   = /^callback_?token$/i;

function stripSensitiveMeta(raw, depth = 0) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 8) return {};
    const copy = {};
    for (const [k, v] of Object.entries(raw)) {
        if (PROTO_KEYS.has(k) || sensitiveFields.includes(k) || SENSITIVE_META_KEY_RE.test(k)) continue;
        copy[k] = (v && typeof v === 'object' && !Array.isArray(v))
            ? stripSensitiveMeta(v, depth + 1)
            : v;
    }
    return copy;
}

/**
 * Fulfillment Instance Logic
 * @why Implements the state machine lifecycle for a fulfillment record.
 *      Instances are custom entities (not entity factory) because state transitions
 *      require conditional logic and action dispatch beyond standard CRUD.
 */
module.exports = (redis, config, relay = null) => {

    const PREFIX        = config.redis.instancePrefix;
    const INDEX         = config.redis.instanceIndex;
    const SOURCE_PREFIX = config.redis.sourceIndexPrefix   || 'FULFILLMENT:SOURCE:';
    const CBTOKEN_PREF  = config.redis.callbackTokenPrefix || 'FULFILLMENT:CBTOKEN:';
    const instanceLocks = new Map();

    async function withInstanceLock(key, fn) {
        const prev = instanceLocks.get(key) || Promise.resolve();
        let release;
        const next = new Promise((resolve) => { release = resolve; });
        const chain = prev.then(() => next, () => next);
        instanceLocks.set(key, chain);
        await prev.catch(() => {});
        try {
            return await fn();
        } finally {
            release();
            if (instanceLocks.get(key) === chain) {
                instanceLocks.delete(key);
            }
        }
    }

    function getInstanceKey(id) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        if (typeof id !== 'string' || id.includes(':') || /[\s*?\x00-\x1f]/.test(id)) {
            throw jsonrpc.INVALID_PARAM('id must be a valid string without colons, whitespace, or control characters');
        }
        return `${PREFIX}${id}`;
    }

    function resolveOwner(req) {
        return walContext.getStore()?.owner || req?.constraints?.$owner || null;
    }

    function sourceIndexKey(owner, profileId, sourceId) {
        const ownerScope = (owner && owner.field) ? `${owner.field}=${owner.value}` : '_';
        const tupleHash = crypto.createHash('sha256')
            .update(JSON.stringify([ownerScope, String(profileId), String(sourceId)]))
            .digest('hex')
            .slice(0, 32);
        return `${SOURCE_PREFIX}${tupleHash}`;
    }

    function emitTransitioned({ id, profileId, sourceId, fromState, toState, event, transitionId, user, stamp }) {
        if (!relay) return;
        relay.call('event.emit', {
            stream:  'EVENT:FULFILLMENT:TRANSITIONED',
            type:    'instance.transitioned',
            actor:   `fulfillment:${id}`,
            payload: {
                instanceId: id,
                profileId,
                sourceId,
                fromState,
                toState,
                event,
                transitionId,
                user: user || null,
                stamp,
            },
        }).catch((err) => logger.warn(`emit EVENT:FULFILLMENT:TRANSITIONED failed (${transitionId}): ${err.message}`));
    }

    function assertOwner(instance, req) {
        const owner = resolveOwner(req);
        if (owner && owner.field && instance[owner.field] !== owner.value) {
            throw jsonrpc.NOT_FOUND(`Instance ${instance.id}`);
        }
    }

    async function getInstance(id, req) {
        const key = getInstanceKey(id);
        const data = await redis.get(key);
        if (!data) throw jsonrpc.NOT_FOUND(`Instance ${id}`);
        const instance = JSON.parse(data);
        assertOwner(instance, req);
        return instance;
    }

    async function loadProfile(profileId) {
        const raw = await redis.get(`${config.redis.profilePrefix}${profileId}`);
        if (!raw) throw jsonrpc.NOT_FOUND(`Profile ${profileId}`);
        const profile = JSON.parse(raw);
        if (profile && profile.status === 'DELETED') {
            throw jsonrpc.NOT_FOUND(`Profile ${profileId}`);
        }
        return profile;
    }

    // `now` = epoch ms, the same shape every factory timestamp uses. Without it a profile
    // could express NO time predicate at all: a condition on `{var:'now'}` resolved to null
    // (so `now > X` was false forever — indistinguishable from "the guard rejected me"), and
    // an action's expireAt could only be baked as an absolute instant at authoring time,
    // which expires the same day on a machine meant to run for weeks.
    // Via clock.now() (not Date.now()) so a frozen test clock reaches profile conditions too.
    // (docs/feedback/done/fulfillment-actions-have-no-business-egress.md §3.2)
    const buildLogicData = (instance, mergedMeta, req) => ({
        instance:    { ...instance, meta: mergedMeta },
        now:         clock.now(),
        user:        req?.user        || null,
        permit:      req?.permit      || null,
        constraints: req?.constraints || null
    });

    const isAdmin = (req) => req?.permit === 'admin';

    /**
     * Core state-machine step shared by transition / override / cancel / hold.
     * Matches the (event, from=current state) rule, optionally skipping the
     * JsonLogic condition (override), applies the state change + history, and
     * builds idempotency-keyed _tasks. See docs/IMPLEMENTATION.md §幂等契约.
     */
    async function advance({ id, event, metaUpdate = {}, skipCondition = false, forced = false, reason = null, expectedTransitionId = null, consumeCallbackId = null }, req) {
        if (!id)    throw jsonrpc.MISSING_PARAM('id');
        if (!event) throw jsonrpc.MISSING_PARAM('event');

        const key = getInstanceKey(id);
        const safeMetaUpdate = stripSensitiveMeta(metaUpdate);

        return withInstanceLock(key, async () => {
            const initialInstance = await getInstance(id, req);
            const profile = await loadProfile(initialInstance.profileId);

            // Activation gate (in-flight): a profile sent back to review (or rejected) must not
            // drive ANY instance — new OR in-flight — until re-approved (§7.3). Trusted
            // direct-create profiles carry no reviewState → never gated. This is what makes the
            // executable-edit re-review real: editing an APPROVED profile freezes its instances.
            if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
                throw jsonrpc.FORBIDDEN(`Profile ${initialInstance.profileId} is not activated (reviewState: ${profile.reviewState}) — it must be (re-)approved before its instances can transition`);
            }

            let fromState;
            let toState;
            let transitionId;
            let transitionRule;
            let logicData;

            const instance = await optimisticUpdate(redis, key, (current) => {
                assertOwner(current, req);
                if (expectedTransitionId !== undefined && expectedTransitionId !== null) {
                    const currentTransitionId = current.history.at(-1)?.transition_id || null;
                    if (currentTransitionId !== expectedTransitionId) {
                        throw jsonrpc.INVALID_PARAM(
                            `Stale transition_id for instance ${id}: expected "${expectedTransitionId}", current is "${currentTransitionId}"`
                        );
                    }
                }

                fromState = current.state;
                if (current.suspension && !forced && event !== 'cancel_requested') {
                    const ttlSpec = profile.stateTtls && profile.stateTtls[fromState];
                    if (!ttlSpec || ttlSpec.event !== event) {
                        throw jsonrpc.INVALID_PARAM(
                            `Instance ${id} is suspended in "${fromState}" and must be resumed before transitioning`
                        );
                    }
                }
                // Merge metaUpdate BEFORE evaluating conditions so cached values satisfy them.
                const mergedMeta = { ...current.meta, ...safeMetaUpdate };
                logicData = buildLogicData(current, mergedMeta, req);

                // Candidates share (event, from); they may differ by condition (branching).
                const candidates = (profile.transitions || []).filter(
                    t => t.event === event && t.from === fromState
                );
                if (candidates.length === 0) {
                    throw jsonrpc.INVALID_PARAM(
                        `Event "${event}" not defined from state "${fromState}" in profile ${current.profileId}`
                    );
                }

                // override skips the condition gate; normal flow takes the first passing rule.
                transitionRule = skipCondition
                    ? candidates[0]
                    : candidates.find(t => rules.evaluateCondition(t.condition, logicData));

                if (!transitionRule) {
                    throw jsonrpc.INVALID_PARAM(`Condition not met for event "${event}"`);
                }

                if (!skipCondition && transitionRule.evidence) {
                    const ev = rules.evaluateEvidenceGate(transitionRule.evidence, mergedMeta);
                    if (!ev.ok) {
                        throw jsonrpc.INVALID_PARAM(
                            `Evidence gate failed for event "${event}": ${ev.violations.join('; ')}`
                        );
                    }
                }

                const now = clock.now();
                toState = transitionRule.to;
                // transition_id: monotonic per instance (history slot). Replays reproduce
                // the same id → downstream dedupe; a fresh push (override) gets a new id.
                transitionId = `${id}-T${current.history.length + 1}`;

                const prevPending = Array.isArray(current.pending_callbacks) ? current.pending_callbacks : [];
                const nextPending = prevPending.filter(
                    (cb) => cb && cb.tokenId !== consumeCallbackId && (!cb.expiresAt || cb.expiresAt > now)
                );

                const next = {
                    ...current,
                    prevState:         fromState,
                    state:             toState,
                    stateChangedAt:    now,
                    meta:              mergedMeta,
                    pending_callbacks: nextPending,
                    ...(current.suspension ? { suspension: null } : {}),
                    history:           [...current.history]
                };

                const entry = { state: toState, event, transition_id: transitionId, user: req?.user || null, trace: walContext.getStore()?.trace || null, stamp: now };
                if (Object.keys(safeMetaUpdate).length) entry.meta_update = safeMetaUpdate;
                if (forced) entry.forced = true;
                if (reason) entry.reason = reason;
                next.history.push(entry);

                return next;
            });

            // Fire-and-forget: emit EVENT:FULFILLMENT:TRANSITIONED so orchestrator/nexus
            // sentinels can react to state changes. Emit failure must never abort the
            // transition — the state is already persisted above.
            emitTransitioned({
                id,
                profileId:    instance.profileId,
                sourceId:     instance.sourceId,
                fromState,
                toState,
                event,
                transitionId,
                user:         req?.user || null,
                stamp:        instance.stateChangedAt,
            });

            // _tasks: Router async dispatch. idempotency_key inside params (a normal RPC
            // param to downstream); transition_id at top level for audit correlation.
            const _tasks = [];
            if (transitionRule.actions) {
                transitionRule.actions.forEach((action, idx) => {
                    if (action.type === 'workflow') return; // workflow actions use orchestrator's callback model
                    const resolvedParams = rules.resolveParams(action.params, logicData);
                    _tasks.push({
                        // The Router routes a _task by `service` and posts the FULL method to
                        // that service's /jsonrpc. Derive service from the method namespace when
                        // not given (matches the {method:'svc.entity.action'} profile convention).
                        service:       action.service || (action.method || '').split('.')[0],
                        method:        action.method,
                        transition_id: transitionId,
                        params: { ...resolvedParams, idempotency_key: `${transitionId}:A${idx}` }
                    });
                });
            }

            logger.info(`Instance ${id}: ${fromState} → ${toState} (${transitionId}, ${_tasks.length} tasks${forced ? ', forced' : ''})`);
            return { ...instance, _tasks };
        });
    }

    return {
        /**
         * fulfillment.instance.create — new lifecycle record in DRAFT state.
         * Optional `idempotent: true` deduplicates by (profileId, sourceId) within $owner scope.
         */
        async create({ sourceId, profileId, meta = {}, idempotent = false }, req) {
            if (!sourceId)  throw jsonrpc.MISSING_PARAM('sourceId');
            if (!profileId) throw jsonrpc.MISSING_PARAM('profileId');

            // Activation gate: a profile still under review (or rejected) is NOT usable —
            // instances may only start on an activated profile. Trusted direct-create profiles
            // carry no reviewState → usable; submitted ones must be approved first (§7.3).
            const profile = await loadProfile(profileId);
            if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
                throw jsonrpc.FORBIDDEN(`Profile ${profileId} is not activated (reviewState: ${profile.reviewState}) — it must be approved before instances can be created`);
            }

            const owner = resolveOwner(req);
            const srcKey = sourceIndexKey(owner, profileId, sourceId);

            return withInstanceLock(srcKey, async () => {
                if (idempotent) {
                    const existingId = await redis.get(srcKey);
                    if (existingId) {
                        const raw = await redis.get(getInstanceKey(existingId));
                        if (raw) {
                            const existing = JSON.parse(raw);
                            assertOwner(existing, req);
                            return { ...existing, deduplicated: true };
                        }
                    }
                    // Backfill check for pre-upgrade instances created before FULFILLMENT:SOURCE:* existed.
                    const allIds = await redis.sMembers(INDEX); // SAFE: bounded — one index entry per fulfillment instance
                    if (allIds && allIds.length > 0) {
                        const rows = await redis.mGet(allIds.map((x) => `${PREFIX}${x}`));
                        const match = rows
                            .filter(Boolean)
                            .map((r) => JSON.parse(r))
                            .find((i) => i.profileId === profileId && i.sourceId === sourceId && (!owner || !owner.field || i[owner.field] === owner.value));
                        if (match) {
                            await redis.set(srcKey, match.id);
                            return { ...match, deduplicated: true };
                        }
                    }
                }

                const now = clock.now();
                const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
                const suffix = Math.floor(Math.random() * 9000 + 1000);
                const instanceId = `FL-${date}-${suffix}`;
                const safeMeta = stripSensitiveMeta(meta);

                const instance = {
                    id:                instanceId,
                    sourceId,
                    profileId,
                    state:             'DRAFT',
                    prevState:         null,
                    stateChangedAt:    now,
                    createdAt:         now,
                    createdBy:         req?.user || null,
                    ...(owner && owner.field ? { [owner.field]: owner.value } : {}),
                    meta:              safeMeta,
                    pending_callbacks: [],
                    history: [{
                        state: 'DRAFT',
                        event: null,
                        transition_id: `${instanceId}-T0`,
                        reason: 'CREATED',
                        user: req?.user || null,
                        stamp: now,
                    }]
                };

                if (idempotent) {
                    const claimed = await redis.set(srcKey, instanceId, { NX: true });
                    if (!claimed) {
                        const winnerId = await redis.get(srcKey);
                        if (winnerId) {
                            const winnerRaw = await redis.get(getInstanceKey(winnerId));
                            if (winnerRaw) return { ...JSON.parse(winnerRaw), deduplicated: true };
                        }
                    }
                }
                await redis.set(getInstanceKey(instanceId), JSON.stringify(instance));
                await redis.sAdd(INDEX, instanceId);
                if (!idempotent) {
                    await redis.set(srcKey, instanceId, { NX: true });
                }

                logger.info(`Instance created: ${instanceId} (profile: ${profileId})`);
                return instance;
            });
        },

        /**
         * fulfillment.instance.get
         */
        async get({ id } = {}, req) {
            return getInstance(id, req);
        },

        /**
         * fulfillment.instance.list — paginated, optional state/sourceId/profileId/stateChangedBefore filter.
         */
        async list({ state, sourceId, profileId, stateChangedBefore, limit = 50, offset = 0 } = {}, req) {
            const ids = await redis.sMembers(INDEX); // SAFE: bounded — one index entry per fulfillment instance
            if (!ids || ids.length === 0) return { items: [], total: 0 };

            const keys = ids.map(id => `${PREFIX}${id}`);
            const results = await redis.mGet(keys);

            let items = results.filter(r => r !== null).map(r => JSON.parse(r));
            const owner = resolveOwner(req);
            if (owner && owner.field) items = items.filter(i => i[owner.field] === owner.value);
            if (state)     items = items.filter(i => i.state === state);
            if (sourceId)  items = items.filter(i => i.sourceId === sourceId);
            if (profileId) items = items.filter(i => i.profileId === profileId);
            if (Number.isFinite(stateChangedBefore)) items = items.filter(i => i.stateChangedAt <= stateChangedBefore);
            items.sort((a, b) => b.createdAt - a.createdAt);

            const total = items.length;
            return { items: items.slice(offset, offset + limit), total };
        },

        /**
         * fulfillment.instance.transition — the core state machine. Validates the
         * JsonLogic condition and emits _tasks for downstream side effects.
         *
         * `meta` is accepted as an alias for `metaUpdate`: create/update take `meta`,
         * so callers write `meta` here from muscle memory — and since undeclared
         * params are neither rejected nor logged, the field just vanished (colony ran
         * a mirror for a day with closeReason/realizedPnl silently dropped; the state
         * machine, events and history all looked green because nothing reads meta
         * until someone does — docs/feedback/done/fulfillment-transition-metaupdate-naming-trap.md).
         * Both names carry the same merge-into-instance.meta semantics, so the alias
         * is safe; `metaUpdate` stays canonical (it says "merge", not "replace").
         */
        async transition({ id, event, metaUpdate, meta, expectedTransitionId }, req) {
            return advance({ id, event, metaUpdate: metaUpdate ?? meta ?? {}, skipCondition: false, expectedTransitionId }, req);
        },

        /**
         * fulfillment.instance.cancel — business-semantic cancel. Writes the reason
         * to meta and fires the profile's `cancel_requested` event (which must be
         * defined as a transition from the current state).
         */
        async cancel({ id, reason, notifyCustomer = false }, req) {
            if (!reason) throw jsonrpc.MISSING_PARAM('reason');
            return advance({
                id, event: 'cancel_requested',
                metaUpdate: { cancel_reason: reason, notify_customer: !!notifyCustomer }
            }, req);
        },

        /**
         * fulfillment.instance.hold — pause the lifecycle. Fires `hold_requested`;
         * prevState is recorded so resume() can restore it.
         */
        async hold({ id, reason, expectedResume = null }, req) {
            if (!reason) throw jsonrpc.MISSING_PARAM('reason');
            return advance({
                id, event: 'hold_requested',
                metaUpdate: { hold_reason: reason, expected_resume: expectedResume }
            }, req);
        },

        /**
         * fulfillment.instance.suspend — orthogonal breakpoint stack for RPA / human-in-the-loop
         * intervention (CAPTCHA, OTP/QR scan, DOM drift). Enters `suspendState` (default
         * `ASSIST_REQUIRED`) from ANY active state without requiring N×M `transitions` rules,
         * saving `blockedState` + `checkpoint` so `resume` returns to the exact interrupted state.
         */
        async suspend({
            id,
            reason,
            reasonCode = 'MANUAL_INTERVENTION',
            suspendState = 'ASSIST_REQUIRED',
            checkpoint = null,
            aiSuggestion = null,
            metaUpdate,
            meta,
            expectedTransitionId = null,
        } = {}, req) {
            if (!id)     throw jsonrpc.MISSING_PARAM('id');
            if (!reason) throw jsonrpc.MISSING_PARAM('reason');
            const targetState = suspendState || 'ASSIST_REQUIRED';
            if (typeof targetState !== 'string' || !STATE_NAME_RE.test(targetState)) {
                throw jsonrpc.INVALID_PARAM(`suspendState must match ${STATE_NAME_RE}`);
            }
            const rawMeta = metaUpdate ?? meta ?? {};
            const safeMetaUpdate = stripSensitiveMeta(rawMeta);
            const key = getInstanceKey(id);

            return withInstanceLock(key, async () => {
                const initialInstance = await getInstance(id, req);
                const profile = await loadProfile(initialInstance.profileId);
                if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
                    throw jsonrpc.FORBIDDEN(`Profile ${initialInstance.profileId} is not activated (reviewState: ${profile.reviewState}) — it must be (re-)approved before its instances can suspend`);
                }
                const profileTransitions = Array.isArray(profile && profile.transitions) ? profile.transitions : [];
                const businessStates = new Set();
                for (const t of profileTransitions) {
                    if (t && t.from) businessStates.add(t.from);
                    if (t && t.to) businessStates.add(t.to);
                }
                if (targetState !== 'ASSIST_REQUIRED' && businessStates.has(targetState)) {
                    throw jsonrpc.INVALID_PARAM(
                        `suspendState "${targetState}" collides with a declared business state in profile ${initialInstance.profileId}`
                    );
                }

                let fromState;
                let transitionId;

                const instance = await optimisticUpdate(redis, key, (current) => {
                    assertOwner(current, req);
                    const lastEntry = Array.isArray(current.history) ? current.history.at(-1) : null;
                    if (expectedTransitionId !== undefined && expectedTransitionId !== null) {
                        const currentTransitionId = lastEntry?.transition_id || null;
                        if (currentTransitionId !== expectedTransitionId) {
                            throw jsonrpc.INVALID_PARAM(
                                `Stale transition_id for instance ${id}: expected "${expectedTransitionId}", current is "${currentTransitionId}"`
                            );
                        }
                    }
                    if (current.state === 'CANCELLED' || current.state === 'COMPLETED') {
                        throw jsonrpc.INVALID_PARAM(`Instance ${id} is in terminal state ${current.state} and cannot be suspended`);
                    }
                    if (profileTransitions.length > 0 && !profileTransitions.some((t) => t && t.from === current.state)) {
                        throw jsonrpc.INVALID_PARAM(`Instance ${id} is in terminal state ${current.state} (no outgoing transitions) and cannot be suspended`);
                    }
                    if (current.suspension || current.state === targetState) {
                        throw jsonrpc.INVALID_PARAM(`Instance ${id} is already suspended in ${current.state}`);
                    }
                    if (lastEntry && lastEntry.event === 'hold_requested') {
                        throw jsonrpc.INVALID_PARAM(`Instance ${id} is currently on hold (${current.state}) and must be resumed before suspending`);
                    }

                    const now = clock.now();
                    fromState = current.state;
                    transitionId = `${id}-T${current.history.length + 1}`;
                    const mergedMeta = { ...current.meta, ...safeMetaUpdate };
                    const suspension = {
                        blockedState: fromState,
                        suspendState: targetState,
                        reasonCode:   reasonCode || 'MANUAL_INTERVENTION',
                        reason,
                        checkpoint:   (checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)) ? checkpoint : null,
                        aiSuggestion: aiSuggestion || null,
                        suspendedAt:  now,
                        suspendedBy:  req?.user || null,
                        transitionId,
                    };

                    const entry = {
                        state:         targetState,
                        event:         'suspend',
                        transition_id: transitionId,
                        reason,
                        reason_code:   suspension.reasonCode,
                        user:          req?.user || null,
                        trace:         walContext.getStore()?.trace || null,
                        stamp:         now,
                    };
                    if (suspension.checkpoint) entry.checkpoint = suspension.checkpoint;
                    if (Object.keys(safeMetaUpdate).length) entry.meta_update = safeMetaUpdate;

                    return {
                        ...current,
                        prevState:      fromState,
                        state:          targetState,
                        stateChangedAt: now,
                        suspension,
                        meta:           mergedMeta,
                        history:        [...current.history, entry],
                    };
                });

                emitTransitioned({
                    id,
                    profileId:    instance.profileId,
                    sourceId:     instance.sourceId,
                    fromState,
                    toState:      targetState,
                    event:        'suspend',
                    transitionId,
                    user:         req?.user || null,
                    stamp:        instance.stateChangedAt,
                });

                logger.info(`Instance ${id}: ${fromState} → ${targetState} (suspend:${reasonCode}, ${transitionId})`);
                return instance;
            });
        },

        /**
         * fulfillment.instance.resume — restore a suspended (`suspend()`) or held (`hold()`)
         * instance back to its blockedState / prevState. Accepts optional `resolution` and
         * `metaUpdate` (`meta` alias) so human assist context feeds the next transition guard.
         */
        async resume({ id, resolution = null, metaUpdate, meta, expectedTransitionId = null } = {}, req) {
            const key = getInstanceKey(id);
            const rawMeta = metaUpdate ?? meta ?? {};
            const safeMetaUpdate = stripSensitiveMeta(rawMeta);

            return withInstanceLock(key, async () => {
                const initialInstance = await getInstance(id, req);
                const initialLastEntry = Array.isArray(initialInstance.history) ? initialInstance.history.at(-1) : null;
                const isSuspended = Boolean(initialInstance.suspension && initialInstance.suspension.blockedState);
                const isHeld = Boolean(initialInstance.prevState && initialLastEntry && initialLastEntry.event === 'hold_requested');
                if (!isSuspended && !isHeld) {
                    throw jsonrpc.INVALID_PARAM(`Instance ${id} is not in a held state or suspended state and cannot be resumed`);
                }

                const profile = await loadProfile(initialInstance.profileId);
                if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
                    throw jsonrpc.FORBIDDEN(`Profile ${initialInstance.profileId} is not activated (reviewState: ${profile.reviewState}) — it must be (re-)approved before its instances can resume`);
                }

                let fromState;
                let toState;
                let transitionId;

                const instance = await optimisticUpdate(redis, key, (current) => {
                    assertOwner(current, req);
                    const lastEntry = Array.isArray(current.history) ? current.history.at(-1) : null;
                    const curSuspended = Boolean(current.suspension && current.suspension.blockedState);
                    const curHeld = Boolean(current.prevState && lastEntry && lastEntry.event === 'hold_requested');
                    if (!curSuspended && !curHeld) {
                        throw jsonrpc.INVALID_PARAM(`Instance ${id} is not in a held state or suspended state and cannot be resumed`);
                    }
                    if (expectedTransitionId !== undefined && expectedTransitionId !== null) {
                        const currentTransitionId = lastEntry?.transition_id || null;
                        if (currentTransitionId !== expectedTransitionId) {
                            throw jsonrpc.INVALID_PARAM(
                                `Stale transition_id for instance ${id}: expected "${expectedTransitionId}", current is "${currentTransitionId}"`
                            );
                        }
                    }

                    const now = clock.now();
                    fromState = current.state;
                    toState   = curSuspended ? current.suspension.blockedState : current.prevState;
                    transitionId = `${id}-T${current.history.length + 1}`;

                    const mergedMeta = {
                        ...current.meta,
                        ...safeMetaUpdate,
                        ...(resolution ? { last_assist_resolution: resolution } : {}),
                    };
                    const entry = {
                        state:         toState,
                        event:         'resume',
                        transition_id: transitionId,
                        reason:        resolution || `resumed from ${fromState}`,
                        user:          req?.user || null,
                        trace:         walContext.getStore()?.trace || null,
                        stamp:         now,
                    };
                    if (resolution) entry.resolution = resolution;
                    if (Object.keys(safeMetaUpdate).length) entry.meta_update = safeMetaUpdate;

                    return {
                        ...current,
                        prevState:      fromState,
                        state:          toState,
                        stateChangedAt: now,
                        ...(curSuspended ? { suspension: null } : {}),
                        meta:           mergedMeta,
                        history:        [...current.history, entry],
                    };
                });

                emitTransitioned({
                    id,
                    profileId:    instance.profileId,
                    sourceId:     instance.sourceId,
                    fromState,
                    toState,
                    event:        'resume',
                    transitionId,
                    user:         req?.user || null,
                    stamp:        instance.stateChangedAt,
                });

                logger.info(`Instance ${id}: ${fromState} → ${toState} (resume, ${transitionId})`);
                return instance;
            });
        },

        /**
         * fulfillment.instance.reap — sweep instances whose current state exceeded
         * `profile.stateTtls[state].ttlMs` and fire the declared timeout transition event.
         */
        async reap({ profileId = null, dryRun = false, limit = config.pageSize || 100 } = {}, req) {
            const ids = await redis.sMembers(INDEX); // SAFE: bounded — one index entry per fulfillment instance
            if (!ids || ids.length === 0) {
                return { scanned: 0, expired: 0, reaped: [], skipped: [], dryRun: !!dryRun, _tasks: [] };
            }

            const rows = await redis.mGet(ids.map((x) => `${PREFIX}${x}`));
            let items = rows.filter(Boolean).map((r) => JSON.parse(r));
            const owner = resolveOwner(req);
            if (owner && owner.field) items = items.filter((i) => i[owner.field] === owner.value);
            if (profileId) items = items.filter((i) => i.profileId === profileId);

            const scanned = items.length;
            const maxItems = Math.max(1, Math.min(Number(limit) || config.pageSize || 100, 1000));
            const profileCache = new Map();
            const now = clock.now();

            const reaped = [];
            const skipped = [];
            const reapedTasks = [];
            let expired = 0;

            for (const inst of items) {
                if (reaped.length >= maxItems) break;
                let prof = profileCache.get(inst.profileId);
                if (prof === undefined) {
                    try {
                        prof = await loadProfile(inst.profileId);
                    } catch (_) {
                        prof = null;
                    }
                    profileCache.set(inst.profileId, prof);
                }
                if (!prof || (prof.reviewState && prof.reviewState !== 'APPROVED')) continue;
                const spec = prof.stateTtls && prof.stateTtls[inst.state];
                if (!spec || typeof spec.ttlMs !== 'number' || spec.ttlMs <= 0 || !spec.event) continue;

                const ageMs = now - (inst.stateChangedAt || inst.createdAt || now);
                if (ageMs < spec.ttlMs) continue;

                expired += 1;
                if (dryRun) {
                    reaped.push({
                        id:        inst.id,
                        profileId: inst.profileId,
                        fromState: inst.state,
                        event:     spec.event,
                        ageMs,
                    });
                    continue;
                }

                try {
                    const expectedTid = inst.history.at(-1)?.transition_id ?? null;
                    const res = await advance({
                        id:                   inst.id,
                        event:                spec.event,
                        reason:               spec.reason || `state TTL exceeded (${spec.ttlMs}ms)`,
                        metaUpdate:           { timed_out_from: inst.state, timed_out_at: now, timed_out_age_ms: ageMs },
                        expectedTransitionId: expectedTid,
                    }, req || { user: 'system:reaper', permit: 'admin' });
                    reaped.push({
                        id:           inst.id,
                        profileId:    inst.profileId,
                        fromState:    inst.state,
                        toState:      res.state,
                        event:        spec.event,
                        transitionId: res.history.at(-1)?.transition_id || null,
                    });
                    if (Array.isArray(res._tasks) && res._tasks.length > 0) {
                        reapedTasks.push(...res._tasks);
                    }
                } catch (err) {
                    skipped.push({ id: inst.id, reason: err && err.message ? err.message : String(err) });
                }
            }

            return { scanned, expired, reaped, skipped, dryRun: !!dryRun, _tasks: reapedTasks };
        },

        /**
         * fulfillment.instance.token.issue — mint a single-use capability callback token
         * scoped to ONE instance + `allowedEvents` + optional `expectedTransitionId`.
         */
        token: {
            async issue({ id, allowedEvents, ttlMs = DEFAULT_CALLBACK_TTL_MS, bindCurrentTransition = true } = {}, req) {
                if (!id) throw jsonrpc.MISSING_PARAM('id');
                if (!Array.isArray(allowedEvents) || allowedEvents.length === 0 || allowedEvents.some((e) => typeof e !== 'string' || !e.trim())) {
                    throw jsonrpc.INVALID_PARAM('allowedEvents must be a non-empty array of event strings');
                }
                const cleanEvents = Array.from(new Set(allowedEvents.map((e) => e.trim())));
                const safeTtl = Math.max(1000, Math.min(Number(ttlMs) || DEFAULT_CALLBACK_TTL_MS, MAX_CALLBACK_TTL_MS));
                const key = getInstanceKey(id);

                return withInstanceLock(key, async () => {
                    const initialInstance = await getInstance(id, req);
                    const profile = await loadProfile(initialInstance.profileId);
                    if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
                        throw jsonrpc.FORBIDDEN(`Profile ${initialInstance.profileId} is not activated (reviewState: ${profile.reviewState})`);
                    }
                    const declaredEvents = new Set((profile.transitions || []).map((t) => t && t.event).filter(Boolean));
                    for (const ev of cleanEvents) {
                        if (!declaredEvents.has(ev)) {
                            throw jsonrpc.INVALID_PARAM(`Event "${ev}" does not exist in profile ${initialInstance.profileId}`);
                        }
                    }

                    const rawToken = `flcb_${crypto.randomBytes(24).toString('hex')}`;
                    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
                    const tokenId = `cbt_${tokenHash.slice(0, 12)}`;
                    const now = clock.now();
                    const expiresAt = now + safeTtl;
                    const owner = resolveOwner(req);
                    let expectedTransitionId = null;

                    await optimisticUpdate(redis, key, (current) => {
                        assertOwner(current, req);
                        if (current.state === 'CANCELLED' || current.state === 'COMPLETED') {
                            throw jsonrpc.INVALID_PARAM(`Cannot issue callback token for terminal instance ${id} (${current.state})`);
                        }
                        expectedTransitionId = bindCurrentTransition
                            ? (current.history.at(-1)?.transition_id || null)
                            : null;
                        const liveCallbacks = (Array.isArray(current.pending_callbacks) ? current.pending_callbacks : [])
                            .filter((cb) => cb && (!cb.expiresAt || cb.expiresAt > now))
                            .slice(-(MAX_PENDING_CALLBACKS - 1));
                        return {
                            ...current,
                            pending_callbacks: [
                                ...liveCallbacks,
                                { tokenId, allowedEvents: cleanEvents, expectedTransitionId, createdAt: now, expiresAt },
                            ],
                        };
                    });

                    const tokenRecord = {
                        tokenId,
                        instanceId: id,
                        profileId:  initialInstance.profileId,
                        allowedEvents: cleanEvents,
                        expectedTransitionId,
                        owner:      owner || null,
                        issuedBy:   req?.user || null,
                        createdAt:  now,
                        expiresAt,
                    };
                    await redis.set(`${CBTOKEN_PREF}${tokenHash}`, JSON.stringify(tokenRecord), { EX: Math.ceil(safeTtl / 1000) });

                    return {
                        callbackToken: rawToken,
                        tokenId,
                        instanceId: id,
                        allowedEvents: cleanEvents,
                        expiresAt,
                        ...(expectedTransitionId ? { expectedTransitionId } : {}),
                    };
                });
            },
        },

        /**
         * fulfillment.instance.callback — PUBLIC endpoint guarded by a single-use capability
         * token (`Authorization: Bearer flcb_...` header or `params.callbackToken`).
         */
        async callback({ event, metaUpdate, meta, callbackToken } = {}, req) {
            if (!event) throw jsonrpc.MISSING_PARAM('event');
            const rawToken = (req && req.callbackToken) || callbackToken;
            if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
                throw jsonrpc.UNAUTHORIZED();
            }

            const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
            const tokenKey = `${CBTOKEN_PREF}${tokenHash}`;
            const peekRaw = await redis.get(tokenKey);
            if (!peekRaw) throw jsonrpc.UNAUTHORIZED();

            let rec;
            try {
                rec = JSON.parse(peekRaw);
            } catch (_) {
                await redis.del(tokenKey);
                throw jsonrpc.UNAUTHORIZED();
            }

            const now = clock.now();
            if (rec.expiresAt && now >= rec.expiresAt) {
                await redis.del(tokenKey);
                throw jsonrpc.UNAUTHORIZED();
            }
            if (!Array.isArray(rec.allowedEvents) || !rec.allowedEvents.includes(event)) {
                throw jsonrpc.FORBIDDEN(`Event "${event}" is not permitted by this callback token`);
            }

            // Atomic single-use consumption: native Redis GETDEL in production; SET NX claim + DEL in unit mocks.
            if (typeof redis.getDel === 'function') {
                const claimedRaw = await redis.getDel(tokenKey);
                if (!claimedRaw) throw jsonrpc.UNAUTHORIZED();
            } else {
                const claimed = await redis.set(`${tokenKey}:CLAIMED`, '1', { NX: true, EX: 60 });
                if (!claimed) throw jsonrpc.UNAUTHORIZED();
                await redis.del(tokenKey);
            }

            const cbReq = {
                user:        `callback:${rec.tokenId}`,
                permit:      'callback',
                constraints: rec.owner ? { $owner: rec.owner } : null,
            };

            try {
                return await advance({
                    id:                   rec.instanceId,
                    event,
                    metaUpdate:           metaUpdate ?? meta ?? {},
                    expectedTransitionId: rec.expectedTransitionId ?? null,
                    consumeCallbackId:    rec.tokenId,
                }, cbReq);
            } catch (err) {
                // If the instance is still at the bound transition_id and the token hasn't expired
                // (e.g. evidence gate or condition rejected the payload), restore the token so the
                // RPA caller can fix its payload and retry. Otherwise prune pending_callbacks.
                try {
                    const instKey = getInstanceKey(rec.instanceId);
                    const rawCur = await redis.get(instKey);
                    const cur = rawCur ? JSON.parse(rawCur) : null;
                    const curTid = cur && Array.isArray(cur.history) ? (cur.history.at(-1)?.transition_id || null) : null;
                    const remainingMs = (rec.expiresAt || 0) - clock.now();
                    const stillValidForRetry = cur && remainingMs > 0 && (!rec.expectedTransitionId || curTid === rec.expectedTransitionId);
                    if (stillValidForRetry) {
                        await redis.set(tokenKey, JSON.stringify(rec), { EX: Math.max(1, Math.ceil(remainingMs / 1000)) });
                        if (typeof redis.getDel !== 'function') {
                            await redis.del(`${tokenKey}:CLAIMED`);
                        }
                    } else {
                        await optimisticUpdate(redis, instKey, (c) => ({
                            ...c,
                            pending_callbacks: (Array.isArray(c.pending_callbacks) ? c.pending_callbacks : [])
                                .filter((cb) => cb && cb.tokenId !== rec.tokenId),
                        }));
                    }
                } catch (_) { /* best-effort recovery/cleanup */ }
                throw err;
            }
        },

        /**
         * fulfillment.instance.override — admin force-advance, skipping the JsonLogic
         * condition. Records a `forced` history marker. Requires admin permit.
         */
        async override({ id, event, reason }, req) {
            if (!isAdmin(req)) throw jsonrpc.FORBIDDEN('override requires admin permit');
            if (!reason)       throw jsonrpc.MISSING_PARAM('reason');
            return advance({ id, event, skipCondition: true, forced: true, reason }, req);
        },

        /**
         * fulfillment.instance.update — metadata/field update (restricted fields blocked).
         */
        async update({ id, meta, expectedTransitionId } = {}, req) {
            const key = getInstanceKey(id);

            return withInstanceLock(key, async () => {
                await getInstance(id, req);

                const updated = await optimisticUpdate(redis, key, (current) => {
                    assertOwner(current, req);
                    if (expectedTransitionId !== undefined && expectedTransitionId !== null) {
                        const currentTransitionId = current.history.at(-1)?.transition_id || null;
                        if (currentTransitionId !== expectedTransitionId) {
                            throw jsonrpc.INVALID_PARAM(
                                `Stale transition_id for instance ${id}: expected "${expectedTransitionId}", current is "${currentTransitionId}"`
                            );
                        }
                    }

                    // updatedBy: this is the ONLY write path for meta that leaves no history entry,
                    // and meta is what the JsonLogic guards judge — so "a probe wrote this fact" vs
                    // "a human edited it" was previously indistinguishable. create/advance both take
                    // req and record createdBy / history[].user; update was the odd one out even
                    // though index.js has been passing req in all along.
                    const next = { ...current, updatedBy: req?.user || null, updatedAt: clock.now() };
                    // meta is MERGED, not replaced — caching meta_fields.source values must
                    // not drop other keys.
                    if (meta && typeof meta === 'object' && !Array.isArray(meta)) next.meta = { ...current.meta, ...stripSensitiveMeta(meta) };
                    return next;
                });

                logger.info(`Instance updated: ${id}`);
                return updated;
            });
        }
    };
};
