/**
 * SOLO E2E — Jest config (独立项目,见 README §2).
 * 整栈由 globalSetup 一次性拉起,maxWorkers:1 + runInBand 语义(全栈天然串行).
 */
module.exports = {
    rootDir: __dirname,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/suites/**/*.e2e.test.js'],
    globalSetup: '<rootDir>/harness/setup.js',
    globalTeardown: '<rootDir>/harness/teardown.js',
    // 每套开跑前抓 ERROR:QUEUE 基线 → assertNoErrors 只断本套新增(共享 mesh 跨套隔离,§5.6②).
    setupFilesAfterEnv: ['<rootDir>/harness/reset-errors.js'],
    // testTimeout 必须 > 套内最长 poll 预算(fulfillment/aml 链路轮询 ~90-120s),否则满载下
    // jest 会在 poll 跑满预算前先掐死用例 → 假红.串行 harness(maxWorkers:1)下,通过的用例
    // 一到条件即返回,抬高上限对它们零成本;只有真卡死的用例多等一会才失败(§5.6①).
    testTimeout: 150_000,
    maxWorkers: 1,        // 整栈天然串行,避免 MockRouter/端口并发 flaky
    forceExit: true,
    // 注:同一文件内 test() 默认按声明顺序串行执行(§7.5 有序链路依赖此,无需额外配置).
};
