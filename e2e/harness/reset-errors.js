/**
 * setupFilesAfterEnv —— 在每个 suite 的 module 上下文里执行.
 *
 * 共享 mesh(整栈一次拉起、maxWorkers:1 串行跑全部 suite)下,ERROR:QUEUE:{svc} 是
 * 全局的:前一套遗留的合法错误(如 110-governance 的 workflow 冷却期 INTERNAL_ERROR)
 * 会漏给后跑套的广口 assertNoErrors(如 93-service-events)→ 偶发假红(BACKLOG §5.6 ②).
 *
 * 修法(非破坏性,不清库、不动 ~20 处调用点):每套开跑前快照各 ERROR:QUEUE 长度作为基线,
 * assertNoErrors 只断"本套新增"的 delta.保留队列内容 → DLQ 告警扫描器(§6.5)语义不变.
 *
 * 本 beforeAll 注册早于任一 suite 文件内的 beforeAll(setup 文件先于测试模块求值),故基线在
 * 套自身 setup 产生错误之前抓取 → 套自身(含 beforeAll)引发的错误仍被计入 delta.
 */
const { connect } = require('../lib/redis');
const { captureErrorBaseline } = require('../lib/verify');

let _redis;

beforeAll(async () => {
    _redis = await connect();
    await captureErrorBaseline(_redis);
});

afterAll(async () => {
    if (_redis) {
        try { await _redis.quit(); } catch { /* teardown best-effort */ }
        _redis = undefined;
    }
});
