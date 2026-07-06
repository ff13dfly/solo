/**
 * 模块 10: 依赖版本一致性检查
 * 检测目标：对比 package.json 与根 api/package.json 的依赖版本
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const localPkgPath = path.join(servicePath, 'package.json');

    // 尝试找到根 package.json
    let rootPkgPath = path.join(servicePath, '../package.json');
    if (!fs.existsSync(rootPkgPath)) {
        rootPkgPath = path.join(servicePath, '../../package.json');
    }
    if (!fs.existsSync(rootPkgPath)) {
        rootPkgPath = path.join(servicePath, '../../../package.json');
    }

    if (!fs.existsSync(localPkgPath)) {
        results.errors.push(`❌ [依赖] 缺少 package.json`);
        return;
    }

    if (!fs.existsSync(rootPkgPath)) {
        results.warnings.push(`⚠️ [依赖] 无法找到根 package.json，跳过版本一致性检查`);
        return;
    }

    try {
        const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));

        const criticalDeps = ['express', 'redis', 'cors', 'body-parser'];
        const localDeps = { ...localPkg.dependencies, ...localPkg.devDependencies };
        const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };

        for (const dep of criticalDeps) {
            if (localDeps[dep] && rootDeps[dep]) {
                if (localDeps[dep] === rootDeps[dep]) {
                    results.passed.push(`✅ [依赖] ${dep} 版本一致: ${localDeps[dep]}`);
                } else {
                    results.warnings.push(`⚠️ [依赖] ${dep} 版本不一致: 本地 ${localDeps[dep]} vs 根 ${rootDeps[dep]}`);
                }
            }
        }

        // 检查禁用的加密依赖
        const forbiddenDeps = ['bcrypt', 'crypto-js', 'sha256', 'md5', 'argon2'];
        for (const dep of forbiddenDeps) {
            if (localPkg.dependencies && localPkg.dependencies[dep]) {
                results.warnings.push(`⚠️ [依赖] 发现禁用的加密库 "${dep}"。请移除并统一使用 "library/crypto"。`);
            }
        }
    } catch (e) {
        results.warnings.push(`⚠️ [依赖] 解析 package.json 失败: ${e.message}`);
    }
}

module.exports = { check };
