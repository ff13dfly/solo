const { AsyncLocalStorage } = require('async_hooks');
const generator = require('./generator');
const jsonrpc = require('./jsonrpc');
const { STATUS, WAL } = require('./constants');
const logger = require('./logger');
const { optimisticUpdate } = require('./optimistic');

const STATUS_ACTIVE = STATUS.ACTIVE;
const STATUS_DELETED = STATUS.DELETED;

// WAL user context — microservices inject req.user.uid via walContext.run()
const walContext = new AsyncLocalStorage();

/**
 * Coerce a createdAt/updatedAt value to epoch ms for ORDERING purposes only.
 *
 * @why The factory standard is epoch ms (clock.now() / Date.now()), but a few
 *      services store the timestamp as an ISO-8601 string instead (storage assets,
 *      user passport/bot). A raw numeric subtract on an ISO string yields NaN, and a
 *      comparator that returns NaN makes Array.sort a no-op — so "newest-first" would
 *      silently degrade to the unordered Redis-SET order (sMembers is unordered).
 *      Coercing both shapes to ms keeps ordering correct regardless of stored format,
 *      and even across a collection that mixes the two. Non-throwing (unlike
 *      clock.toMs): an unparseable/absent value sorts last (treated as 0).
 *      This does NOT normalize what gets stored/returned — only the sort key.
 */
function toSortableMs(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const ms = Date.parse(v);
        return Number.isNaN(ms) ? 0 : ms;
    }
    return 0;
}

/**
 * @why Hardcoded status strings are used as a cross-service convention:
 *      1. Portal/AI consistency: Allows the Operator Portal and AI Agent to reliably
 *         filter and manage entities without per-service configuration.
 *      2. Soft-delete standard: Provides a predictable lifecycle state (ACTIVE -> DELETED)
 *         for all microservices utilizing the factory.
 */

/**
 * Shared Entity Factory
 * @why Standardizes CRUD operations across microservices to reduce boilerplate and ensure
 *      consistent Redis key/index naming conventions.
 *
 * @param {object} redis - Redis client instance.
 * @param {object} options - Factory options.
 * @param {string} options.serviceName - Name of the service (e.g., 'commodity').
 * @param {string} options.entityName - Name of the entity (e.g., 'product').
 * @param {string} [options.idPrefix=''] - Optional prefix for generated IDs.
 * @param {number} [options.idLength=16] - Length of the Base58 ID.
 * @param {boolean} [options.softDelete=false] - Whether to use soft deletion.
 * @param {string[]} [options.searchFields=[]] - Fields to search when keyword is provided in list().
 */
module.exports = (redis, { serviceName, entityName, idPrefix = '', idLength = 16, softDelete = false, storageType = 'string', sensitiveFields = [], searchFields = [], clientId = false }) => {
    if (!redis) throw new Error('[EntityFactory] Redis client is required');
    if (!serviceName || !entityName) throw new Error('[EntityFactory] serviceName and entityName are required');

    const SERVICE_UPPER = serviceName.toUpperCase();
    const ENTITY_UPPER = entityName.toUpperCase();
    const useJson = storageType === 'json';

    // Key pattern: SERVICE:ENTITY:ID
    const getDataKey = (id) => `${SERVICE_UPPER}:${ENTITY_UPPER}:${id}`;
    // Index pattern: SERVICE:ENTITY:INDEX (Redis Set) — unordered, sMembers-only.
    const getIndexKey = () => `${SERVICE_UPPER}:${ENTITY_UPPER}:INDEX`;
    // Cursor index: SERVICE:ENTITY:INDEX:CURSOR (Redis ZSET, score = insertion sequence,
    // NOT createdAt — see create()). Lets list({cursor}) do a bounded ZRANGE instead of
    // sMembers-the-whole-set-then-slice. Maintained alongside getIndexKey() from create()
    // (zAdd) and hard-delete (zRem); pre-existing entities need migrateCursorIndex() once.
    const getCursorIndexKey = () => `${SERVICE_UPPER}:${ENTITY_UPPER}:INDEX:CURSOR`;
    const getCursorSeqKey = () => `${SERVICE_UPPER}:${ENTITY_UPPER}:INDEX:CURSOR:SEQ`;

    // JSON-storage write helper. Only ever invoked on the useJson path (the non-atomic-WAL
    // fallback in update); string entities persist via optimisticUpdate, so this is JSON-only.
    const writeData = async (key, data) => redis.json.set(key, '$', data);
    const readData = async (key) => {
        if (useJson) return redis.json.get(key);
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) : null;
    };
    const readManyData = async (keys) => {
        if (useJson) {
            const results = await redis.json.mGet(keys, '$');
            return results.map(r => (r ? r[0] : null));
        }
        const results = await redis.mGet(keys);
        return results.map(r => (r ? JSON.parse(r) : null));
    };

    // --- WAL Helpers ---
    //
    // The ledger row (op/key/before/after/user/txn/stamp) is appended to a Redis
    // Stream (WAL.STREAM) **inside the same MULTI as the data write** — data and
    // ledger commit or fail together, so "state changed but no audit row" and
    // "audit row but no state change" are both structurally impossible. The file
    // copy (disaster-recovery path, walarchiver.js) is produced asynchronously by
    // a consumer group draining the stream into logger.insert().

    // Real node-redis clients can bind ledger writes into MULTI; unit-test mocks
    // (plain objects without xAdd) keep the legacy direct-to-file behavior.
    const canAtomicWal = typeof redis.multi === 'function' && typeof redis.xAdd === 'function';

    // ── 行隔离 ($owner) 自动执行 ──────────────────────────────────────────────
    // passport.md §3.7 在三处强制外部角色声明 ownerField（不声明就拒发会话），Router 把
    // constraints.$owner 原样下发——但执行这一环此前不存在：服务不自己读，外部主体就能
    // 看到全表（docs/feedback/done/passport-owner-isolation-declared-not-enforced.md）。
    // 服务经 requestContext(req) 把 $owner 注入 walContext 后，工厂在数据层自动执行：
    // create 盖章、get/update/delete/destroy 校验归属、list/multiGet 过滤。归属不符一律
    // NOT_FOUND（与 collection 的手工实现同语义——不泄露"这条存在但不是你的"）。
    // 内部/admin/bot 会话没有 $owner → ownerScope() 为 null → 行为与从前完全一致。
    // 注意 fail-closed 方向：外部会话只能看到**盖了自己章**的行；enforcement 之前就存在
    // 的行、或 admin 直建的行没有 owner 字段，对外部会话不可见——这是设计而非缺陷。
    const ownerScope = () => {
        const ctx = walContext.getStore();
        const o = ctx && ctx.owner;
        return (o && o.field && o.value !== undefined && o.value !== null) ? o : null;
    };
    const ownerFilter = (filter) => {
        const o = ownerScope();
        if (!o) return filter;
        const pred = (item) => !!item && item[o.field] === o.value;
        return filter ? (item) => pred(item) && filter(item) : pred;
    };
    const assertOwned = (data) => {
        const o = ownerScope();
        if (o && data && data[o.field] !== o.value) throw jsonrpc.NOT_FOUND(entityName);
        return data;
    };

    /**
     * Strip sensitive fields from data before writing to WAL log.
     */
    const sanitize = (data) => {
        if (!data || sensitiveFields.length === 0) return data;
        const clean = { ...data };
        for (const field of sensitiveFields) {
            if (field in clean) clean[field] = '[REDACTED]';
        }
        return clean;
    };

    // Snapshot → JSON string, capped at WAL.MAX_SNAPSHOT. Oversize snapshots keep
    // an audit row (marker + preview + id) instead of silently dropping the entry.
    const snap = (data) => {
        if (data === null || data === undefined) return 'null';
        const s = JSON.stringify(sanitize(data));
        if (s.length <= WAL.MAX_SNAPSHOT) return s;
        /* istanbul ignore next -- defensive: the oversize-snapshot path always carries a full entity with an id */
        const id = data.id !== undefined ? data.id : null;
        return JSON.stringify({
            __truncated: true, size: s.length,
            preview: s.substring(0, 200), id
        });
    };

    // Flat field map for one ledger row (stream entries are string maps).
    // Lazily stamps a txn id on the walContext store: every entity op inside the
    // same request (walContext.run scope) shares it → multi-entity operations can
    // be grouped/reverted as a unit. trace passes through when a caller sets it.
    const walFields = (op, key, before, after) => {
        const ctx = walContext.getStore();
        if (ctx && !ctx.txn) ctx.txn = generator.generateId(12);
        return {
            op,
            key,
            before: snap(before),
            after: snap(after),
            user: ctx && ctx.uid ? String(ctx.uid) : '',
            txn: (ctx && ctx.txn) || '',
            trace: (ctx && ctx.trace) ? String(ctx.trace) : '',
            stamp: String(Date.now())
        };
    };

    // Append the ledger row to the SAME transaction as the data write.
    // MAXLEN ~ is a memory safety valve only — durable history lives in the
    // archiver's files; the stream is a bounded hot ring buffer.
    const walMulti = (multi, op, key, before, after) => {
        multi.xAdd(WAL.STREAM, '*', walFields(op, key, before, after), {
            TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: WAL.MAXLEN }
        });
    };

    /**
     * Legacy direct file write — degraded clients (mocks without xAdd) only.
     * Never throws — failures are logged to stderr only.
     */
    const walFile = (op, key, before, after) => {
        try {
            const ctx = walContext.getStore();
            if (ctx && !ctx.txn) ctx.txn = generator.generateId(12);
            logger.insert(key, {
                op,
                key,
                before: sanitize(before),
                after: sanitize(after),
                user: ctx?.uid || null,
                txn: ctx?.txn || null,
                stamp: Date.now()
            });
        } catch (e) {
            console.error(`[EntityFactory:WAL] Failed to write log for ${op} ${key}: ${e.message}`);
        }
    };

    return {
        /**
         * Create a new entity instance.
         */
        async create(params) {
            let id;
            let key;

            if (clientId && params.id !== undefined && params.id !== null && params.id !== '') {
                // Client-supplied key (opt-in): use params.id verbatim as the entity id,
                // enforce uniqueness via NX. This is what services like fulfillment.profile
                // want — a meaningful key (e.g. 'standard_trade') rather than a generated one.
                id = String(params.id);
                key = getDataKey(id);
                const reserved = useJson
                    ? await redis.json.set(key, '$', {}, { NX: true })
                    : await redis.set(key, JSON.stringify({}), { NX: true });
                if (!(reserved === 'OK' || reserved === true)) {
                    throw jsonrpc.INVALID_PARAM(`${entityName} id "${id}" already exists`);
                }
            } else {
                // Generate a unique Base58 id.
                let success = false;
                let attempts = 0;
                const maxAttempts = 10;
                while (!success && attempts < maxAttempts) {
                    id = idPrefix + generator.generateId(idLength);
                    key = getDataKey(id);
                    const result = useJson
                        ? await redis.json.set(key, '$', {}, { NX: true })
                        : await redis.set(key, JSON.stringify({}), { NX: true });
                    if (result === 'OK' || result === true) success = true;
                    else attempts++;
                }
                if (!success) {
                    throw new Error(`[EntityFactory] Failed to generate unique ID after ${maxAttempts} attempts.`);
                }
            }

            const indexKey = getIndexKey();
            const now = Date.now();
            const data = {
                status: STATUS_ACTIVE,
                ...params,
                id, // force: data.id ALWAYS equals the Redis key id (params.id can never corrupt it)
                createdAt: params.createdAt !== undefined ? params.createdAt : now,
                updatedAt: now
            };
            // 行隔离盖章：owner-scoped 会话建的行归它所有。放在 params 展开之后 = 覆盖
            // 客户端传入的同名字段（防伪造归属），且先于 WAL 快照（账本记录的是终值）。
            const _owner = ownerScope();
            if (_owner) data[_owner.field] = _owner.value;

            // Cursor index score = insertion sequence (INCR), not createdAt. createdAt can be
            // client-supplied (backdated imports) and two creates can land in the same ms —
            // either would make a createdAt-keyed ZSET score collide or tie ambiguously at the
            // page boundary. INCR is atomic and strictly increasing, so ties are structurally
            // impossible; the one-time extra round trip only happens on create(), never on list().
            const cursorIndexKey = getCursorIndexKey();
            const seq = await redis.incr(getCursorSeqKey());

            if (canAtomicWal) {
                // 数据 + 索引 + 账本同一个 MULTI:三者同生共死。
                // (node-redis v5 起 json.* 命令同样可入事务 — 旧注释"json 不支持 MULTI"已过时)
                const multi = redis.multi();
                if (useJson) multi.json.set(key, '$', data);
                else multi.set(key, JSON.stringify(data));
                multi.sAdd(indexKey, id);
                multi.zAdd(cursorIndexKey, { score: seq, value: id });
                walMulti(multi, 'create', key, null, data);
                await multi.exec();
            } else if (useJson) {
                await redis.json.set(key, '$', data);
                await redis.sAdd(indexKey, id);
                await redis.zAdd(cursorIndexKey, { score: seq, value: id });
                walFile('create', key, null, data);
            } else {
                const multi = redis.multi();
                multi.set(key, JSON.stringify(data));
                multi.sAdd(indexKey, id);
                multi.zAdd(cursorIndexKey, { score: seq, value: id });
                await multi.exec();
                walFile('create', key, null, data);
            }

            return data;
        },

        /**
         * Create or update an entity (Upsert).
         * @param {string|null} id - If null, creates new. If string, updates existing.
         */
        async save(id, data) {
            if (!id) {
                const res = await this.create(data);
                return res.id;
            }
            const res = await this.update({ id, ...data });
            return res.id;
        },

        /**
         * Retrieve a single entity by ID.
         */
        async get({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const key = getDataKey(id);
            const data = await readData(key);
            if (!data) throw jsonrpc.NOT_FOUND(entityName);
            return assertOwned(data);
        },

        /**
         * Update an existing entity.
         */
        async update({ id, ...updates }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const key = getDataKey(id);

            // 行隔离：先验归属（不符 → NOT_FOUND，经 this.get 的 assertOwned），再锁死
            // owner 字段不可被 update 改走（否则 owner-scoped 会话能把行转让/脱离隔离）。
            const _owner = ownerScope();
            if (_owner) {
                await this.get({ id });
                updates[_owner.field] = _owner.value;
            }

            if (useJson) {
                // RedisJSON 存储:读改写本身仍非原子(并发 update 可互相覆盖,已知缺口 §8.2,
                // 目前无并发 patch 热点);但【写 + 账本】已绑进同一个 MULTI。
                const existing = await this.get({ id });
                const updated = { ...existing, ...updates, updatedAt: Date.now() };
                if (canAtomicWal) {
                    const multi = redis.multi();
                    multi.json.set(key, '$', updated);
                    walMulti(multi, 'update', key, existing, updated);
                    await multi.exec();
                } else {
                    await writeData(key, updated);
                    walFile('update', key, existing, updated);
                }
                return updated;
            }

            // string 存储:原子乐观 CAS(WATCH/MULTI),并发 update 不丢更新。
            // 账本 xAdd 经 onMulti 进同一个事务:CAS 重试时每轮用该轮真实 before/after 重建,
            // 只随最终成功的 EXEC 落地 → 账本链(本条 before === 上条 after)严格成立。
            let before = null;
            const updated = await optimisticUpdate(redis, key, (existing) => {
                before = existing;
                return { ...existing, ...updates, updatedAt: Date.now() };
            }, canAtomicWal
                ? { onMulti: (multi, { before: b, next }) => walMulti(multi, 'update', key, b, next) }
                : {});
            if (updated === null) throw jsonrpc.NOT_FOUND(entityName);

            if (!canAtomicWal) walFile('update', key, before, updated);

            return updated;
        },

        /**
         * Delete an entity.
         * @strategy If softDelete=true, marks status as 'DELETED'. Otherwise purges the key.
         */
        async delete({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const key = getDataKey(id);
            const indexKey = getIndexKey();

            if (softDelete) {
                return this.update({ id, status: STATUS_DELETED });
            }

            // Hard delete: read before for WAL, then remove
            const existing = await readData(key);
            if (!existing) throw jsonrpc.NOT_FOUND(entityName);
            assertOwned(existing);   // 行隔离：不是你的行 → NOT_FOUND

            // Soft-delete never sRem's the SET index either (see the early return above), so
            // the cursor ZSET mirrors that: only a real hard delete removes the id from both.
            const cursorIndexKey = getCursorIndexKey();

            if (canAtomicWal) {
                // DEL 是核心命令,json/string 实体都走同一个 MULTI(删除 + 去索引 + 账本)
                const multi = redis.multi();
                multi.del(key);
                multi.sRem(indexKey, id);
                multi.zRem(cursorIndexKey, id);
                walMulti(multi, 'delete', key, existing, null);
                await multi.exec();
            } else {
                if (useJson) {
                    await redis.del(key);
                    await redis.sRem(indexKey, id);
                    await redis.zRem(cursorIndexKey, id);
                } else {
                    const multi = redis.multi();
                    multi.del(key);
                    multi.sRem(indexKey, id);
                    multi.zRem(cursorIndexKey, id);
                    await multi.exec();
                }
                walFile('delete', key, existing, null);
            }

            return { success: true };
        },

        /**
         * Restore a soft-deleted entity to ACTIVE status.
         */
        async restore({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            if (!softDelete) throw jsonrpc.INTERNAL_ERROR('Restore only available for soft-delete entities');

            const existing = await this.get({ id });
            if (existing.status !== STATUS_DELETED) {
                return existing;
            }

            return this.update({ id, status: STATUS_ACTIVE });
        },

        /**
         * Update the status of an entity.
         * @on_demand This is provided as a utility for custom state transitions (e.g., PENDING).
         *            Microservices should only expose this in their introspection if needed.
         */
        async status({ id, status }) {
            if (!id || !status) throw jsonrpc.INVALID_PARAM('id and status required');
            return this.update({ id, status: status.toUpperCase() });
        },

        /**
         * List entities with pagination and status filtering.
         *
         * @param {number}   [batchSize] - If set, fetch IDs in chunks of this size,
         *                                 applying `filter` per batch to reduce peak memory.
         *                                 Useful when total records are large but matches are few.
         * @param {Function} [filter]    - Per-item predicate applied inside each batch.
         *                                 Only matched items are kept; the raw batch is released.
         * @param {string}   [keyword]   - Optional keyword to search against configured searchFields.
         * @param {string|null} [cursor] - Opt into bounded cursor pagination instead of the
         *                                 default offset path (see _listByCursor). Pass `null`
         *                                 for the first page, then `response.nextCursor` for
         *                                 each subsequent call. Omit entirely (don't pass the
         *                                 key at all) to keep today's offset/total behavior —
         *                                 that path is untouched by cursor mode.
         */
        async list({ status = STATUS_ACTIVE, limit = 50, offset = 0, includeDeleted = false, batchSize, filter, keyword, cursor } = {}) {
            // 行隔离在最外层合入：keyword 分支往下复合的是 finalFilter（而不是原始 filter），
            // owner 谓词才不会在那个分支被覆盖丢掉。
            let finalFilter = ownerFilter(filter);

            // Auto-construct keyword filter if searchFields are configured
            if (keyword && searchFields && searchFields.length > 0) {
                const kw = keyword.toLowerCase();
                const keywordFilter = (item) => {
                    for (const field of searchFields) {
                        const val = field.split('.').reduce((obj, key) => obj && obj[key], item);
                        if (val && String(val).toLowerCase().includes(kw)) return true;
                    }
                    return false;
                };
                const base = finalFilter;
                finalFilter = base ? (item) => base(item) && keywordFilter(item) : keywordFilter;
            }

            // cursor === undefined (key not sent at all) → every existing caller, unchanged.
            // cursor === null / a string → explicit opt-in to the bounded ZRANGE path below.
            if (cursor !== undefined) {
                return this._listByCursor({ cursor, limit, status, includeDeleted, filter: finalFilter });
            }

            const indexKey = getIndexKey();
            // 现有 offset 路径的既定行为：v1.1.13 起 list({cursor}) 是有界的快路径 opt-in，
            // 这里保持不变正是为了不传 cursor 的调用方零变化（见 CHANGELOG v1.1.13）。
            const ids = await redis.sMembers(indexKey); // SAFE: legacy path, cursor 是 opt-in 快路径

            if (!ids || ids.length === 0) return { items: [], total: 0 };

            // Batched path: fetch → filter per chunk → accumulate only matches
            if (batchSize) {
                const matched = [];
                for (let i = 0; i < ids.length; i += batchSize) {
                    const chunk = ids.slice(i, i + batchSize);
                    const keys = chunk.map(id => getDataKey(id));
                    const results = await readManyData(keys);
                    for (const item of results) {
                        if (!item) continue;
                        if (!includeDeleted && item.status !== status) continue;
                        if (finalFilter && !finalFilter(item)) continue;
                        matched.push(item);
                    }
                    // chunk + results go out of scope here → GC
                }
                // Same newest-first default as the multiGet path (see below).
                matched.sort((a, b) => toSortableMs(b.createdAt) - toSortableMs(a.createdAt));
                return { items: matched, total: matched.length };
            }

            return this.multiGet({ ids, status, limit, offset, includeDeleted, filter: finalFilter });
        },

        /**
         * Retrieve multiple entities by ID list.
         */
        async multiGet({ ids, status = STATUS_ACTIVE, limit, offset, includeDeleted = false, filter }) {
            if (!ids || !Array.isArray(ids) || ids.length === 0) return { items: [], total: 0 };
            // 行隔离：multiGet 也被服务直接调用（不只经 list），这里再合一次。经 list 进来时
            // filter 已含 owner 谓词，重复合入是纯谓词、幂等无害。
            filter = ownerFilter(filter);

            const keys = ids.map(id => getDataKey(id));
            const results = await readManyData(keys);
            const allItems = results.filter(r => r !== null);

            // Status and Custom Filtering Logic
            const filtered = allItems.filter(item => {
                if (!includeDeleted && status && item.status !== status) return false;
                if (filter && !filter(item)) return false;
                return true;
            });

            // Default order: newest-first. The index is a Redis SET (sMembers is
            // unordered), so without this lists come back in arbitrary order. Sort by
            // createdAt desc BEFORE pagination so newest-first holds across pages, not
            // just within a page. Missing createdAt sorts last (treated as 0).
            // toSortableMs: createdAt may be epoch ms (factory standard) OR an ISO
            // string (storage/user) — coerce so newest-first holds for both.
            filtered.sort((a, b) => toSortableMs(b.createdAt) - toSortableMs(a.createdAt));

            // Pagination (Optional for multiGet if limit/offset provided)
            const start = offset || 0;
            const end = limit ? start + limit : filtered.length;
            const paged = filtered.slice(start, end);

            return {
                items: paged,
                total: filtered.length
            };
        },

        /**
         * Bounded cursor pagination — the fast path behind list({cursor}).
         *
         * @why The offset path above (and multiGet) must materialize the ENTIRE index
         *      (sMembers + mGet-everything + sort-everything) before it can slice out one
         *      page, because a plain Redis SET has no order. This path instead reads a
         *      ZRANGE window off the cursor ZSET (score = insertion sequence, see create()),
         *      so cost is proportional to `limit`, not to collection size.
         * @attention
         *   1. Requires migrateCursorIndex() to have run at least once for entities that
         *      existed before this ZSET was introduced — by design this throws rather than
         *      silently degrading to the slow path (see PR discussion): a silent fallback
         *      would make "is cursor mode actually fast right now" undiscoverable.
         *   2. `status`/`filter`/`keyword` are applied AFTER the bounded fetch, per page —
         *      a page can come back with fewer than `limit` items if most of the window
         *      doesn't match. No items are skipped across calls (nextCursor always advances
         *      past every id considered, matched or not), so repeated calls eventually walk
         *      the whole collection — it just isn't a firm "exactly limit per page" guarantee.
         *   3. No `total` — keyset/cursor pagination doesn't know "how many pages" without
         *      a maintained counter (a write-path cost every list() call must not incur just
         *      because SOME callers want cursor mode). Callers wanting cursor mode accept
         *      "load more" UX, not "page X of Y".
         */
        async _listByCursor({ cursor, limit = 50, status = STATUS_ACTIVE, includeDeleted = false, filter }) {
            filter = ownerFilter(filter);   // 行隔离（经 list 进来已含，幂等）
            const indexKey = getIndexKey();
            const cursorIndexKey = getCursorIndexKey();

            const [setCard, zCard] = await Promise.all([redis.sCard(indexKey), redis.zCard(cursorIndexKey)]);
            if (zCard < setCard) {
                throw jsonrpc.INVALID_PARAMS(
                    `Cursor pagination not available for ${entityName}: sorted index not migrated yet ` +
                    `(has ${zCard} of ${setCard} ids indexed). Run migrateCursorIndex() once for this entity, then retry.`
                );
            }

            let afterSeq = null;
            if (cursor !== null) {
                afterSeq = parseInt(cursor, 10);
                if (!Number.isFinite(afterSeq)) throw jsonrpc.INVALID_PARAMS(`Invalid cursor: ${cursor}`);
            }

            // ZRANGE ... BYSCORE REV takes the bounds as (max, min) — NOT (min, max) — when
            // REV is set. Passing them the "intuitive" way silently returns nothing or the
            // wrong order; verified against a live Redis before relying on this (see PR notes).
            const upperBound = afterSeq === null ? '+inf' : `(${afterSeq}`;
            const candidateIds = await redis.zRange(cursorIndexKey, upperBound, '-inf', {
                BY: 'SCORE', REV: true, LIMIT: { offset: 0, count: limit }
            });

            if (candidateIds.length === 0) return { items: [], nextCursor: null };

            const keys = candidateIds.map(id => getDataKey(id));
            const results = await readManyData(keys);
            const items = results.filter(item => {
                if (!item) return false;
                if (!includeDeleted && status && item.status !== status) return false;
                if (filter && !filter(item)) return false;
                return true;
            });

            // Cursor always advances past every candidate considered (not just matched ones),
            // so a filtered-out run never causes a stall or a re-fetch loop on the same window.
            const lastConsidered = candidateIds[candidateIds.length - 1];
            const lastSeq = await redis.zScore(cursorIndexKey, lastConsidered);
            const nextCursor = candidateIds.length < limit ? null : String(lastSeq);

            return { items, nextCursor };
        },

        /**
         * One-time backfill: build the cursor ZSET for entities that existed before it was
         * introduced. Idempotent (zAdd overwrites, SEQ is reset to the same count) — safe to
         * re-run. New entities never need this; create() maintains the ZSET going forward.
         * Not exposed as an RPC method by convention — call it from a maintenance script.
         */
        async migrateCursorIndex({ chunkSize = 2000 } = {}) {
            const indexKey = getIndexKey();
            const cursorIndexKey = getCursorIndexKey();
            const ids = await redis.sMembers(indexKey); // SAFE: 一次性迁移脚本，非热路径

            if (ids.length === 0) {
                await redis.set(getCursorSeqKey(), '0');
                return { migrated: 0 };
            }

            const keys = ids.map(id => getDataKey(id));
            const items = await readManyData(keys);
            // Oldest-first assignment (rank 1..N) — same comparator as the offset path's
            // "newest-first" sort, just ascending, so rank order matches createdAt order.
            const ranked = ids
                .map((id, i) => ({ id, createdAt: items[i] ? items[i].createdAt : 0 }))
                .sort((a, b) => toSortableMs(a.createdAt) - toSortableMs(b.createdAt));

            for (let i = 0; i < ranked.length; i += chunkSize) {
                const chunk = ranked.slice(i, i + chunkSize);
                const multi = redis.multi();
                chunk.forEach((r, j) => multi.zAdd(cursorIndexKey, { score: i + j + 1, value: r.id }));
                await multi.exec();
            }
            await redis.set(getCursorSeqKey(), String(ranked.length));

            return { migrated: ranked.length };
        },

        /**
         * Check if an entity can be permanently destroyed.
         * @on_demand These are utility methods for physical data purging.
         *            Microservices should only expose them in introspection if needed.
         */
        async purgeable({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            return { canDestroy: true, reason: null, count: 0 };
        },

        /**
         * Permanently destroy an entity (Hard Delete).
         * @on_demand Use with caution. Bypasses soft-delete logic.
         */
        async destroy({ id }) {
            if (!id) throw jsonrpc.MISSING_PARAM('id');
            const key = getDataKey(id);
            const indexKey = getIndexKey();

            // Read before for WAL
            const existing = await readData(key);
            if (!existing) throw jsonrpc.NOT_FOUND(entityName);
            assertOwned(existing);   // 行隔离：不是你的行 → NOT_FOUND

            if (canAtomicWal) {
                const multi = redis.multi();
                multi.del(key);
                multi.sRem(indexKey, id);
                walMulti(multi, 'destroy', key, existing, null);
                await multi.exec();
            } else {
                if (useJson) {
                    await redis.del(key);
                    await redis.sRem(indexKey, id);
                } else {
                    const multi = redis.multi();
                    multi.del(key);
                    multi.sRem(indexKey, id);
                    await multi.exec();
                }
                walFile('destroy', key, existing, null);
            }

            return { success: true };
        }
    };
};

// Export Constants and WAL context for cross-service usage
module.exports.STATUS_ACTIVE = STATUS_ACTIVE;
module.exports.STATUS_DELETED = STATUS_DELETED;
module.exports.walContext = walContext;

/**
 * Build the per-request walContext store from a Router-authenticated req.
 * @why 每个服务此前各自手写 `{ uid: req.user || null, trace: …, depth: … }`——一旦 store
 *      需要新字段（本次是行隔离的 owner），十几个副本不会跟着更新。收口成一个 helper，
 *      服务侧写 `walContext.run(requestContext(req), …)`，新字段自动到位。
 *      `owner` = Router 下发的 constraints.$owner（passport 外部会话才有）；工厂据此在
 *      数据层自动执行行隔离（见上方 ownerScope 注释）。内部/admin 会话该字段为 null。
 */
module.exports.requestContext = (req) => ({
    uid: req?.user || null,
    trace: req?.meta?.trace || null,
    depth: req?.meta?.depth ?? 0,
    owner: (req?.constraints && req.constraints.$owner) || null,
});
