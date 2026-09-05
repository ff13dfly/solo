#!/usr/bin/env node
/**
 * checker.js - Solo Microservice Quality Checker
 *
 * 两种检测模式（均在此入口触发）：
 *
 *   静态检测（无需服务运行）：
 *     node api/autocheck/checker.js api/apps/storage [--static]
 *
 *   单规则检测（任意路径，跳过服务形状脚手架校验）：
 *     node api/autocheck/checker.js api/router --rules=bind-address [--strict]
 *
 * --strict 把 WARNING 也算失败（用于已清干净、不许回退的路径）。
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

// --strict：把 WARNING 也算作失败。
// @why 多数规则刻意定成 WARN（存量服务普遍是老写法，设 ERROR 会一次炸一片）。但对一条
//   **已经清干净的路径**，同一条 WARN 就该是阻断级——否则"加进 CI"只是多打一行字，
//   回退时照样绿。典型用法：CI 用 `--rules=bind-address --strict` 钉住 api/router。
let STRICT = false;

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
        if (STRICT) {
            console.log('❌ RESULT: FAILED (--strict) - warnings are blocking on this path.');
            process.exit(1);
        }
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
    const isLib = args.includes('--lib');
    // --rules=a,b — run ONLY the named rules against any path, skipping the service-shape
    // scaffolding checks. Generalizes what --lib does for api/library/.
    //
    // @why Some processes are real, load-bearing, and NOT service-shaped, so the per-service
    //   loop cannot cover them — most of all api/router/ (pointing checker.js at it yields 12
    //   errors: no serviceName, no handshake routes, system methods unlisted, …). The Router
    //   was therefore the ONE process no rule ever looked at, which is exactly how it stayed
    //   the only `app.listen` in the tree without bindAddr() while all nine core services got
    //   it — a gate that covers everything except the entry point covers the wrong set.
    //   (docs/feedback/done/router-alone-skips-bindaddr.md)
    STRICT = args.includes('--strict');
    const rulesArg = args.find(a => a.startsWith('--rules='));
    const onlyRules = rulesArg ? rulesArg.slice('--rules='.length).split(',').map(r => r.trim()).filter(Boolean) : null;
    const targetPath = args.find(a => !a.startsWith('--')) || '.';
    const resolvedPath = path.resolve(targetPath);

    console.log('\n🔍 Solo Microservice Checker v4.0.0');
    console.log(`📁 Target: ${resolvedPath}`);
    if (isLib) console.log('📚 Mode: lib (flat api/library/-style dir — redis 反模式规则子集，不套服务脚手架校验)\n');
    else if (isStatic) console.log('⚡ Mode: static (runtime checks skipped)\n');
    else console.log('');

    if (onlyRules) {
        // Accept both the index key (bindAddress) and the file name (bind-address).
        const byFileName = (n) => n.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const unknown = [];
        for (const name of onlyRules) {
            const key = checks[name] ? name : (checks[byFileName(name)] ? byFileName(name) : null);
            if (!key) { unknown.push(name); continue; }
            checks[key].check(resolvedPath, results);
        }
        if (unknown.length) {
            results.errors.push(`❌ [checker] --rules 指定了不存在的规则: ${unknown.join(', ')}（可用名见 autocheck/static/index.js 的导出键）`);
        }
        printReport();
        return;
    }

    if (isLib) {
        // api/library/ 等共享库没有 index.js/handlers/logic/ 服务脚手架，structure.check
        // 会把它当"纯文档/设计阶段服务"跳过（或反过来对缺失的 logic/handlers 报一堆假错误）。
        // entity.js 的全量拉取反模式、后来的 scanIterator v5 批次坑，都曾在 api/library 里
        // 潜伏而没被 checker.js 扫到——因为 checker.js 从没被指向过这个目录。这里只跑
        // 跟目录形状无关的 redis 反模式规则子集，不套用服务结构假设。
        checks.redisKeys.check(resolvedPath, results);
        checks.paginationSafety.check(resolvedPath, results);
        checks.redisScanNormalize.check(resolvedPath, results);
        printReport();
        return;
    }

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
    checks.bindAddress.check(resolvedPath, results);
    checks.paginationSafety.check(resolvedPath, results);
    checks.redisScanNormalize.check(resolvedPath, results);
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
    checks.clockCheck.check(resolvedPath, results);

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
