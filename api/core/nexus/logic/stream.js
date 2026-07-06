const { createLogger } = require('../../../library/logger');
const { walContext } = require('../../../library/entity');
const logger = createLogger('nexus-stream');

// toFix §6.2② — stable event_id for emitted decision events. Must satisfy the
// Router's EVENT_ID_RE (/^[A-Za-z0-9_-]{8,64}$/): squash other chars, clamp, pad.
function stableEventId(s) {
    const cleaned = String(s).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    return cleaned.length >= 8 ? cleaned : (cleaned + '--------').slice(0, 8);
}

/**
 * Nexus event-stream consumer.
 *
 * Reliability model (no separate worker/queue — the Redis Stream consumer group IS
 * the durable, at-least-once queue):
 *   - process a stream entry → deliver to every active subscriber
 *   - ACK only when ALL subscribers succeeded (xAck removes it from the PEL)
 *   - on failure: DO NOT ack → the entry stays pending; a per-entry attempt counter
 *     (NEXUS:RETRY:{stream}:{id}) drives exponential backoff
 *   - recoverPending() re-reads this consumer's pending ('0') after backoff and retries
 *     (also recovers entries left pending by a crash)
 *   - past maxDeliveries → park to the DLQ stream (NEXUS:DLQ) + ack, so a permanently
 *     failing entry is visible/retryable (nexus.dlq.*) instead of silently dropped or
 *     looping forever.
 * deliverEvent NEVER throws — it returns { ok } so the loop can decide ack-vs-retry.
 */
module.exports = (redis, config, { sentinelLogic, relay, assembler, identity, control }) => {
    const R = config.redis;
    const C = config.consumer;
    let stopRequested = false;

    function backoffMs(count) {
        return Math.min(C.retryBaseMs * (2 ** Math.max(0, count - 1)), C.retryMaxMs);
    }

    // Deliver one assembled event to one agent. Returns { ok, reason?, step?, skipped? }.
    // Wrapped in walContext so every relay call inside (agent.decide / event.emit /
    // notification.send) carries the triggering envelope's trace+depth — the chain
    // survives the async hop, and the Sentinel's own emit gets depth+1 at the Router.
    async function deliverEvent(args) {
        const env = args.event || {};
        return walContext.run(
            { uid: null, trace: env.trace_id || null, depth: parseInt(env.depth, 10) || 0 },
            () => deliverEventInner(args)
        );
    }

    async function deliverEventInner({ stream, agentId, agent, event, ref }) {
        // Track 1 built-in agents are invoked in-process by their host — not reachable
        // here, but that's intentional (not a failure to retry).
        if (agent.reachability === 'built-in') {
            return { ok: true, skipped: 'built-in' };
        }
        if (!relay) {
            return { ok: false, reason: 'relay not configured', step: 'config' };
        }

        // context.md v1 —— 有 context 则装配（guard / data_fetchers / prompt）；否则透传原始事件.
        let payload = event;
        if (agent.context && assembler) {
            try {
                const assembled = await assembler.assemble(agent, event, stream);
                if (assembled.skip) {
                    return { ok: true, skipped: 'guard' };   // 触发 guard 不满足 → 成功地"不投递"
                }
                payload = assembled.payload;

                // context.md §11 + §B —— autorun: nexus 作为 built-in agent runtime，装配后把
                // 渲染好的 prompt 当作 instruction 交给 agent.decide（结构化决策契约，不是自由
                // chat），产出 { decision, confidence, reason, escalate, fields? } 挂到
                // context.output 一并投递。这样 emit_when 能 gate {{output.decision}}/
                // {{output.confidence}}/{{output.escalate}}，payload_template 从 {{output.*}} 填值。
                const prompt = payload.context && payload.context.system_prompt;
                if (agent.context.autorun && prompt) {
                    // INVERTED GATE: choices/schema/threshold 来自 Sentinel 的 autorun 配置（建档时
                    // 固定），模型只负责"选一个 / 填值"，绝不命名目标。autorun=true 则无闭集（自由决策）。
                    const auto = agent.context.autorun;
                    const decideParams = {
                        instruction: prompt,
                        context: {
                            event: (payload.event && payload.event.payload) || {},
                            fetch: (payload.context && payload.context.data) || {},
                        },
                    };
                    if (auto && typeof auto === 'object') {
                        if (auto.choices) decideParams.choices = auto.choices;
                        if (auto.schema) decideParams.schema = auto.schema;
                        if (auto.confidence_threshold !== undefined) decideParams.confidence_threshold = auto.confidence_threshold;
                        if (auto.risk_tolerance !== undefined) decideParams.risk_tolerance = auto.risk_tolerance;
                    }
                    try {
                        // §1.2 write-side: run the decision under the Sentinel's OWN bot identity
                        // when it declares one (attributable; its permit must grant agent.decide —
                        // an infra method alongside user.token.refresh). A system.* Sentinel with no
                        // token degrades (caught below); it does NOT silently fall back to the broad
                        // nexus identity. Descriptive (non-system.*) authorityRole keeps the shared
                        // nexus call (legacy). (emit + notification.send below stay system.nexus by
                        // design — the event registry gates by source uid + actor carries attribution.)
                        const r = (identity && identity.isBotUid(agent.authorityRole))
                            ? await relay.callAs(await identity.getToken(agent.authorityRole), 'agent.decide', decideParams)
                            : await relay.call('agent.decide', decideParams);
                        // agent.decide is itself fail-soft (provider error ⇒ escalate, never throws),
                        // so the structured decision always drives emit; output=null only if the
                        // transport/auth call itself failed (caught below).
                        payload.context.output = r || null;
                        payload.context.model = (r && r.metadata && r.metadata.model) || null;
                    } catch (err) {
                        // transport/FORBIDDEN blip 不该丢掉已装配的上下文 —— 降级投递（output=null），不强制整条重试.
                        logger.error('event.autorun.failed', { stream, agentId, code: err.code, message: err.message });
                        payload.context.output = null;
                        payload.context.autorun_error = err.message;
                    }
                }

                // context.emit (§2.2 action loop): emit a decision event onto the bus
                // (consumed downstream by the orchestrator matcher or another Sentinel).
                // At-most-once per (ref, sentinel): the SETNX guard stops a retried
                // delivery double-firing the action; a failed emit releases the guard so
                // a retry re-emits. The notification.send copy below stays as audit trail.
                if (agent.context.emit) {
                    const toEmit = assembler.buildEmit(agent, payload);
                    if (toEmit) {
                        // toFix §6.2② — stable identity per (delivery, sentinel): if the
                        // emit reached the Router but the ack was lost, the released guard
                        // below lets a retry re-emit — the Router's EVENT:DEDUP SETNX then
                        // suppresses the duplicate by this id instead of double-firing
                        // every downstream subscriber/workflow.
                        toEmit.event_id = stableEventId(`snt-${agentId}-${ref}`);
                        const emitKey = R.emitGuardPrefix + ref + ':' + agentId;
                        const fresh = await redis.set(emitKey, '1', { NX: true, EX: C.emitGuardTtlSec });
                        if (fresh) {
                            try {
                                await relay.call('event.emit', toEmit);
                            } catch (err) {
                                await redis.del(emitKey);   // release → a retry re-emits
                                logger.error('event.emit.failed', { stream, agentId, code: err.code, message: err.message });
                                return { ok: false, reason: err.message, step: 'emit' };
                            }
                        }
                    }
                }
            } catch (err) {
                // 装配失败（如 data_fetcher abort）—— 可重试，交给 settle 决定退避/死信.
                logger.error('event.assembly.failed', { stream, agentId, code: err.code, message: err.message });
                return { ok: false, reason: err.message, step: 'assembly' };
            }
        }

        try {
            // ref = stream entry id → notification 按 (targetId, ref) 幂等去重，
            // 故重投/重试绝不重复落 inbox.
            await relay.call('notification.send', {
                targetId: agentId,
                type: stream,
                payload,
                sourceId: 'nexus',
                ref,
            });
            return { ok: true };
        } catch (err) {
            logger.error('event.route.failed', { stream, agentId, code: err.code, message: err.message });
            return { ok: false, reason: err.message, step: 'deliver' };
        }
    }

    // Best-effort activity ledger per (sentinel, outcome) — powers the portal's
    // "did this sentinel ever react?" column. Never allowed to affect delivery.
    async function recordActivity(agentId, res) {
        try {
            const akey = R.sentinelActivityPrefix + agentId;
            if (res.skipped === 'guard') {
                await redis.hIncrBy(akey, 'skipped', 1);
            } else if (res.ok && !res.skipped) {
                await redis.hIncrBy(akey, 'fired', 1);
                await redis.hSet(akey, 'lastFiredAt', String(Date.now()));
            } else if (!res.ok) {
                await redis.hIncrBy(akey, 'failed', 1);
                await redis.hSet(akey, 'lastFailedAt', String(Date.now()));
            }
        } catch (_) { /* ledger is observability, not delivery */ }
    }

    // Process one stream entry across all subscribers. Returns true iff ALL succeeded.
    async function processEntry(stream, id, message) {
        const event = parseEvent(message);
        const subscribers = await sentinelLogic.subscribersOf(stream);
        let allOk = true;
        for (const agentId of subscribers) {
            const agent = JSON.parse((await redis.get(R.sentinelPrefix + agentId)) || 'null');
            if (!agent || agent.status !== 'ACTIVE') continue;
            const res = await deliverEvent({ stream, agentId, agent, event, ref: id });
            await recordActivity(agentId, res);
            if (!res.ok) {
                allOk = false;
                logger.warn('event.deliver.fail', { stream, id, agentId, step: res.step, reason: res.reason });
            }
        }
        return allOk;
    }

    // Decide ack-vs-retry-vs-DLQ for one entry. Returns true iff it was settled (acked).
    async function settle(client, stream, id, message, allOk) {
        const retryKey = R.retryPrefix + stream + ':' + id;
        if (allOk) {
            await client.xAck(stream, R.consumerGroup, id);
            await redis.del(retryKey);
            return true;
        }
        const prev = JSON.parse((await redis.get(retryKey)) || 'null');
        const count = (prev ? prev.count : 0) + 1;
        if (count >= C.maxDeliveries) {
            await moveToDLQ(stream, id, message, count);
            await client.xAck(stream, R.consumerGroup, id);
            await redis.del(retryKey);
            logger.error('event.dlq', { stream, id, attempts: count });
            return true;
        }
        const nextAt = Date.now() + backoffMs(count);
        await redis.set(
            retryKey,
            JSON.stringify({ count, nextAt }),
            { EX: Math.ceil(C.retryMaxMs / 1000) + 3600 },
        );
        return false;   // leave pending → recoverPending retries after nextAt
    }

    async function moveToDLQ(stream, id, message, attempts) {
        await redis.xAdd(R.dlqStream, '*', {
            sourceStream: stream,
            sourceId: String(id),
            event: JSON.stringify(message),   // raw flat field map → faithful re-XADD on retry
            attempts: String(attempts),
            failedAt: String(Date.now()),
        });
    }

    // Dynamic stream discovery: the union of the default lifecycle streams and every
    // ACTIVE agent's declared eventSubscriptions. This is what lets an agent subscribe
    // to ANY event stream and have it consumed WITHOUT a nexus restart (mirrors
    // orchestrator matcher.discoverStreams — reads the bounded agent registry, no
    // keyspace scan).
    async function discoverStreams() {
        const streams = new Set(C.streams);
        const ids = await redis.sMembers(R.sentinelSet); // SAFE: small (bounded agent registry)
        if (ids.length) {
            const raws = await redis.mGet(ids.map(i => R.sentinelPrefix + i));
            for (const raw of raws) {
                if (!raw) continue;
                let a;
                try { a = JSON.parse(raw); } catch (_) { continue; }
                if (!a || a.status !== 'ACTIVE') continue;
                for (const s of (a.eventSubscriptions || [])) {
                    if (typeof s === 'string' && s) streams.add(s);
                }
            }
        }
        return [...streams];
    }

    // Streams this consumer already has a group on (in-memory; rebuilt each boot).
    const knownStreams = new Set();

    async function ensureGroups(client, streams) {
        for (const stream of streams) {
            try {
                await client.xGroupCreate(stream, R.consumerGroup, '$', { MKSTREAM: true });
                logger.info(`Created consumer group ${R.consumerGroup} on ${stream}`);
            } catch (err) {
                if (!String(err).includes('BUSYGROUP')) throw err;
            }
        }
    }

    // New ('>') entries.
    async function consumeOnce(client) {
        // Re-discover so newly-subscribed agent streams are picked up without restart.
        const current = await discoverStreams();
        const fresh = current.filter(s => !knownStreams.has(s));
        if (fresh.length) {
            await ensureGroups(client, fresh);
            fresh.forEach(s => knownStreams.add(s));
        }
        if (current.length === 0) {
            // No subscribed streams → there is nothing for the xReadGroup BLOCK below to
            // wait on, and recoverPending() also no-ops. Without an explicit idle wait the
            // consumer loop hot-spins, re-running discoverStreams (SMEMBERS) thousands of
            // times a second and burning a full CPU core. Mirror the xReadGroup BLOCK so an
            // idle nexus costs one cycle per blockMs. (Same class of bug fixed in the
            // orchestrator matcher; nexus gates on the fresh `current` set rather than
            // knownStreams because it reads from `current`, so this also covers the case
            // where every sentinel subscription was removed after streams were once known.)
            if (C.blockMs > 0) await new Promise(r => setTimeout(r, C.blockMs));
            return 0;
        }

        // Read from the freshly-discovered set so streams whose agents were removed
        // (or that were deleted) drop out immediately — the combined xReadGroup must
        // not keep referencing a stream/group that no longer exists.
        const streams = current.map(s => ({ key: s, id: '>' }));
        let result;
        try {
            result = await client.xReadGroup(
                R.consumerGroup, R.consumerName, streams,
                { COUNT: C.batchSize, BLOCK: C.blockMs },
            );
        } catch (err) {
            // A stream or its group disappeared (deleted/trimmed). One missing group
            // fails the WHOLE combined read — drop the group cache and re-sync next tick.
            if (String(err).includes('NOGROUP')) {
                knownStreams.clear();
                return 0;
            }
            throw err;
        }
        if (!result) return 0;

        let processed = 0;
        for (const { name: stream, messages } of result) {
            for (const { id, message } of messages) {
                try {
                    const allOk = await processEntry(stream, id, message);
                    await settle(client, stream, id, message, allOk);
                    if (allOk) processed++;
                } catch (err) {
                    logger.error(`Failed to process ${stream} ${id}:`, err);
                    await settle(client, stream, id, message, false);
                }
            }
        }
        return processed;
    }

    // This consumer's un-acked pending ('0') — earlier failures + crash recovery —
    // retried once their backoff has elapsed.
    async function recoverPending(client) {
        const now = Date.now();
        const current = await discoverStreams();
        for (const stream of current) {
            let result;
            try {
                result = await client.xReadGroup(
                    R.consumerGroup, R.consumerName, [{ key: stream, id: '0' }],
                    { COUNT: C.batchSize },
                );
            } catch (err) {
                if (String(err).includes('NOGROUP')) { knownStreams.delete(stream); continue; }
                throw err;
            }
            if (!result) continue;
            for (const { messages } of result) {
                for (const entry of messages) {
                    const { id, message } = entry;
                    if (!message) { await client.xAck(stream, R.consumerGroup, id); continue; } // tombstone
                    const rec = JSON.parse((await redis.get(R.retryPrefix + stream + ':' + id)) || 'null');
                    if (rec && rec.nextAt && rec.nextAt > now) continue;   // backoff not elapsed yet
                    try {
                        const allOk = await processEntry(stream, id, message);
                        await settle(client, stream, id, message, allOk);
                    } catch (err) {
                        logger.error(`Reclaim failed ${stream} ${id}:`, err);
                        await settle(client, stream, id, message, false);
                    }
                }
            }
        }
    }

    function parseEvent(message) {
        // Redis stream entries are flat string maps; lift JSON fields if present.
        const out = { ...message };
        for (const k of Object.keys(out)) {
            const v = out[k];
            if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
                try { out[k] = JSON.parse(v); } catch (_) { /* keep string */ }
            }
        }
        return out;
    }

    async function loop(client) {
        logger.info('Stream consumer started');
        while (!stopRequested) {
            try {
                // Runtime pause: stop auto-consuming/retrying events (degrade to manual).
                // Manual nexus.* RPCs (sentinel/schedule/dlq) keep working.
                if (control && await control.isPaused()) { await new Promise(r => setTimeout(r, C.blockMs)); continue; }
                await consumeOnce(client);
                await recoverPending(client);
            } catch (err) {
                logger.error('Consumer error:', err);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        logger.info('Stream consumer stopped');
    }

    async function start() {
        const client = redis.duplicate();
        await client.connect();
        const initial = await discoverStreams();
        await ensureGroups(client, initial);
        initial.forEach(s => knownStreams.add(s));
        loop(client).catch(err => logger.error('Consumer loop crashed:', err));
    }

    async function stop() {
        stopRequested = true;
    }

    return { start, stop, discoverStreams, consumeOnce };
};
