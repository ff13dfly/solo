/**
 * 持久化发送队列 —— 让上行**熬过 MV3 service worker 的休眠**。
 *
 * @why 这是三个派生插件（wavely / steward / trend）**一个都没有**的东西，实扫
 *      `chrome.alarms` 引用数全是 0。MV3 的 service worker 空闲约 30 秒即被回收，而
 *      "采一批数据然后逐条上报"天然是个跨越好几十秒的循环。后果分两档：
 *        · 有人盯着面板的（wavely/steward）——断了看得见，重来一次即可；
 *        · 自动循环的（trend 的采集：一个 `for` 里串行 3N 次 await，50 个视频 = 150 次
 *          请求）——**worker 一睡就断在中间，而它没有队列，断了就永久丢，账面全绿**。
 *      后者正是 SOLO 反复在收口的那类缺陷：「返回成功」不等于「事情做成了」。
 *
 * ## 投递语义：at-least-once，去重是服务端的事
 *
 * 条目**只有在确认成功之后才出队**。所以 worker 若死在"已发出、还没来得及删"之间，
 * 下一轮会**再发一次**。这是刻意的取舍：宁可重发，不可丢。
 *
 * 因此 `idemKey` 是**必填**，没有就拒绝入队——它是重发安全的唯一依据，对应服务端已有的
 * 两道幂等闸：ingress 的 `(source, request_id)`，以及实体的业务唯一键。
 * 这跟 rpc.js 里"自动重试对非幂等方法危险"是同一条纪律的两处落点。
 *
 * ## 边界
 * 不认识 RPC、不认识 chrome —— `send` 与存储后端都是注入的。所以它在 node 下可完整回归，
 * 项目也能拿同一套语义去接别的传输。
 */

import { mutate } from './storage.js';

const DEFAULTS = {
    key: 'solo:queue',
    deadKey: 'solo:queue:dead',
    maxItems: 500,
    maxDead: 100,
    maxAttempts: 6,
    /** 退避：30s → 1m → 2m → 4m → 8m → 16m（封顶）。 */
    backoffMs: (attempts) => Math.min(30_000 * 2 ** (attempts - 1), 16 * 60_000),
};

/**
 * 重试不会有任何帮助的错误码 —— 直接进死信，别占着队列反复撞。
 * -32600/-32601/-32602 请求或参数本身错 · -32005 权限不足 · -32002 找不到目标。
 * @why 权限不足**要**进死信而不是丢弃：新账号 permit 是空的这件事，运营看到的第一个
 *      症状往往就是"上报了但没数据"，死信里留着原样的条目才查得下去。
 */
const PERMANENT = [-32600, -32601, -32602, -32005, -32002];

/**
 * @param {object}   opts
 * @param {object}   opts.backend        存储后端（storage.js 的 chromeArea/memoryArea）
 * @param {function} opts.send           (item) => Promise<any>  真正发出去；抛错即失败
 * @param {function} [opts.scheduleWake] (delayMs) => void  下次该醒的时间（接 chrome.alarms）
 * @param {function} [opts.isPermanent]  (err) => boolean   覆盖默认的永久失败判据
 * @param {function} [opts.now]          () => number       注入时钟，测试用
 */
export function createQueue(opts) {
    const cfg = { ...DEFAULTS, ...opts };
    const { backend, send } = cfg;
    const now = cfg.now || (() => Date.now());
    const isPermanent = cfg.isPermanent
        || ((err) => PERMANENT.includes(err && err.code));

    let draining = false;   // 仅进程内。worker 死了标志跟着没，下次启动重新 drain 即可。

    const read = async () => (await backend.get(cfg.key)) || [];

    /**
     * 入队。同 `idemKey` 已在队列里则不重复加（人连点两下按钮是常态）。
     * @returns {{queued:boolean, duplicate?:boolean, dropped?:number}}
     */
    async function enqueue({ method, params, idemKey, meta }) {
        if (!idemKey || typeof idemKey !== 'string') {
            // 早炸。少了它，一次 worker 休眠就可能变成一条重复业务数据，
            // 而那种错误要等到对账时才看得见。
            throw new Error('queue.enqueue 需要 idemKey —— 重发安全的唯一依据（见本文件顶部投递语义）');
        }
        let outcome = { queued: true };
        await mutate(backend, cfg.key, async (cur) => {
            const items = cur || [];
            if (items.some((it) => it.idemKey === idemKey)) {
                outcome = { queued: false, duplicate: true };
                return items;
            }
            const item = {
                idemKey, method, params,
                meta: meta || null,
                attempts: 0,
                nextAttemptAt: now(),
                createdAt: now(),
                lastError: null,
            };
            const next = [...items, item];
            // 封顶。**溢出的进死信、不静默丢**——静默丢正是这个模块存在的理由。
            // 这里直接 await 而不是 fire-and-forget：转存失败若被吞掉，溢出的条目就真的
            // 消失了。deadKey 与 cfg.key 是两条独立的 mutate 链，不会自锁。
            if (next.length > cfg.maxItems) {
                const overflow = next.splice(0, next.length - cfg.maxItems);
                outcome = { ...outcome, dropped: overflow.length };
                await toDead(overflow, 'queue overflow — 队列超过 maxItems，最旧的条目被移出');
            }
            return next;
        });
        return outcome;
    }

    /**
     * 把到期的条目依次发出去。可重入安全（同时只有一个在跑）。
     * @returns {{sent:number, failed:number, dead:number, remaining:number, nextWakeMs:number|null}}
     */
    async function drain() {
        if (draining) return { sent: 0, failed: 0, dead: 0, remaining: (await read()).length, nextWakeMs: null, skipped: true };
        draining = true;
        const stat = { sent: 0, failed: 0, dead: 0, remaining: 0, nextWakeMs: null };
        try {
            for (;;) {
                const items = await read();
                const due = items.filter((it) => it.nextAttemptAt <= now());
                if (due.length === 0) break;

                const item = due[0];
                let ok = false;
                let err = null;
                try {
                    await send(item);
                    ok = true;
                } catch (e) {
                    err = e;
                }

                if (ok) {
                    // 只有到这一步才出队。中途死掉 = 下轮重发 = 靠 idemKey 兜住。
                    await removeByKey(item.idemKey);
                    stat.sent++;
                    continue;
                }

                const attempts = item.attempts + 1;
                const permanent = isPermanent(err);
                if (permanent || attempts >= cfg.maxAttempts) {
                    await removeByKey(item.idemKey);
                    await toDead([{ ...item, attempts }],
                        permanent
                            ? `permanent: ${errText(err)}`
                            : `gave up after ${attempts} attempts: ${errText(err)}`);
                    stat.dead++;
                    continue;
                }

                const delay = cfg.backoffMs(attempts);
                await mutate(backend, cfg.key, (cur) => (cur || []).map((it) => (
                    it.idemKey === item.idemKey
                        ? { ...it, attempts, nextAttemptAt: now() + delay, lastError: errText(err) }
                        : it
                )));
                stat.failed++;
                // 一条失败就收工，不接着试后面的。@why 取舍：失败绝大多数是链路级的
                // （断网、Router 重启、限流），继续试只是把每条都撞一遍 ×3 次 fetch。
                // 代价是队头那条的退避会让后面的多等一轮——但下次唤醒时它已不在 due 里，
                // 后面的照常发，延迟上限就是第一档退避（30s），不构成队头阻塞。
                break;
            }

            const rest = await read();
            stat.remaining = rest.length;
            if (rest.length > 0) {
                const soonest = Math.min(...rest.map((it) => it.nextAttemptAt));
                stat.nextWakeMs = Math.max(0, soonest - now());
                if (cfg.scheduleWake) cfg.scheduleWake(stat.nextWakeMs);
            }
            return stat;
        } finally {
            draining = false;
        }
    }

    async function removeByKey(idemKey) {
        await mutate(backend, cfg.key, (cur) => (cur || []).filter((it) => it.idemKey !== idemKey));
    }

    /** 死信同样封顶；它是可看的排查线索，不是永久账本。 */
    async function toDead(items, reason) {
        await mutate(backend, cfg.deadKey, (cur) => {
            const next = [...(cur || []), ...items.map((it) => ({ ...it, deadReason: reason, deadAt: now() }))];
            return next.slice(-cfg.maxDead);
        });
    }

    async function stats() {
        const [pending, dead] = [await read(), (await backend.get(cfg.deadKey)) || []];
        return {
            pending: pending.length,
            dead: dead.length,
            due: pending.filter((it) => it.nextAttemptAt <= now()).length,
        };
    }

    return {
        enqueue,
        drain,
        stats,
        listPending: read,
        listDead: async () => (await backend.get(cfg.deadKey)) || [],
        clearDead: async () => { await backend.remove(cfg.deadKey); },
        /** 死信重投：把条目放回队列（attempts 归零）。修完权限之后用。 */
        async retryDead() {
            const dead = (await backend.get(cfg.deadKey)) || [];
            for (const it of dead) {
                await enqueue({ method: it.method, params: it.params, idemKey: it.idemKey, meta: it.meta })
                    .catch(() => {});
            }
            await backend.remove(cfg.deadKey);
            return dead.length;
        },
    };
}

function errText(err) {
    if (!err) return 'unknown';
    return err.code !== undefined ? `[${err.code}] ${err.message}` : String(err.message || err);
}
