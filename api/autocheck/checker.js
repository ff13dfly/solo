#!/usr/bin/env node
/**
 * checker.js - Solo Microservice Quality Checker
 *
 * 两种检测模式（均在此入口触发）：
 *
 *   静态检测（无需服务运行）：
 *     node api/autocheck/checker.js api/apps/storage [--static]
 *
 *   运行时模拟（需要本地 Redis）：
 *     node api/autocheck/simulation/run.js [service]
 *
 * --static 标志跳过需要服务已启动的运行时检查（startup / test-runner / memory-leak-dynamic）。
 *
 * Version: 4.0.0
 */

const path = require('path');
const checks = require('./static/index');

const results = { passed: [], warnings: [], errors: [] };

function printReport() {
    console.log('\n' + '='.repeat(60));
    console.log('📋 SOLO MICROSERVICE CHECKER REPORT');
    console.log('='.repeat(60));

    console.log(`\n✅ PASSED (${results.passed.length})`);
    results.passed.forEach(msg => console.log(`   ${msg}`));

    if (results.warnings.length > 0) {
        console.log(`\n⚠️  WARNINGS (${results.warnings.length})`);
        results.warnings.forEach(msg => console.log(`   ${msg}`));
    }

    if (results.errors.length > 0) {
        console.log(`\n❌ ERRORS (${results.errors.length})`);
        results.errors.forEach(msg => console.log(`   ${msg}`));
    }

    console.log('\n' + '='.repeat(60));
    if (results.errors.length > 0) {
        console.log('❌ RESULT: FAILED - Please fix errors before deployment.');
        process.exit(1);
    } else if (results.warnings.length > 0) {
        console.log('⚠️  RESULT: PASSED WITH WARNINGS');
        process.exit(0);
    } else {
        console.log('✅ RESULT: ALL CHECKS PASSED');
        process.exit(0);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const isStatic = args.includes('--static');
    const targetPath = args.find(a => !a.startsWith('--')) || '.';
    const resolvedPath = path.resolve(targetPath);

    console.log('\n🔍 Solo Microservice Checker v4.0.0');
    console.log(`📁 Target: ${resolvedPath}`);
    if (isStatic) console.log('⚡ Mode: static (runtime checks skipped)\n');
    else console.log('');

    if (checks.structure.check(resolvedPath, results) === false) {
        printReport();
        return;
    }

    // ── 静态检查 ──────────────────────────────────────────────
    checks.config.check(resolvedPath, results);
    checks.idNaming.check(resolvedPath, results);
    checks.rpcNaming.check(resolvedPath, results);
    checks.jsonrpcProtocol.check(resolvedPath, results);
    checks.security.check(resolvedPath, results);
    checks.logging.check(resolvedPath, results);
    checks.introspection.check(resolvedPath, results);
    checks.redisKeys.check(resolvedPath, results);
    checks.dependencies.check(resolvedPath, results);
    checks.routeConsistency.check(resolvedPath, results);
    checks.mockData.check(resolvedPath, results);
    checks.memoryLeakStatic.check(resolvedPath, results);
    checks.semantic.check(resolvedPath, results);
    checks.syntax.check(resolvedPath, results);
    checks.ed25519Handshake.check(resolvedPath, results);
    checks.category.check(resolvedPath, results);
    checks.nodeModules.check(resolvedPath, results);
    checks.pathCheck.check(resolvedPath, results);
    checks.testCoverage.check(resolvedPath, results);
    checks.testStructure.check(resolvedPath, results);
    checks.portalCompat.check(resolvedPath, results);
    checks.entityFactory.check(resolvedPath, results);
    checks.entitiesDefinition.check(resolvedPath, results);
    checks.softDelete.check(resolvedPath, results);
    checks.walContext.check(resolvedPath, results);
    checks.rediSearch.check(resolvedPath, results);
    checks.tasksCheck.check(resolvedPath, results);
    checks.throwCheck.check(resolvedPath, results);
    checks.inlineErrors.check(resolvedPath, results);
    checks.paginationSafety.check(resolvedPath, results);
    checks.redisTransaction.check(resolvedPath, results);
    checks.floatingPromise.check(resolvedPath, results);
    checks.taskThrottleCheck.check(resolvedPath, results);
    checks.deadConfigKey.check(resolvedPath, results);
    checks.workerTaskId.check(resolvedPath, results);
    checks.unboundedConcurrency.check(resolvedPath, results);
    checks.eventListenerLeak.check(resolvedPath, results);
    checks.intervalCleanup.check(resolvedPath, results);
    checks.childProcessSafety.check(resolvedPath, results);
    checks.simulationCoverage.check(resolvedPath, results);
    checks.paramSchema.check(resolvedPath, results);
    checks.eventsCheck.check(resolvedPath, results);
    checks.paramConventions.check(resolvedPath, results);
    checks.authForkCheck.check(resolvedPath, results);
    checks.publicSurfaceCheck.check(resolvedPath, results);
    checks.guideCheck.check(resolvedPath, results);

    // ── 运行时检查（服务已启动才有效，--static 跳过）─────────
    if (!isStatic) {
        await checks.startup.check(resolvedPath, results);
        await checks.testRunner.check(resolvedPath, results);
        await checks.memoryLeakDynamic.check(resolvedPath, results);
    }

    printReport();
}

main().catch(err => {
    console.error('❌ Checker failed:', err.message);
    process.exit(1);
});
