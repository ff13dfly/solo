/**
 * 模块: WAL Context 注入检查
 * 检测目标：确保微服务在 JSON-RPC 入口注入 walContext 以记录操作用户 UID
 *
 * 规则：
 * 1. index.js 必须导入 walContext
 * 2. JSON-RPC handler 必须使用 walContext.run() 包裹
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const indexPath = path.join(servicePath, 'index.js');

    if (!fs.existsSync(indexPath)) {
        return;
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    const isAppService = servicePath.includes(`${path.sep}apps${path.sep}`);

    // Check 1: walContext imported
    const importsWalContext = content.includes('walContext') && content.includes('library/entity');

    // Check 2: walContext.run() used
    const usesWalRun = content.includes('walContext.run(');

    if (importsWalContext && usesWalRun) {
        results.passed.push('✅ [WAL] index.js 已注入 walContext 用于审计日志');

        // Check 3: uses req.user (Router payload.user is a string in apps services)
        if (content.includes('req.user ||') || content.includes('req.user,')) {
            results.passed.push('✅ [WAL] walContext 正确使用 req.user');
        } else if (content.includes('req.user?.uid')) {
            results.warnings.push('⚠️ [WAL] req.user 在 apps 服务中是字符串，req.user?.uid 始终为 undefined，应改为 req.user');
        }
    } else {
        const level = isAppService ? 'errors' : 'warnings';
        const icon = isAppService ? '❌' : '⚠️';

        if (!importsWalContext) {
            results[level].push(`${icon} [WAL] index.js 未导入 walContext (require('library/entity').walContext)`);
        }
        if (!usesWalRun) {
            results[level].push(`${icon} [WAL] index.js 未使用 walContext.run() 包裹 JSON-RPC handler`);
        }
    }
}

module.exports = { check };
