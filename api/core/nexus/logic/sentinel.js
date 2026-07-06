const crypto = require('crypto');
const { createLogger } = require('../../../library/logger');
const jsonrpc = require('../handlers/jsonrpc');
const { validateContext } = require('./context');

const logger = createLogger('nexus');

function generateId(length = 12) {
    return crypto.randomBytes(Math.ceil(length * 0.75)).toString('base64')
        .replace(/[+/=]/g, '').slice(0, length);
}

/**
 * Sentinel logic — an event-subscribed, declarative, optionally-AI-backed reactor.
 * A Sentinel subscribes to event streams; on a matching event nexus assembles its
 * context (guard / data_fetchers / system_prompt) and, if autorun, invokes the
 * `agent` LLM service (agent.decide — the structured decision contract) before
 * delivering. (The `agent` service is the model hub — distinct from this Sentinel entity.)
 */
module.exports = (redis, config, { relay, identity } = {}) => {
    const R = config.redis;

    // §1.2 — config-time pre-audit: if a Sentinel runs under its own bot identity
    // (system.* authorityRole) and declares data_fetchers, verify those methods are
    // within its bot permit up front. Only runs when a token is already provisioned;
    // otherwise the Router enforces at runtime (best-effort fail-fast).
    async function preauditFetchers(authorityRole, context) {
        if (!identity || !context) return;
        if (!identity.isBotUid(authorityRole) || !(await identity.hasToken(authorityRole))) return;
        const methods = [];
        if (Array.isArray(context.data_fetchers)) methods.push(...context.data_fetchers.map(f => f.method));
        // write-side: autorun runs agent.decide under this same bot identity, so the
        // decision method is pre-audited against the bot permit too (§1.2 least-privilege).
        if (context.autorun) methods.push('agent.decide');
        if (methods.length) await identity.preauditMethods(authorityRole, methods);
    }

    function applyWebhookGuard(reachability, webhookUrl) {
        if (reachability === 'webhook' && !webhookUrl) {
            throw jsonrpc.INVALID_PARAMS('webhookUrl required for webhook reachability');
        }
    }

    // Create the consumer group on each subscribed stream NOW (from '$', MKSTREAM) so
    // events emitted after this returns are captured — the stream consumer discovers the
    // stream on its next tick and reads them via '>'. Without this, events in the
    // subscribe→discover window would be lost.
    async function ensureGroups(streams) {
        for (const stream of streams) {
            try {
                await redis.xGroupCreate(stream, R.consumerGroup, '$', { MKSTREAM: true });
            } catch (e) {
                if (!String(e).includes('BUSYGROUP')) throw e;
            }
        }
    }

    async function create({
        name,
        authorityRole,
        eventSubscriptions = [],
        reachability = null,
        webhookUrl = null,
        description = null,
        track = 'internal',
        context = null
    } = {}) {
        if (!name)          throw jsonrpc.MISSING_PARAM('name');
        if (!authorityRole) throw jsonrpc.MISSING_PARAM('authorityRole');
        applyWebhookGuard(reachability, webhookUrl);

        // context.md v1 —— 声明式上下文装配的静态校验（只读后缀 + DAG 无环）.
        validateContext(context);
        // §1.2 —— 若 Sentinel 走自身 bot 身份，预审声明的 fetcher 方法 ⊆ 该 bot permit.
        await preauditFetchers(authorityRole, context);

        const id = generateId(config.idLengths.sentinel);

        const profile = {
            id,
            name,
            description,
            authorityRole,
            track,
            eventSubscriptions,
            reachability,
            webhookUrl,
            context: context || null,
            status: 'ACTIVE',
            lastSeenAt: null,
            createdAt: Date.now()
        };

        const multi = redis.multi();
        multi.set(R.sentinelPrefix + id, JSON.stringify(profile));
        multi.sAdd(R.sentinelSet, id);
        for (const stream of eventSubscriptions) {
            multi.sAdd(R.subscriptionPrefix + stream, id);
        }
        await multi.exec();
        await ensureGroups(eventSubscriptions);

        return { id, name, authorityRole, status: profile.status };
    }

    /**
     * Update a Sentinel's mutable fields (only the keys provided are changed). When
     * eventSubscriptions change, the NEXUS:SUB:* sets are re-synced and a consumer
     * group is established on each newly-added stream (so it's consumed immediately).
     */
    async function update({ id, name, description, authorityRole, reachability, webhookUrl, eventSubscriptions, context, track } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const key = R.sentinelPrefix + id;
        const raw = await redis.get(key);
        if (!raw) throw jsonrpc.NOT_FOUND(`sentinel ${id}`);
        const profile = JSON.parse(raw);

        if (context !== undefined) validateContext(context);
        // §1.2 —— 预审更新后的 fetcher（用更新后的 authorityRole + context 组合）.
        if (context !== undefined) {
            const effRole = authorityRole !== undefined ? authorityRole : profile.authorityRole;
            await preauditFetchers(effRole, context);
        }
        const nextReach = reachability !== undefined ? reachability : profile.reachability;
        const nextUrl   = webhookUrl  !== undefined ? webhookUrl  : profile.webhookUrl;
        applyWebhookGuard(nextReach, nextUrl);

        const oldSubs = profile.eventSubscriptions || [];
        const newSubs = eventSubscriptions !== undefined ? eventSubscriptions : oldSubs;

        if (name          !== undefined) profile.name = name;
        if (description    !== undefined) profile.description = description;
        if (authorityRole  !== undefined) profile.authorityRole = authorityRole;
        if (track          !== undefined) profile.track = track;
        if (reachability   !== undefined) profile.reachability = reachability;
        if (webhookUrl     !== undefined) profile.webhookUrl = webhookUrl;
        if (context        !== undefined) profile.context = context || null;
        if (eventSubscriptions !== undefined) profile.eventSubscriptions = eventSubscriptions;
        profile.updatedAt = Date.now();

        const added   = newSubs.filter(s => !oldSubs.includes(s));
        const removed = oldSubs.filter(s => !newSubs.includes(s));
        if (added.length || removed.length) {
            const multi = redis.multi();
            for (const s of removed) multi.sRem(R.subscriptionPrefix + s, id);
            for (const s of added)   multi.sAdd(R.subscriptionPrefix + s, id);
            multi.set(key, JSON.stringify(profile));
            await multi.exec();
            await ensureGroups(added);
        } else {
            await redis.set(key, JSON.stringify(profile));
        }

        return profile;
    }

    // §1.2 visibility — surface the identity mode (shared nexus permit vs own system.*
    // bot) and whether that bot's token is actually provisioned, so the portal can show
    // it instead of operators redis-cli'ing NEXUS:SENTINEL:TOKEN:*. hasToken is null
    // when no identity helper is wired (hermetic tests) — UI treats null as "unknown".
    async function identityOf(authorityRole) {
        const isBot = typeof authorityRole === 'string' && authorityRole.startsWith('system.');
        if (!isBot) return { mode: 'shared' };
        // Prefer the expiry-aware read: a present-but-expired token would render as ●
        // in the portal while getToken aborts at runtime ("configured but dead").
        if (identity && identity.tokenState) {
            const st = await identity.tokenState(authorityRole);
            return { mode: 'bot', uid: authorityRole, hasToken: st.hasToken, expired: st.expired, expiresAt: st.expiresAt };
        }
        return {
            mode: 'bot',
            uid: authorityRole,
            hasToken: identity ? await identity.hasToken(authorityRole) : null,
        };
    }

    // Activity ledger (written by the stream consumer): fired/skipped/failed counters
    // + lastFiredAt. Numbers parsed from the hash; absent hash → zeros (never fired).
    async function activityOf(id) {
        if (!redis.hGetAll) return null;
        const h = await redis.hGetAll(R.sentinelActivityPrefix + id).catch(() => null);
        if (!h || Object.keys(h).length === 0) {
            return { fired: 0, skipped: 0, failed: 0, lastFiredAt: null, lastFailedAt: null };
        }
        return {
            fired: Number(h.fired) || 0,
            skipped: Number(h.skipped) || 0,
            failed: Number(h.failed) || 0,
            lastFiredAt: Number(h.lastFiredAt) || null,
            lastFailedAt: Number(h.lastFailedAt) || null,
        };
    }

    async function get({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const raw = await redis.get(R.sentinelPrefix + id);
        if (!raw) throw jsonrpc.NOT_FOUND(`sentinel ${id}`);
        const profile = JSON.parse(raw);
        profile.online = (await redis.exists(R.onlinePrefix + id)) === 1;
        profile.identity = await identityOf(profile.authorityRole);
        profile.activity = await activityOf(id);
        return profile;
    }

    async function list({ page = 1, pageSize = config.pageSize, status = null } = {}) {
        const ids = await redis.sMembers(R.sentinelSet); // SAFE: small (bounded sentinel registry)
        if (ids.length === 0) return { items: [], total: 0 };

        const raw = await redis.mGet(ids.map(i => R.sentinelPrefix + i));
        let items = raw.filter(Boolean).map(JSON.parse);
        if (status) items = items.filter(a => a.status === status);

        const total = items.length;
        items.sort((a, b) => b.createdAt - a.createdAt);
        const offset = (Math.max(1, page) - 1) * pageSize;
        items = items.slice(offset, offset + pageSize);

        for (const it of items) {
            it.online = (await redis.exists(R.onlinePrefix + it.id)) === 1;
            it.identity = await identityOf(it.authorityRole);
            it.activity = await activityOf(it.id);
        }

        return { items, total };
    }

    async function disable({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const key = R.sentinelPrefix + id;
        const raw = await redis.get(key);
        if (!raw) throw jsonrpc.NOT_FOUND(`sentinel ${id}`);

        const profile = JSON.parse(raw);
        if (profile.status === 'DISABLED') {
            return { id, status: profile.status };
        }

        profile.status = 'DISABLED';
        profile.disabledAt = Date.now();

        // §2.4 — stop delivery cleanly: drop the Sentinel from its subscription sets so
        // subscribersOf no longer returns a stale id (no wasted get per delivery). enable
        // re-adds them. (discoverStreams already excludes non-ACTIVE sentinels.)
        const multi = redis.multi();
        multi.set(key, JSON.stringify(profile));
        for (const stream of (profile.eventSubscriptions || [])) multi.sRem(R.subscriptionPrefix + stream, id);
        await multi.exec();

        // §1.2 — soft revoke: nexus forgets the Sentinel's token so it stops acting on
        // its behalf. HARD revocation of the live session needs admin and is done
        // out-of-band (portal admin → user.token.revoke({ uid: authorityRole })).
        if (identity) await identity.dropToken(profile.authorityRole);

        return { id, status: profile.status };
    }

    // §2.4 — re-enable a DISABLED Sentinel: flip back to ACTIVE, re-add it to its
    // subscription sets, and re-establish consumer groups on those streams so it
    // resumes consuming. (Token must be re-provisioned separately if it was revoked.)
    async function enable({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const key = R.sentinelPrefix + id;
        const raw = await redis.get(key);
        if (!raw) throw jsonrpc.NOT_FOUND(`sentinel ${id}`);

        const profile = JSON.parse(raw);
        if (profile.status === 'ACTIVE') return { id, status: profile.status };

        profile.status = 'ACTIVE';
        delete profile.disabledAt;

        const subs = profile.eventSubscriptions || [];
        const multi = redis.multi();
        multi.set(key, JSON.stringify(profile));
        for (const stream of subs) multi.sAdd(R.subscriptionPrefix + stream, id);
        await multi.exec();
        await ensureGroups(subs);

        return { id, status: profile.status };
    }

    // §2.4 — permanently delete a Sentinel from the registry: profile, registry set,
    // subscription sets, online key, and its held bot token. Hard delete (a Sentinel
    // is a management record, not user data).
    async function remove({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        const key = R.sentinelPrefix + id;
        const raw = await redis.get(key);
        if (!raw) throw jsonrpc.NOT_FOUND(`sentinel ${id}`);
        const profile = JSON.parse(raw);

        const multi = redis.multi();
        multi.del(key);
        multi.sRem(R.sentinelSet, id);
        for (const stream of (profile.eventSubscriptions || [])) multi.sRem(R.subscriptionPrefix + stream, id);
        multi.del(R.onlinePrefix + id);
        multi.del(R.sentinelActivityPrefix + id);
        await multi.exec();

        if (identity) await identity.dropToken(profile.authorityRole);
        return { id, deleted: true };
    }

    async function heartbeat({ sentinelId } = {}) {
        if (!sentinelId) throw jsonrpc.MISSING_PARAM('sentinelId');
        const ttl = config.heartbeat.ttlSeconds;
        await redis.set(R.onlinePrefix + sentinelId, '1', { EX: ttl });

        const key = R.sentinelPrefix + sentinelId;
        const raw = await redis.get(key);
        if (raw) {
            const profile = JSON.parse(raw);
            profile.lastSeenAt = Date.now();
            await redis.set(key, JSON.stringify(profile));
        }

        return { sentinelId, expiresInSeconds: ttl };
    }

    async function subscribersOf(streamKey) {
        return redis.sMembers(R.subscriptionPrefix + streamKey); // SAFE: small (bounded subscribers per stream)
    }

    // Returns all ACTIVE sentinels subscribed to the given event stream key.
    // Callers use this to resolve which sentinel(s) handle an event before invoking.
    async function resolve({ event } = {}) {
        if (!event) throw jsonrpc.MISSING_PARAM('event');
        const ids = await subscribersOf(event);
        const sentinels = [];
        for (const id of ids) {
            const raw = await redis.get(R.sentinelPrefix + id);
            if (!raw) continue;
            const profile = JSON.parse(raw);
            if (profile.status !== 'ACTIVE') continue;
            sentinels.push({
                sentinelId: profile.id,
                name: profile.name,
                track: profile.track,
                reachability: profile.reachability,
            });
        }
        return { sentinels };
    }

    // Pushes this sentinel's delivery config to notification so messages are actually
    // delivered (not just stored in inbox). Must be called explicitly after create —
    // admin sees this as a visible BROADCAST step, not a hidden side effect.
    async function broadcast({ id } = {}) {
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        if (!relay) throw jsonrpc.INTERNAL_ERROR('relay not configured');

        const raw = await redis.get(R.sentinelPrefix + id);
        if (!raw) throw jsonrpc.NOT_FOUND(`sentinel ${id}`);
        const profile = JSON.parse(raw);

        const { reachability, webhookUrl } = profile;

        let rules;
        if (reachability === 'sse') {
            // Fail-closed: no sse delivery channel exists (notification.config.set also
            // rejects it). Previously this configured a rule that silently dead-lettered
            // every matching message while reporting broadcasted:true.
            throw jsonrpc.INVALID_PARAMS("reachability 'sse' has no delivery channel yet — use polling (inbox) or webhook");
        } else if (reachability === 'webhook') {
            if (!webhookUrl) throw jsonrpc.INVALID_PARAMS('sentinel has no webhookUrl; update the sentinel before broadcasting');
            rules = [{ type: '*', channel: 'webhook', params: { url: webhookUrl } }];
        } else {
            // polling and built-in sentinels don't need delivery config —
            // polling reads inbox directly, built-in is triggered in-process
            return { id, broadcasted: false, reason: `reachability '${reachability}' needs no delivery config` };
        }

        await relay.call('notification.config.set', { targetId: id, rules });
        logger.info('sentinel.broadcast.ok', { id, reachability });
        return { id, broadcasted: true, channel: reachability };
    }

    return { create, update, get, list, disable, enable, remove, heartbeat, subscribersOf, resolve, broadcast };
};
