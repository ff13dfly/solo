#!/usr/bin/env node
/**
 * 集成测试入口
 *
 * 用法：
 *   node api/simulation/run.js              # 运行所有场景
 *   node api/simulation/run.js storage      # 只跑 storage 相关场景
 *
 * 前提：本地 Redis 在 localhost:6379 运行
 *       测试使用 DB 15（隔离），自动 FLUSH，不影响生产数据
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
    authority: [
        { name: 'bind-concurrency', run: require('./scenarios/authority/bind-concurrency').run },
    ],
    // NOTE: scenarios for example/business services (sale/supply/lucky/academy/commodity) were
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
