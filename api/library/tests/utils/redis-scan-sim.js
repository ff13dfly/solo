/**
 * 共享的 SCAN 批次模拟器，给 hermetic 测试里的 fake redis 用。
 *
 * @why node-redis v4 的 scanIterator/sScanIterator/hScanIterator/zScanIterator
 *      逐条 yield 单个成员，v5（本项目在用）逐批 yield 一整个 SCAN 批次（数组）。
 *      排查 v5 批次坑（见 core/nexus/logic/events.js、core/orchestrator/logic/run.js、
 *      core/user/logic/user.js、core/nexus/logic/schedule.js 的历次修复）时发现，
 *      仓库里所有手写的 fake redis 的 scanIterator 系列全部是"单值 yield"的旧假设
 *      实现——包括当轮为了补方法而新加的 orchestrator 共享 mock。结果是消费方代码里
 *      `Array.isArray(batch) ? push(...batch) : push(batch)` 这条归一化，
 *      从来没有被任何 hermetic 测试真正走到过数组分支，只靠 e2e 数据量凑巧超过
 *      SCAN 页大小时才会暴露——这正是当轮 bug 能在 hermetic 全绿的情况下潜伏的根因。
 *
 * 用法：各 fake redis 的 xScanIterator 方法体委托给这里，而不是各自手写循环：
 *   async *sScanIterator(key, opts = {}) {
 *       yield* scanBatches([...(sets.get(key) || [])], opts);
 *   }
 *
 * 真实 Redis 的批次大小不严格等于 COUNT（COUNT 只是提示，哈希槽/游标实现会有出入），
 * 但按固定大小切块足以在集合超过一页时强制触发多批次迭代——这正是这个模拟器要
 * 复现的行为类别，不追求跟真实 Redis 逐字节一致（那是 tests/utils/redis-scan-sim
 * 契约测试要做的事，见 library/tests/redis-scan-contract.test.js）。
 */
async function* scanBatches(items, { COUNT } = {}) {
    const size = COUNT || 10; // node-redis/Redis 默认 COUNT 提示值
    for (let i = 0; i < items.length; i += size) {
        yield items.slice(i, i + size);
    }
}

module.exports = { scanBatches };
