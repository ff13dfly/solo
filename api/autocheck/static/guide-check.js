/**
 * 模块: fleet-standard guide 覆盖检查 (Guide Coverage Check)
 *
 * 检测目标：让"用 Solo 框架的开发者/AI 知道每个服务都该提供 guide"这件事有显式抓手，
 * 而不只靠 api/sample 模板照猫画虎。检查两点：
 *   1. index.js 的 handlers 表接线了 fleet-standard `guide` 方法
 *      （`'guide': () => require('.../library/guide').readGuide('<svc>', __dirname)`）。
 *      少了它，外部 AI 代理经 `system.guide { service }` 拿不到该服务的任务配方。
 *   2. 服务根目录有 GUIDE.md 文件。方法接了但文件缺失时，readGuide 会返回
 *      `{ available: false }`——等于"没提供"，router 侧优雅降级、静默，最易被漏。
 *
 * 级别：WARN（不阻断部署）。guide 是尽力而为——router `system.guide` 对缺失优雅降级，
 * 且历史上多数服务是"方法已接、GUIDE.md 未写"的状态，设成 ERROR 会一次炸一片。
 * autocheck 已挂 PostToolUse 钩子，WARN 也会每次改完呈现给作者，足以起提醒作用。
 *
 * 背景：docs/feedback/ai-agent-self-describing-api.md（AI 自描述 API），
 * fleet-standard 系统方法 ping/methods/entities/events/guide（见项目 CLAUDE.md §5）。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const indexPath = path.join(servicePath, 'index.js');
    // 无 index.js 的目录不是标准可路由服务（structure 检查已在前把关），跳过。
    if (!fs.existsSync(indexPath)) {
        return;
    }

    const indexContent = fs.readFileSync(indexPath, 'utf-8');

    // handlers 表里注册 'guide' 方法的字面特征：引号包裹的 guide + 冒号。
    // 'system.guide' / readGuide( 不会误命中（前者点号、后者无引号）。
    const wired = /['"]guide['"]\s*:/.test(indexContent);

    const guideMdPath = path.join(servicePath, 'GUIDE.md');
    const hasGuideMd = fs.existsSync(guideMdPath);

    if (wired) {
        results.passed.push(`✅ [guide] fleet-standard 'guide' 方法已接线`);
    } else {
        results.warnings.push(
            `⚠️  [guide] index.js 未接线 fleet-standard 'guide' 方法——外部 AI 代理` +
            `经 system.guide { service } 拿不到本服务的任务配方。\n` +
            `       补一行到 handlers 表: 'guide': () => require('../../library/guide').readGuide('<service>', __dirname)`
        );
    }

    if (hasGuideMd) {
        results.passed.push(`✅ [guide] GUIDE.md 存在`);
    } else {
        results.warnings.push(
            `⚠️  [guide] 缺 GUIDE.md（服务根目录）` +
            (wired
                ? `——guide 方法虽已接，但无文件时 readGuide 返回 available:false（等于未提供，且静默降级）。`
                : `。`) +
            `\n       写一份任务配方（跨方法操作顺序 / 幂等键 / 字段约定），参考 api/sample/GUIDE.md、api/apps/storage/GUIDE.md。`
        );
    }
}

module.exports = { check };
