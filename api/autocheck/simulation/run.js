#!/usr/bin/env node
/**
 * 集成测试入口
 *
 * 用法：
 *   node api/autocheck/simulation/run.js              # 运行所有场景
 *   node api/autocheck/simulation/run.js storage      # 只跑 storage 相关场景
 *
 * 前提：Redis 可达。默认 redis://localhost:6699/15（与 deploy/dev.sh 一致），
 *       用 TEST_REDIS_URL 覆盖（CI 的 test job 传 redis://localhost:6379/15）。
 *       只用 DB 15，每个场景前后 FLUSHDB —— 🔴 别指向任何有数据的实例。
 *
 * CI：.github/workflows/ci.yml `test` job 每次都跑（2026-09-04 起）。此前只有
 *     static/simulation-coverage.js 检查「场景文件存在」，从没有人执行过它们。
 */

const testRedis = require('./framework/redis');

const SCENARIOS = {
    storage: [
        { name: 'concurrent-upload', run: require('./scenarios/storage/concurrent-upload').run },
    ],
    user: [
        { name: 'concurrent-register', run: require('./scenarios/user/concurrent-register').run },
    ],
    administrator: [
        { name: 'login-flow', run: require('./scenarios/administrator/login-flow').run },
    ],
    orchestrator: [
        { name: 'workflow-execution', run: require('./scenarios/orchestrator/workflow-execution').run },
    ],
    router: [
        { name: 'core-security', run: require('./scenarios/router/core-security').run },
        { name: 'param-validation', run: require('./scenarios/router/param-validation').run },
    ],
    // NOTE: scenarios for example/business services (sale/supply/lucky/academy/commodity, and
    // authority on 2026-09-04) were
    // removed — SOLO is framework-only (CLAUDE.md §1), those services don't exist. Their dangling
    // require() entries used to crash the whole runner at load; keep this map in sync with
    // scenarios/ on disk.
};

async function main() {
    const filters = process.argv.slice(2).filter(a => !a.startsWith('--'));
    let allPassed = true;

    const redis = await testRedis.setup();

    try {
        for (const [service, scenarios] of Object.entries(SCENARIOS)) {
            if (filters.length > 0 && !filters.includes(service)) continue;

            console.log(`\n▶ Service: ${service}`);

            for (const scenario of scenarios) {
                console.log(`  Scenario: ${scenario.name}`);
                try {
                    const ok = await scenario.run(redis);
                    if (!ok) allPassed = false;
                } catch (err) {
                    console.error(`  ❌ Scenario crashed: ${err.message}`);
                    console.error(err.stack);
                    allPassed = false;
                }
                // 每个场景后 flush，避免互相污染
                await redis.flushDb();
            }
        }
    } finally {
        await testRedis.teardown();
    }

    console.log(allPassed ? '\n✅ All integration tests passed\n' : '\n❌ Some tests FAILED\n');
    process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
    console.error('Runner crashed:', err);
    process.exit(1);
});
