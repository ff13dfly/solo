/**
 * 模块 21: 本地 node_modules 检测
 * 检测目标：确保微服务不包含独立的 node_modules 目录
 * 
 * 问题：其他 AI 开发时可能在微服务目录下安装独立的依赖包
 * 风险：
 *   - 引入不可控的第三方包
 *   - 版本不一致
 *   - 难以审计
 *   - Git 状态无法反映依赖变更
 * 
 * 规范：
 *   - 所有依赖应安装在 api/package.json
 *   - 微服务目录下不应有 node_modules
 *   - 微服务的 package.json 仅用于脚本定义，不应有 dependencies
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const nodeModulesPath = path.join(servicePath, 'node_modules');
    const packageJsonPath = path.join(servicePath, 'package.json');
    
    // 检查 1: 是否存在 node_modules 目录
    if (fs.existsSync(nodeModulesPath)) {
        const stats = fs.statSync(nodeModulesPath);
        
        if (stats.isDirectory()) {
            // 列出 node_modules 中的包
            try {
                const modules = fs.readdirSync(nodeModulesPath)
                    .filter(name => !name.startsWith('.'));
                
                if (modules.length > 0) {
                    const moduleList = modules.slice(0, 5).join(', ');
                    const suffix = modules.length > 5 ? ` 等 ${modules.length} 个包` : '';
                    
                    results.errors.push(
                        `❌ [Deps] 检测到本地 node_modules 目录 (${moduleList}${suffix})`
                    );
                    results.errors.push(
                        `❌ [Deps] 请将依赖添加到 api/package.json 并删除本地 node_modules`
                    );
                } else {
                    results.warnings.push(
                        `⚠️ [Deps] 存在空的 node_modules 目录，建议删除`
                    );
                }
            } catch (e) {
                results.errors.push(
                    `❌ [Deps] 无法读取 node_modules 目录: ${e.message}`
                );
            }
        }
    } else {
        results.passed.push(`✅ [Deps] 无本地 node_modules (符合规范)`);
    }
    
    // 检查 2: package.json 中是否有 dependencies
    if (fs.existsSync(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            
            // 检查 dependencies
            if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
                const deps = Object.keys(packageJson.dependencies);
                const depList = deps.slice(0, 3).join(', ');
                const suffix = deps.length > 3 ? ` 等 ${deps.length} 个` : '';
                
                results.errors.push(
                    `❌ [Deps] package.json 包含 dependencies (${depList}${suffix})`
                );
                results.errors.push(
                    `❌ [Deps] 微服务 package.json 不应有 dependencies，请迁移到 api/package.json`
                );
            } else {
                results.passed.push(`✅ [Deps] package.json 无 dependencies (符合规范)`);
            }
            
            // 检查 devDependencies
            if (packageJson.devDependencies && Object.keys(packageJson.devDependencies).length > 0) {
                const deps = Object.keys(packageJson.devDependencies);
                const depList = deps.slice(0, 3).join(', ');
                
                results.warnings.push(
                    `⚠️ [Deps] package.json 包含 devDependencies (${depList})`
                );
                results.warnings.push(
                    `⚠️ [Deps] 建议将 devDependencies 迁移到 api/package.json`
                );
            }
            
            // 检查 scripts (允许存在)
            if (packageJson.scripts) {
                const scriptCount = Object.keys(packageJson.scripts).length;
                if (scriptCount > 0) {
                    results.passed.push(`✅ [Deps] package.json 包含 ${scriptCount} 个脚本定义`);
                }
            }
            
        } catch (e) {
            results.warnings.push(`⚠️ [Deps] 无法解析 package.json: ${e.message}`);
        }
    }
    
    // 检查 3: 是否存在 package-lock.json 或 yarn.lock
    const lockFiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
    for (const lockFile of lockFiles) {
        const lockPath = path.join(servicePath, lockFile);
        if (fs.existsSync(lockPath)) {
            results.errors.push(
                `❌ [Deps] 检测到本地 ${lockFile}，表明有独立安装依赖`
            );
        }
    }
}

module.exports = { check };
