/**
 * aml-cleanup.js — deterministic teardown for the 101 AML-pipeline suite.
 *
 * @why E2E runs against a PERSISTENT redis-stack that survives across runs, so every key a
 *      suite creates must be removed — but cleanup that deletes the WRONG key is itself a
 *      bug (it can nuke another suite's / a shared framework key). So this teardown obeys
 *      one rule: **every delete targets an EXACT key derived from the suite's scope** — no
 *      `KEYS`/`SCAN`/glob anywhere. An exact `del` can only ever remove the key named; it
 *      can never over-match a bystander. The two families whose keys are NOT
 *      deterministically reconstructable (ORCHESTRATOR:FIRED:{nondet}:{wf},
 *      and any stray dedup) are TTL'd by their writers, so they're left to expire rather
 *      than risk a broad scan-delete. Shared sets/indexes are pruned member-by-member
 *      (sRem of MY id), never deleted wholesale.
 *
 * Pure over an injected redis client (only get/set/del/sRem/sMembers/zRange/json.get) so it
 * is unit-testable against a fake redis without booting the stack (see aml-cleanup.test.js).
 *
 * @param redis  connected client (or fake)
 * @param scope  {
 *   wlKey, prevWhitelist,        // task-whitelist key + the value to RESTORE (null ⇒ delete)
 *   transitionedStream,          // the shared stream the sentinels subscribed to
 *   workflows,                   // [wfId, ...] injected by this suite
 *   profileId,                   // fulfillment profile id
 *   amlStream, webhookStream,    // this suite's own streams (exact keys)
 *   sourceName,                  // ingress source name (for INGRESS:NAME + dedup prefix)
 *   requestIds,                  // exact inbound request_ids this suite POSTed (dedup keys)
 *   lanes,                       // [{ instanceId, orderId, sentinelId }, ...]
 * }
 * @returns {Promise<{whitelist:'restored'|'cleared', deletes:number}>}
 */
async function cleanupAmlPipeline(redis, scope) {
    const {
        wlKey, prevWhitelist,
        transitionedStream,
        workflows = [],
        profileId,
        amlStream, webhookStream,
        sourceName,
        requestIds = [],
        lanes = [],
    } = scope || {};

    let deletes = 0;
    const del = async (k) => { if (k) deletes += (await redis.del(k)) || 0; };

    // 1. Task whitelist — RESTORE the saved value (NOT a blind delete). Only delete the key
    //    when there was no prior value to put back, so we never leave our override behind.
    let whitelist;
    if (wlKey) {
        if (prevWhitelist) { await redis.set(wlKey, prevWhitelist); whitelist = 'restored'; }
        else { await redis.del(wlKey); whitelist = 'cleared'; }
    }

    // 2. Injected workflows (exact) + prune them out of the shared index; then the runs they
    //    produced — filtered by workflowId so a foreign suite's run in the same index stays.
    for (const id of workflows) {
        await del(`ORCHESTRATOR:WORKFLOW:${id}`);
        await redis.sRem('ORCHESTRATOR:WORKFLOW_INDEX', id);
    }
    const runIds = await redis.sMembers('ORCHESTRATOR:RUN_INDEX').catch(() => []);
    for (const rid of runIds) {
        const run = await redis.json.get(`ORCHESTRATOR:RUN:${rid}`).catch(() => null);
        if (run && workflows.includes(run.workflowId)) {
            await del(`ORCHESTRATOR:RUN:${rid}`);
            await redis.sRem('ORCHESTRATOR:RUN_INDEX', rid);
        }
    }

    // 3. Fulfillment profile (exact) + per-lane instance / market order / sentinel — each an
    //    exact key; shared indexes/sets are pruned by sRem of MY id only.
    await del(`FULFILLMENT:PROFILE:${profileId}`);
    await redis.sRem('FULFILLMENT:PROFILE:INDEX', profileId);
    for (const lane of lanes) {
        if (lane.instanceId) {
            await del(`FULFILLMENT:INSTANCE:${lane.instanceId}`);
            await redis.sRem('FULFILLMENT:INSTANCE:INDEX', lane.instanceId);
        }
        if (lane.orderId) {
            await del(`MARKET:ORDER:${lane.orderId}`);
            await redis.sRem('MARKET:ORDER:INDEX', lane.orderId);
        }
        if (lane.sentinelId) {
            await del(`NEXUS:SENTINEL:${lane.sentinelId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', lane.sentinelId);
            if (transitionedStream) await redis.sRem(`NEXUS:SUB:${transitionedStream}`, lane.sentinelId);
            await del(`NEXUS:SENTINEL:ONLINE:${lane.sentinelId}`);
            const msgIds = await redis.zRange(`NOTIFICATION:INBOX:${lane.sentinelId}`, 0, -1).catch(() => []);
            for (const m of msgIds) await del(`NOTIFICATION:MSG:${m}`);
            await del(`NOTIFICATION:INBOX:${lane.sentinelId}`);
        }
    }

    // 4. Ingress: name index (exact) + EXACT inbound-dedup keys (request_ids are known, so no
    //    glob needed). Leftover dedup is TTL'd anyway — this just removes it immediately.
    if (sourceName) {
        await del(`INGRESS:NAME:${sourceName}`);
        for (const rid of requestIds) await del(`INGRESS:DEDUP:${sourceName}:${rid}`);
    }

    // 5. This suite's own streams (exact keys).
    await del(amlStream);
    await del(webhookStream);

    return { whitelist, deletes };
}

module.exports = { cleanupAmlPipeline };
