/**
 * 模块 23: 测试覆盖率检查
 * 检测目标：验证测试用例是否全面覆盖微服务功能
 * 
 * 检测项：
 *   1. 测试数量是否足够（基于 introspection 方法数估算）
 *   2. 测试是否覆盖关键领域（Config, Logic, Introspection, Entities, Handlers）
 *   3. 测试是否验证 introspection 与路由一致性
 */

const fs = require('fs');
const path = require('path');

// 最小测试数量阈值 (基于服务复杂度)
const MIN_TESTS_SIMPLE = 5;      // 简单服务 (<10 methods)
const MIN_TESTS_MEDIUM = 15;     // 中等服务 (10-30 methods)
const MIN_TESTS_COMPLEX = 25;    // 复杂服务 (>30 methods)

// 必需的测试类别关键词
const REQUIRED_CATEGORIES = [
    { name: 'Config', patterns: ['config', 'Config', 'configuration'] },
    { name: 'Logic', patterns: ['logic', 'Logic', 'module', 'factory'] },
    { name: 'Introspection', patterns: ['introspection', 'Introspection', 'method'] },
];

function check(servicePath, results) {
    const testsDir = path.join(servicePath, 'tests');
    const testDir = path.join(servicePath, 'test');
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    
    const actualTestDir = fs.existsSync(testsDir) ? testsDir : 
                          fs.existsSync(testDir) ? testDir : null;
    
    if (!actualTestDir) {
        // test-runner.js 已经处理了这个错误
        return;
    }
    
    // 获取服务复杂度 (基于 introspection 方法数)
    let methodCount = 0;
    if (fs.existsSync(introspectionPath)) {
        try {
            delete require.cache[require.resolve(introspectionPath)];
            const methods = require(introspectionPath);
            methodCount = Array.isArray(methods) ? methods.length : 0;
        } catch (e) {
            // 忽略加载错误
        }
    }
    
    // 确定最小测试数量阈值
    let minTests = MIN_TESTS_SIMPLE;
    if (methodCount > 30) {
        minTests = MIN_TESTS_COMPLEX;
    } else if (methodCount > 10) {
        minTests = MIN_TESTS_MEDIUM;
    }
    
    // 读取所有测试文件内容
    let testContent = '';
    let testFileCount = 0;
    
    function readTestFiles(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                readTestFiles(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                testContent += fs.readFileSync(fullPath, 'utf-8') + '\n';
                testFileCount++;
            }
        }
    }
    
    readTestFiles(actualTestDir);
    
    // 检查 1: 估算测试数量
    // 基于 test() 或 it() 调用次数估算
    const testCalls = (testContent.match(/\btest\s*\(/g) || []).length +
                      (testContent.match(/\bit\s*\(/g) || []).length;
    
    if (testCalls < minTests) {
        results.warnings.push(
            `⚠️ [Coverage] 测试数量偏低: ${testCalls} 个 (建议 >=${minTests} 个，当前服务有 ${methodCount} 个 RPC 方法)`
        );
    } else {
        results.passed.push(
            `✅ [Coverage] 测试数量充足: ${testCalls} 个 (服务有 ${methodCount} 个 RPC 方法)`
        );
    }
    
    // 检查 2: 测试类别覆盖
    const missingCategories = [];
    for (const cat of REQUIRED_CATEGORIES) {
        const found = cat.patterns.some(p => testContent.includes(p));
        if (!found) {
            missingCategories.push(cat.name);
        }
    }
    
    if (missingCategories.length > 0) {
        results.warnings.push(
            `⚠️ [Coverage] 测试未覆盖以下类别: ${missingCategories.join(', ')}`
        );
    } else {
        results.passed.push(
            `✅ [Coverage] 测试覆盖所有必需类别: Config, Logic, Introspection`
        );
    }
    
    // 检查 3: introspection-route 一致性测试
    if (testContent.includes('introspection') && 
        (testContent.includes('index.js') || testContent.includes('routed'))) {
        results.passed.push(`✅ [Coverage] 测试验证了 introspection 与路由一致性`);
    } else if (methodCount > 10) {
        results.warnings.push(
            `⚠️ [Coverage] 建议添加测试验证 introspection 方法是否全部路由`
        );
    }
    
    // 检查 4: Entity Schema 测试 (如果有 entities.js)
    const entitiesPath = path.join(servicePath, 'handlers/entities.js');
    if (fs.existsSync(entitiesPath)) {
        if (testContent.includes('entities') || testContent.includes('Entity')) {
            results.passed.push(`✅ [Coverage] 测试覆盖了 Entity Schema`);
        } else {
            results.warnings.push(`⚠️ [Coverage] 建议添加 Entity Schema 验证测试`);
        }
    }
    
    // 检查 5: AI 描述覆盖测试 (如果有 description)
    if (testContent.includes('description') && 
        (testContent.includes('en') || testContent.includes('zh'))) {
        results.passed.push(`✅ [Coverage] 测试覆盖了 AI 描述完整性`);
    } else if (methodCount > 10) {
        results.warnings.push(
            `⚠️ [Coverage] 建议添加测试验证 AI 描述 (description.en/zh) 是否覆盖所有方法`
        );
    }
}

module.exports = { check };
