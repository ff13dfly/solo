/**
 * Batch Fan-in Barrier (`api/apps/fulfillment/logic/barrier.js`)
 *
 * Implements the "Fan-out N child jobs -> Atomic Fan-in Barrier -> Single Settled Callback"
 * primitive (`fulfillment.barrier.{create,checkin,get,reap}`).
 *
 * Guarantees:
 *   1. Idempotent registration by `barrierKey` (scoped by caller `$owner`).
 *   2. Idempotent per-item check-in (`itemId` + terminal `outcome`: `DONE` | `FAILED` | `SKIPPED`).
 *   3. Exactly-once settlement: when `completedCount === expectedCount` (or when `expiresAt`
 *      is reached during `reap`), the barrier transitions from `PENDING` to `SETTLED` (or `EXPIRED`)
 *      atomically under lock + CAS and fires `onSettled` exactly once.
 *   4. Multi-target `onSettled` egress:
 *      - Local fulfillment instance transition/callback (`target: 'fulfillment'`, `instanceId`, `event`)
 *      - Local Router `_tasks` / `relay.call` (`target: 'local'`, `method`, `params`)
 *      - Cross-stack SOLO peer RPC (`target: 'peer'`, `endpoint` / `peer`, `method`, `callbackToken` / `apiKey`)
 */

const crypto = require('crypto');
const jsonrpc = require('../../../library/jsonrpc');
const { createLogger } = require('../../../library/logger');
const { walContext } = require('../../../library/entity');
const { optimisticUpdate } = require('../../../library/optimistic');
const { createPeerRelay } = require('../../../library/peer-relay');
const clock = require('../../../library/clock');

const logger = createLogger('fulfillment:barrier');

const DEFAULT_BARRIER_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_BARRIER_TTL_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EXPECTED_COUNT     = 1000;
const VALID_OUTCOMES         = new Set(['DONE', 'FAILED', 'SKIPPED']);

module.exports = (redis, config, { relay = null, instanceLogic = null } = {}) => {
    const BARRIER_PREFIX = config.redis?.barrierPrefix || 'FULFILLMENT:BARRIER:';
    const BARRIER_INDEX  = config.redis?.barrierIndex  || 'FULFILLMENT:BARRIER:INDEX';
    const barrierLocks   = new Map();

    async function withBarrierLock(key, fn) {
        const prev = barrierLocks.get(key) || Promise.resolve();
        let release;
        const next = new Promise((resolve) => { release = resolve; });
        const chain = prev.then(() => next, () => next);
        barrierLocks.set(key, chain);
        await prev.catch(() => {});
        try {
            return await fn();
        } finally {
            release();
            if (barrierLocks.get(key) === chain) {
                barrierLocks.delete(key);
            }
        }
    }

    function resolveOwner(req) {
        return walContext.getStore()?.owner || req?.constraints?.$owner || null;
    }

    function assertOwner(doc, req) {
        const owner = resolveOwner(req);
        if (owner && owner.field && doc[owner.field] !== owner.value) {
            throw jsonrpc.NOT_FOUND(`Barrier ${doc.barrierKey}`);
        }
    }

    function validateBarrierKey(barrierKey) {
        if (!barrierKey) throw jsonrpc.MISSING_PARAM('barrierKey');
        if (typeof barrierKey !== 'string' || barrierKey.length > 128 || /[\s*?\x00-\x1f]/.test(barrierKey)) {
            throw jsonrpc.INVALID_PARAM('barrierKey must be a non-empty string (<= 128 chars) without whitespace or wildcards');
        }
        return `${BARRIER_PREFIX}${barrierKey}`;
    }

    function summarizeItems(itemsMap = {}) {
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        const results = {};
        for (const [itemId, entry] of Object.entries(itemsMap)) {
            if (!entry) continue;
            if (entry.outcome === 'DONE') succeeded += 1;
            else if (entry.outcome === 'FAILED') failed += 1;
            else if (entry.outcome === 'SKIPPED') skipped += 1;
            results[itemId] = entry;
        }
        const completedCount = succeeded + failed + skipped;
        return { completedCount, succeeded, failed, skipped, results };
    }

    function formatBarrierResponse(doc, extra = {}) {
        const { completedCount, succeeded, failed, skipped, results } = summarizeItems(doc.items);
        return {
            barrierKey:     doc.barrierKey,
            status:         doc.status,
            expectedCount:  doc.expectedCount,
            completedCount,
            succeeded,
            failed,
            skipped,
            timedOut:       Boolean(doc.timedOut),
            items:          results,
            meta:           doc.meta || {},
            createdAt:      doc.createdAt,
            expiresAt:      doc.expiresAt,
            ...(doc.settledAt ? { settledAt: doc.settledAt } : {}),
            ...extra,
        };
    }

    async function dispatchOnSettled(doc, summary, req) {
        const _tasks = [];
        const onSettled = doc.onSettled;
        if (!onSettled || typeof onSettled !== 'object') {
            return { _tasks };
        }

        const settlementPayload = {
            barrierKey:     doc.barrierKey,
            status:         doc.status,
            timedOut:       Boolean(doc.timedOut),
            expectedCount:  doc.expectedCount,
            completedCount: summary.completedCount,
            succeeded:      summary.succeeded,
            failed:         summary.failed,
            skipped:        summary.skipped,
            results:        summary.results,
            meta:           doc.meta || {},
            settledAt:      doc.settledAt,
        };

        const targetType = onSettled.target || (onSettled.instanceId ? 'fulfillment' : (onSettled.endpoint || onSettled.peer ? 'peer' : 'local'));

        if (targetType === 'fulfillment' && onSettled.instanceId && instanceLogic) {
            const eventName = summary.failed > 0 && onSettled.failedEvent
                ? onSettled.failedEvent
                : (doc.timedOut && onSettled.timeoutEvent ? onSettled.timeoutEvent : (onSettled.event || 'batch_settled'));
            try {
                const effectiveReq = doc._ownerScope && doc._ownerScope.field
                    ? { ...(req || { user: 'system:barrier', permit: 'admin' }), constraints: { $owner: doc._ownerScope } }
                    : (req || { user: 'system:barrier', permit: 'admin' });
                const res = await instanceLogic.transition({
                    id:         onSettled.instanceId,
                    event:      eventName,
                    metaUpdate: {
                        ...(onSettled.metaUpdate || {}),
                        barrier: settlementPayload,
                    },
                }, effectiveReq);
                if (res && Array.isArray(res._tasks)) {
                    for (const t of res._tasks) {
                        if (t && t.method) {
                            _tasks.push({
                                service:       t.service || String(t.method).split('.')[0],
                                method:        t.method,
                                transition_id: t.transition_id || `barrier:${doc.barrierKey}`,
                                params:        t.params || {},
                            });
                        }
                    }
                }
            } catch (err) {
                logger.warn(`Barrier ${doc.barrierKey} local instance transition failed: ${err.message}`);
            }
            return { _tasks };
        }

        if (targetType === 'peer') {
            const peerName = String(onSettled.peer || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            const endpoint = onSettled.endpoint
                || (peerName && process.env[`SOLO_PEER_${peerName}_URL`])
                || process.env.SOLO_PEER_URL
                || '';
            const apiKey = onSettled.apiKey
                || (peerName && process.env[`SOLO_PEER_${peerName}_API_KEY`])
                || '';
            const token = onSettled.callbackToken
                || onSettled.token
                || (peerName && process.env[`SOLO_PEER_${peerName}_TOKEN`])
                || '';
            const user = onSettled.user || (peerName && process.env[`SOLO_PEER_${peerName}_USER`]) || '';
            const password = onSettled.password || (peerName && process.env[`SOLO_PEER_${peerName}_PASSWORD`]) || '';

            if (endpoint) {
                const peerClient = createPeerRelay({
                    endpoint,
                    apiKey,
                    token,
                    user,
                    password,
                    fetchFn: config.fetchFn,
                });
                const rpcMethod = onSettled.method || 'fulfillment.instance.callback';
                const rpcParams = onSettled.method === 'ingress.ingest'
                    ? {
                        source:     onSettled.source || 'barrier',
                        event_type: onSettled.event || 'barrier.settled',
                        idempotency_key: `barrier:${doc.barrierKey}:settled`,
                        payload:    settlementPayload,
                    }
                    : {
                        event:         summary.failed > 0 && onSettled.failedEvent ? onSettled.failedEvent : (onSettled.event || 'batch_settled'),
                        callbackToken: onSettled.callbackToken || undefined,
                        metaUpdate:    {
                            ...(onSettled.metaUpdate || {}),
                            barrier: settlementPayload,
                        },
                    };
                try {
                    await peerClient.call(rpcMethod, rpcParams, {
                        idempotencyKey: `barrier:${doc.barrierKey}:settled`,
                    });
                } catch (err) {
                    logger.warn(`Barrier ${doc.barrierKey} peer callback (${rpcMethod}) failed: ${err.message}`);
                }
            }
            return { _tasks };
        }

        if (onSettled.method) {
            _tasks.push({
                service:       onSettled.service || String(onSettled.method).split('.')[0],
                method:        onSettled.method,
                transition_id: `barrier:${doc.barrierKey}`,
                params: {
                    ...(onSettled.params || {}),
                    barrier:         settlementPayload,
                    idempotency_key: `barrier:${doc.barrierKey}:settled`,
                },
            });
        }

        return { _tasks };
    }

    return {
        /**
         * fulfillment.barrier.create — register or idempotently fetch a fan-in batch barrier.
         */
        async create({ barrierKey, expectedCount, ttlMs = DEFAULT_BARRIER_TTL_MS, onSettled = null, meta = {} } = {}, req) {
            const key = validateBarrierKey(barrierKey);
            const count = Number(expectedCount);
            if (!Number.isInteger(count) || count < 1 || count > MAX_EXPECTED_COUNT) {
                throw jsonrpc.INVALID_PARAM(`expectedCount must be an integer between 1 and ${MAX_EXPECTED_COUNT}`);
            }
            const safeTtl = Math.max(1000, Math.min(Number(ttlMs) || DEFAULT_BARRIER_TTL_MS, MAX_BARRIER_TTL_MS));
            const owner = resolveOwner(req);

            return withBarrierLock(key, async () => {
                const existingRaw = await redis.get(key);
                if (existingRaw) {
                    const existing = JSON.parse(existingRaw);
                    assertOwner(existing, req);
                    return formatBarrierResponse(existing, { deduplicated: true });
                }

                const now = clock.now();
                const expiresAt = now + safeTtl;
                const doc = {
                    barrierKey,
                    status:        'PENDING',
                    expectedCount: count,
                    items:         {},
                    onSettled:     (onSettled && typeof onSettled === 'object') ? onSettled : null,
                    meta:          (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {},
                    createdBy:     req?.user || null,
                    ...(owner && owner.field ? { [owner.field]: owner.value, _ownerScope: { field: owner.field, value: owner.value } } : {}),
                    createdAt:     now,
                    expiresAt,
                    settledAt:     null,
                    timedOut:      false,
                };

                await redis.set(key, JSON.stringify(doc), { EX: Math.ceil(safeTtl / 1000) + 86400 });
                await redis.sAdd(BARRIER_INDEX, barrierKey);
                return formatBarrierResponse(doc, { deduplicated: false });
            });
        },

        /**
         * fulfillment.barrier.checkin — record one child task's terminal outcome (`DONE` | `FAILED` | `SKIPPED`).
         * Atomically settles the barrier once `completedCount === expectedCount`.
         */
        async checkin({ barrierKey, itemId, outcome = 'DONE', result = null } = {}, req) {
            const key = validateBarrierKey(barrierKey);
            if (!itemId || typeof itemId !== 'string') {
                throw jsonrpc.MISSING_PARAM('itemId');
            }
            const normOutcome = String(outcome || 'DONE').toUpperCase();
            if (!VALID_OUTCOMES.has(normOutcome)) {
                throw jsonrpc.INVALID_PARAM(`outcome must be one of: ${Array.from(VALID_OUTCOMES).join(', ')}`);
            }

            return withBarrierLock(key, async () => {
                const initialRaw = await redis.get(key);
                if (!initialRaw) throw jsonrpc.NOT_FOUND(`Barrier ${barrierKey}`);

                let justSettled = false;

                const updated = await optimisticUpdate(redis, key, (current) => {
                    assertOwner(current, req);
                    if (current.status !== 'PENDING') {
                        return current;
                    }
                    const now = clock.now();
                    const nextItems = { ...(current.items || {}) };
                    nextItems[itemId] = {
                        itemId,
                        outcome:     normOutcome,
                        result:      result !== undefined ? result : null,
                        checkedInAt: nextItems[itemId]?.checkedInAt || now,
                        updatedAt:   now,
                    };

                    const completedCount = Object.keys(nextItems).length;
                    const reached = completedCount >= current.expectedCount;
                    if (reached) {
                        justSettled = true;
                    } else {
                        justSettled = false;
                    }

                    return {
                        ...current,
                        status:    reached ? 'SETTLED' : 'PENDING',
                        items:     nextItems,
                        settledAt: reached ? now : current.settledAt,
                    };
                });

                const summary = summarizeItems(updated.items);
                let _tasks = [];
                if (justSettled) {
                    const dispatched = await dispatchOnSettled(updated, summary, req);
                    _tasks = dispatched._tasks || [];
                    logger.info(`Barrier ${barrierKey} SETTLED (${summary.completedCount}/${updated.expectedCount}: ${summary.succeeded} done, ${summary.failed} failed, ${summary.skipped} skipped)`);
                }

                return formatBarrierResponse(updated, {
                    justSettled,
                    _tasks,
                });
            });
        },

        /**
         * fulfillment.barrier.get — inspect a barrier's current progress and child results.
         */
        async get({ barrierKey } = {}, req) {
            const key = validateBarrierKey(barrierKey);
            const raw = await redis.get(key);
            if (!raw) throw jsonrpc.NOT_FOUND(`Barrier ${barrierKey}`);
            const doc = JSON.parse(raw);
            assertOwner(doc, req);
            return formatBarrierResponse(doc);
        },

        /**
         * fulfillment.barrier.reap — sweep expired PENDING barriers and fire their `onSettled` once.
         */
        async reap({ dryRun = false, limit = 100 } = {}, req) {
            const keys = await redis.sMembers(BARRIER_INDEX);
            if (!keys || keys.length === 0) {
                return { scanned: 0, expired: 0, reaped: [], dryRun: !!dryRun, _tasks: [] };
            }

            const rows = await redis.mGet(keys.map((k) => `${BARRIER_PREFIX}${k}`));
            const owner = resolveOwner(req);
            const now = clock.now();
            const maxItems = Math.max(1, Math.min(Number(limit) || 100, 1000));

            let scanned = 0;
            let expired = 0;
            const reaped = [];
            const allTasks = [];

            for (const raw of rows) {
                if (!raw) continue;
                let doc;
                try { doc = JSON.parse(raw); } catch (_) { continue; }
                if (owner && owner.field && doc[owner.field] !== owner.value) continue;
                scanned += 1;
                if (doc.status !== 'PENDING') continue;
                if (!doc.expiresAt || now < doc.expiresAt) continue;

                expired += 1;
                if (reaped.length >= maxItems) continue;

                if (dryRun) {
                    reaped.push({
                        barrierKey:    doc.barrierKey,
                        expectedCount: doc.expectedCount,
                        completedCount: Object.keys(doc.items || {}).length,
                    });
                    continue;
                }

                const bKey = `${BARRIER_PREFIX}${doc.barrierKey}`;
                await withBarrierLock(bKey, async () => {
                    let settledNow = false;
                    const updated = await optimisticUpdate(redis, bKey, (cur) => {
                        if (!cur || cur.status !== 'PENDING') return cur;
                        settledNow = true;
                        return {
                            ...cur,
                            status:    'EXPIRED',
                            timedOut:  true,
                            settledAt: now,
                        };
                    });
                    if (settledNow && updated) {
                        const summary = summarizeItems(updated.items);
                        const dispatched = await dispatchOnSettled(updated, summary, req);
                        if (Array.isArray(dispatched._tasks)) {
                            allTasks.push(...dispatched._tasks);
                        }
                        reaped.push({
                            barrierKey:     updated.barrierKey,
                            status:         updated.status,
                            expectedCount:  updated.expectedCount,
                            completedCount: summary.completedCount,
                        });
                    }
                });
            }

            return { scanned, expired, reaped, dryRun: !!dryRun, _tasks: allTasks };
        },
    };
};
