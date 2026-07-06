/**
 * 乐观并发的原子 read-modify-write —— 解决并发 update 丢更新.
 *
 * 对一个存为 JSON 字符串的 Redis 值做"读→改→写",用 WATCH/MULTI 乐观 CAS 保证原子:
 * 期间被别的写者改了,EXEC 失败 → 重试. 跨实例/跨连接安全(WATCH 监视 key 本身).
 *
 * 连接隔离:node-redis v5 没有 executeIsolated,而共享(多路复用)连接上做 WATCH 不安全
 * (并发命令会破坏 WATCH 窗口). 故每次 update 用 redis.duplicate() 开一条独立连接,用完即关 ——
 * 干净(无泄漏、无需 mutex),代价是每次 update 一个短连接(写路径可接受).
 *
 * mutate(obj) 必须是 existing 的纯函数(可能因重试被多次调用),返回要写回的新对象.
 * key 不存在 → 返回 null(调用方决定抛 NOT_FOUND).
 *
 * onMulti(multi, { before, next }) — 可选钩子:在 .set 之后、EXEC 之前往**同一个**事务
 * 追加命令(如 entity.js 把 WAL xAdd 和数据写绑成原子)。和 mutate 一样可能因 CAS 重试
 * 被多次调用,每次拿到该轮真实的 before/next;只有最终成功的 EXEC 那轮落地。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function optimisticUpdate(redis, key, mutate, { maxRetries = 50, onMulti = null } = {}) {
    // 测试 mock / 不支持事务的客户端:退化成普通 read-modify-write(行为同改动前).
    if (typeof redis.duplicate !== 'function' || typeof redis.watch !== 'function') {
        const raw = await redis.get(key);
        if (raw === null || raw === undefined) return null;
        const next = mutate(JSON.parse(raw));
        await redis.set(key, JSON.stringify(next));
        return next;
    }

    const c = redis.duplicate();
    c.on('error', () => { /* 关停期的连接错误吞掉 */ });
    await c.connect();
    try {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            await c.watch(key);
            const raw = await c.get(key);
            if (raw === null || raw === undefined) { await c.unwatch().catch(() => {}); return null; }

            const before = JSON.parse(raw);
            const next = mutate(before);

            let res;
            try {
                const multi = c.multi().set(key, JSON.stringify(next));
                if (onMulti) onMulti(multi, { before, next });
                res = await multi.exec();
            } catch (e) {
                // WATCH 期间 key 被改 → 退避一点(打散惊群、降低活锁)后重试
                if (e && (e.name === 'WatchError' || /WATCH/i.test(e.message || ''))) { await sleep(Math.floor(Math.random() * 6)); continue; }
                throw e;
            }
            if (res === null) { await sleep(Math.floor(Math.random() * 6)); continue; }   // EXEC 被中止 → 退避重试
            return next;
        }
        throw new Error(`optimisticUpdate: exceeded ${maxRetries} retries for ${key}`);
    } finally {
        await c.quit().catch(() => {});
    }
}

/**
 * optimisticUpdate 的 RedisJSON 变体 —— 同样的 WATCH/MULTI CAS 语义,但目标是
 * redis.json 文档(json.get / json.set '$')而非 string 值。WATCH 监视 key 本身,
 * 对任何类型都有效,所以并发安全性与 string 版完全一致。
 *
 * mutate(doc) 约定同上(纯函数、可能重试多次、抛业务错误直接透传)。
 * onMulti(multi, { before, next }) 约定同上 —— 典型用法:把"版本快照写入"绑进
 * 与文档写同一个事务(orchestrator workflow 版本化,toFix §6.6)。
 */
async function optimisticJsonUpdate(redis, key, mutate, { maxRetries = 50, onMulti = null } = {}) {
    // 测试 mock / 不支持事务的客户端:退化成普通 read-modify-write.
    if (typeof redis.duplicate !== 'function' || typeof redis.watch !== 'function') {
        const before = await redis.json.get(key);
        if (before === null || before === undefined) return null;
        const next = mutate(before);
        await redis.json.set(key, '$', next);
        if (onMulti) {
            // 降级路径没有事务 —— 给钩子一个"立即执行"的 multi 形状垫片,只支持 json.set。
            const pending = [];
            const shim = { json: { set: (k, p, v) => { pending.push(redis.json.set(k, p, v)); return shim; } } };
            onMulti(shim, { before, next });
            await Promise.all(pending);
        }
        return next;
    }

    const c = redis.duplicate();
    c.on('error', () => { /* 关停期的连接错误吞掉 */ });
    await c.connect();
    try {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            await c.watch(key);
            const before = await c.json.get(key);
            if (before === null || before === undefined) { await c.unwatch().catch(() => {}); return null; }

            const next = mutate(before);

            let res;
            try {
                const multi = c.multi();
                multi.json.set(key, '$', next);
                if (onMulti) onMulti(multi, { before, next });
                res = await multi.exec();
            } catch (e) {
                if (e && (e.name === 'WatchError' || /WATCH/i.test(e.message || ''))) { await sleep(Math.floor(Math.random() * 6)); continue; }
                throw e;
            }
            if (res === null) { await sleep(Math.floor(Math.random() * 6)); continue; }
            return next;
        }
        throw new Error(`optimisticJsonUpdate: exceeded ${maxRetries} retries for ${key}`);
    } finally {
        await c.quit().catch(() => {});
    }
}

module.exports = { optimisticUpdate, optimisticJsonUpdate };
