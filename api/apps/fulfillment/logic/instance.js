const jsonrpc = require('../../../library/jsonrpc');
const rules = require('./rules');
const { createLogger } = require('../../../library/logger');
const { walContext } = require('../../../library/entity');

const logger = createLogger('fulfillment:instance');

/**
 * Fulfillment Instance Logic
 * @why Implements the state machine lifecycle for a fulfillment record.
 *      Instances are custom entities (not entity factory) because state transitions
 *      require conditional logic and action dispatch beyond standard CRUD.
 */
module.exports = (redis, config, relay = null) => {

    const PREFIX = config.redis.instancePrefix;
    const INDEX  = config.redis.instanceIndex;

    async function getInstance(id) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const data = await redis.get(`${PREFIX}${id}`);
        if (!data) throw jsonrpc.NOT_FOUND(`Instance ${id}`);
        return JSON.parse(data);
    }

    async function loadProfile(profileId) {
        const raw = await redis.get(`${config.redis.profilePrefix}${profileId}`);
        if (!raw) throw jsonrpc.NOT_FOUND(`Profile ${profileId}`);
        return JSON.parse(raw);
    }

    const buildLogicData = (instance, mergedMeta, req) => ({
        instance:    { ...instance, meta: mergedMeta },
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
    async function advance({ id, event, metaUpdate = {}, skipCondition = false, forced = false, reason = null }, req) {
        if (!id)    throw jsonrpc.MISSING_PARAM('id');
        if (!event) throw jsonrpc.MISSING_PARAM('event');

        const instance  = await getInstance(id);
        const fromState  = instance.state;
        const profile    = await loadProfile(instance.profileId);

        // Activation gate (in-flight): a profile sent back to review (or rejected) must not
        // drive ANY instance — new OR in-flight — until re-approved (§7.3). Trusted
        // direct-create profiles carry no reviewState → never gated. This is what makes the
        // executable-edit re-review real: editing an APPROVED profile freezes its instances.
        if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
            throw jsonrpc.FORBIDDEN(`Profile ${instance.profileId} is not activated (reviewState: ${profile.reviewState}) — it must be (re-)approved before its instances can transition`);
        }

        // Merge metaUpdate BEFORE evaluating conditions so cached values satisfy them.
        const mergedMeta = { ...instance.meta, ...metaUpdate };
        const logicData  = buildLogicData(instance, mergedMeta, req);

        // Candidates share (event, from); they may differ by condition (branching).
        const candidates = (profile.transitions || []).filter(
            t => t.event === event && t.from === fromState
        );
        if (candidates.length === 0) {
            throw jsonrpc.INVALID_PARAM(
                `Event "${event}" not defined from state "${fromState}" in profile ${instance.profileId}`
            );
        }

        // override skips the condition gate; normal flow takes the first passing rule.
        const transitionRule = skipCondition
            ? candidates[0]
            : candidates.find(t => rules.evaluateCondition(t.condition, logicData));

        if (!transitionRule) {
            throw jsonrpc.INVALID_PARAM(`Condition not met for event "${event}"`);
        }

        const toState      = transitionRule.to;
        // transition_id: monotonic per instance (history slot). Replays reproduce
        // the same id → downstream dedupe; a fresh push (override) gets a new id.
        const transitionId = `${id}-T${instance.history.length + 1}`;

        instance.prevState      = fromState;
        instance.state          = toState;
        instance.stateChangedAt = Date.now();
        instance.meta           = mergedMeta;
        // trace: chain correlation — which causal chain drove this transition (walContext
        // carries it from the Router token meta; null for direct/un-traced callers).
        const entry = { state: toState, event, transition_id: transitionId, user: req?.user || null, trace: walContext.getStore()?.trace || null, stamp: Date.now() };
        if (forced) entry.forced = true;
        if (reason) entry.reason = reason;
        instance.history.push(entry);

        await redis.set(`${PREFIX}${id}`, JSON.stringify(instance));

        // Fire-and-forget: emit EVENT:FULFILLMENT:TRANSITIONED so orchestrator/nexus
        // sentinels can react to state changes. Emit failure must never abort the
        // transition — the state is already persisted above.
        if (relay) {
            relay.call('event.emit', {
                stream:  'EVENT:FULFILLMENT:TRANSITIONED',
                type:    'instance.transitioned',
                actor:   `fulfillment:${id}`,
                payload: {
                    instanceId:   id,
                    profileId:    instance.profileId,
                    sourceId:     instance.sourceId,
                    fromState,
                    toState,
                    event,
                    transitionId,
                    user:         req?.user || null,
                    stamp:        instance.stateChangedAt,
                },
            }).catch((err) => logger.warn(`emit EVENT:FULFILLMENT:TRANSITIONED failed (${transitionId}): ${err.message}`));
        }

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
    }

    return {
        /**
         * fulfillment.instance.create — new lifecycle record in DRAFT state.
         */
        async create({ sourceId, profileId, meta = {} }, req) {
            if (!sourceId)  throw jsonrpc.MISSING_PARAM('sourceId');
            if (!profileId) throw jsonrpc.MISSING_PARAM('profileId');

            // Activation gate: a profile still under review (or rejected) is NOT usable —
            // instances may only start on an activated profile. Trusted direct-create profiles
            // carry no reviewState → usable; submitted ones must be approved first (§7.3).
            const profile = await loadProfile(profileId);
            if (profile && profile.reviewState && profile.reviewState !== 'APPROVED') {
                throw jsonrpc.FORBIDDEN(`Profile ${profileId} is not activated (reviewState: ${profile.reviewState}) — it must be approved before instances can be created`);
            }

            const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const suffix = Math.floor(Math.random() * 9000 + 1000);
            const instanceId = `FL-${date}-${suffix}`;

            const instance = {
                id:                instanceId,
                sourceId,
                profileId,
                state:             'DRAFT',
                prevState:         null,
                stateChangedAt:    Date.now(),
                createdAt:         Date.now(),
                createdBy:         req?.user || null,
                meta,
                pending_callbacks: [],
                history: [{ state: 'DRAFT', event: null, reason: 'CREATED', user: req?.user || null, stamp: Date.now() }]
            };

            await redis.set(`${PREFIX}${instanceId}`, JSON.stringify(instance));
            await redis.sAdd(INDEX, instanceId);

            logger.info(`Instance created: ${instanceId} (profile: ${profileId})`);
            return instance;
        },

        /**
         * fulfillment.instance.get
         */
        async get({ id }) {
            return getInstance(id);
        },

        /**
         * fulfillment.instance.list — paginated, optional state/sourceId filter.
         */
        async list({ state, sourceId, limit = 50, offset = 0 } = {}) {
            const ids = await redis.sMembers(INDEX); // SAFE: bounded — one index entry per fulfillment instance
            if (!ids || ids.length === 0) return { items: [], total: 0 };

            const keys = ids.map(id => `${PREFIX}${id}`);
            const results = await redis.mGet(keys);

            let items = results.filter(r => r !== null).map(r => JSON.parse(r));
            if (state)    items = items.filter(i => i.state === state);
            if (sourceId) items = items.filter(i => i.sourceId === sourceId);
            items.sort((a, b) => b.createdAt - a.createdAt);

            const total = items.length;
            return { items: items.slice(offset, offset + limit), total };
        },

        /**
         * fulfillment.instance.transition — the core state machine. Validates the
         * JsonLogic condition and emits _tasks for downstream side effects.
         */
        async transition({ id, event, metaUpdate = {} }, req) {
            return advance({ id, event, metaUpdate, skipCondition: false }, req);
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
         * fulfillment.instance.resume — restore the instance to its prevState. This
         * is a dynamic target (the held-from state) so it bypasses rule matching.
         */
        async resume({ id }, req) {
            const instance = await getInstance(id);
            if (!instance.prevState) throw jsonrpc.INVALID_PARAM(`Instance ${id} has no prevState to resume to`);

            const fromState = instance.state;
            const toState   = instance.prevState;
            const transitionId = `${id}-T${instance.history.length + 1}`;

            instance.prevState      = fromState;
            instance.state          = toState;
            instance.stateChangedAt = Date.now();
            instance.history.push({
                state: toState, event: 'resume', transition_id: transitionId,
                reason: `resumed from ${fromState}`, user: req?.user || null, stamp: Date.now()
            });

            await redis.set(`${PREFIX}${id}`, JSON.stringify(instance));
            logger.info(`Instance ${id}: ${fromState} → ${toState} (resume, ${transitionId})`);
            return instance;
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
        async update({ id, meta, ...updates }) {
            const instance = await getInstance(id);

            delete updates.id;
            delete updates.history;
            delete updates.state;
            delete updates.prevState;

            const updated = { ...instance, ...updates, updatedAt: Date.now() };
            // meta is MERGED, not replaced — caching meta_fields.source values must
            // not drop other keys.
            if (meta && typeof meta === 'object') updated.meta = { ...instance.meta, ...meta };
            await redis.set(`${PREFIX}${id}`, JSON.stringify(updated));
            logger.info(`Instance updated: ${id}`);
            return updated;
        }
    };
};
