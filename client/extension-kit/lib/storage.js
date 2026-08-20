/**
 * chrome.storage 适配层 —— kit 里**唯一**碰浏览器存储 API 的地方。
 *
 * @why 两个原因，缺一个都不够：
 *      ① **可测**：queue/session/endpoints 的逻辑全是"存了什么、什么时候取"，而
 *         `chrome.*` 在 node 里不存在。把它收成一个可替换的后端，逻辑就能在纯 node 下
 *         跑真实回归，不用 mock 整个浏览器。
 *      ② **local 与 session 的选择是一处策略，不该散落**：token 存哪一层取决于用户
 *         勾没勾「记住密码」（见 session.js），而 `chrome.storage.session` 在
 *         MV3 里是**内存态、关浏览器即失效**——这正是"不留痕"预期的实现方式。
 *         两处各写一遍，迟早漂移。
 *
 * 后端契约极窄（get/set/remove 三个方法，键值都是 JSON-able），所以测试里用一个
 * Map 就能顶替，真实环境用 `chromeArea('local')`。
 */

/**
 * 包一个 `chrome.storage` 区域成 kit 的后端。
 *
 * @param {'local'|'session'} area
 * @why 不在模块顶层读 `chrome.storage[area]`：service worker 冷启动时模块求值可能早于
 *      API 就绪，取一次存起来会拿到 undefined 且**永不自愈**。每次调用现取。
 */
export function chromeArea(area) {
    return {
        async get(key) {
            const bag = await globalThis.chrome.storage[area].get(key);
            return bag ? bag[key] : undefined;
        },
        async set(key, value) {
            await globalThis.chrome.storage[area].set({ [key]: value });
        },
        async remove(key) {
            await globalThis.chrome.storage[area].remove(key);
        },
    };
}

/**
 * 内存后端 —— 测试用，也可当作"不持久化"的显式选择。
 * @why 导出而不是留在测试里：项目写自己的回归时该用同一个替身，别各造一个。
 */
export function memoryArea(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        async get(key) { return map.get(key); },
        async set(key, value) { map.set(key, value); },
        async remove(key) { map.delete(key); },
        /** 测试断言用：看一眼当前全量。不属于后端契约，真实后端没有这个方法。 */
        _dump() { return Object.fromEntries(map); },
    };
}

/**
 * 读-改-写一个键，**串行化**以避免并发覆盖。
 *
 * @why chrome.storage 没有事务。队列的 enqueue 与 drain 可能同时发生（popup 点一次、
 *      alarm 醒一次），两边各自 get→改→set 会让后写的把前一次的改动整段抹掉——
 *      症状是"任务莫名其妙少了一条"，且完全无迹可循。这里用一条 per-key 的
 *      Promise 链把同键操作排成队，代价是同键无并发，收益是不丢写。
 */
const CHAINS = new Map();
export function mutate(backend, key, fn) {
    const prev = CHAINS.get(key) || Promise.resolve();
    const next = prev.then(async () => {
        const cur = await backend.get(key);
        const out = await fn(cur);
        if (out !== undefined) await backend.set(key, out);
        return out;
    });
    // 链上任何一环失败都不该毒死后续操作，所以挂一个吞掉 rejection 的尾巴当新链头。
    CHAINS.set(key, next.catch(() => {}));
    return next;
}
