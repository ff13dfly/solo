/**
 * 模块: 模拟测试覆盖检测
 *
 * 检测目标：每个微服务在 autocheck/simulation/scenarios/{serviceName}/ 下
 *           至少有一个 .js 测试场景文件。
 *
 * 规则：
 *   ✅ scenarios/storage/concurrent-upload.js 存在 → 通过
 *   ⚠️ scenarios/sale/ 目录不存在或为空       → 提示补充
 *
 * 级别：warning（不阻断构建，但提示覆盖缺口）
 */

const fs   = require('fs');
const path = require('path');

// scenarios 目录相对于本文件的位置：static/ → autocheck/ → simulation/scenarios/
const SCENARIOS_ROOT = path.join(__dirname, '../simulation/scenarios');

function check(servicePath, results) {
    const configPath = path.join(servicePath, 'config.js');
    if (!fs.existsSync(configPath)) return;

    let config;
    try {
        delete require.cache[require.resolve(configPath)];
        config = require(configPath);
    } catch (e) {
        return;
    }

    const serviceName = config.serviceName;
    if (!serviceName) return;

    const scenarioDir = path.join(SCENARIOS_ROOT, serviceName);

    if (!fs.existsSync(scenarioDir)) {
        results.warnings.push(
            `⚠️ [SimCoverage] 服务 "${serviceName}" 缺少模拟测试目录: ` +
            `autocheck/simulation/scenarios/${serviceName}/`
        );
        return;
    }

    const files = fs.readdirSync(scenarioDir).filter(f => f.endsWith('.js'));
    if (files.length === 0) {
        results.warnings.push(
            `⚠️ [SimCoverage] 服务 "${serviceName}" 的模拟测试目录为空: ` +
            `autocheck/simulation/scenarios/${serviceName}/`
        );
    } else {
        results.passed.push(
            `✅ [SimCoverage] "${serviceName}" 已有模拟测试: ${files.join(', ')}`
        );
    }
}

module.exports = { check };
