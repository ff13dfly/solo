/**
 * 模块 14: 测试用例执行检查
 * 检测目标：运行微服务的测试用例，确保所有测试通过
 * 
 * 检测方式：
 * 1. 检查 package.json 是否有 test 脚本
 * 2. 检查 tests/ 目录是否存在测试文件
 * 3. 执行 npm test 并验证结果
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function check(servicePath, results) {
    const packagePath = path.join(servicePath, 'package.json');
    const testsDir = path.join(servicePath, 'tests');
    const testDir = path.join(servicePath, 'test');
    
    // 检查 package.json 是否存在
    if (!fs.existsSync(packagePath)) {
        results.warnings.push(`⚠️ [Tests] 跳过检查 - 缺少 package.json`);
        return;
    }
    
    // 检查是否有测试目录
    const hasTestsDir = fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory();
    const hasTestDir = fs.existsSync(testDir) && fs.statSync(testDir).isDirectory();
    
    if (!hasTestsDir && !hasTestDir) {
        results.errors.push(`❌ [Tests] 缺少 tests/ 或 test/ 目录 - 每个微服务必须有测试`);
        return;
    }
    
    // 检查测试目录是否有测试文件（递归搜索）
    const actualTestDir = hasTestsDir ? testsDir : testDir;
    
    function findTestFiles(dir) {
        let files = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                files = files.concat(findTestFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                files.push(fullPath);
            }
        }
        return files;
    }
    
    const testFiles = findTestFiles(actualTestDir);
    
    if (testFiles.length === 0) {
        results.errors.push(`❌ [Tests] 测试目录为空 - 必须包含测试文件`);
        return;
    }
    
    results.passed.push(`✅ [Tests] 找到 ${testFiles.length} 个测试文件`);
    
    // 检查 package.json 是否有 test 脚本
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    } catch (e) {
        results.errors.push(`❌ [Tests] 无法解析 package.json: ${e.message}`);
        return;
    }
    
    if (!pkg.scripts || !pkg.scripts.test) {
        results.errors.push(`❌ [Tests] package.json 中未定义 test 脚本`);
        return;
    }
    
    // 检查是否是默认的占位符脚本
    const testScript = pkg.scripts.test;
    if (testScript.includes('no test specified') || testScript === 'exit 1') {
        results.errors.push(`❌ [Tests] test 脚本为默认占位符 - 请实现实际测试`);
        return;
    }
    
    // 有 test 脚本，执行 npm test
    results.passed.push(`✅ [Tests] 找到 test 脚本: "${testScript}"`);
    
    try {
        const output = execSync('npm test', {
            cwd: servicePath,
            timeout: 60000,  // 60秒超时
            stdio: 'pipe',
            env: { ...process.env, NODE_ENV: 'test' }
        });
        
        const stdout = output.toString();
        
        // 解析测试结果
        const passMatch = stdout.match(/(\d+)\s*(?:passing|passed|✓)/i);
        const failMatch = stdout.match(/(\d+)\s*(?:failing|failed|✗)/i);
        
        const passed = passMatch ? parseInt(passMatch[1]) : 0;
        const failed = failMatch ? parseInt(failMatch[1]) : 0;
        
        if (failed > 0) {
            results.errors.push(`❌ [Tests] npm test 失败: ${failed} 个测试未通过`);
        } else if (passed > 0) {
            results.passed.push(`✅ [Tests] npm test 成功: ${passed} 个测试通过`);
        } else {
            results.passed.push(`✅ [Tests] npm test 执行完成`);
        }
        
    } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : '';
        const stdout = e.stdout ? e.stdout.toString() : '';
        
        // 检查是否是测试失败（而非运行错误）
        if (stderr.includes('FAIL') || stdout.includes('FAIL') || 
            stderr.includes('failing') || stdout.includes('failing')) {
            
            const failMatch = (stderr + stdout).match(/(\d+)\s*(?:failing|failed)/i);
            const failCount = failMatch ? failMatch[1] : '?';
            results.errors.push(`❌ [Tests] npm test 失败: ${failCount} 个测试未通过`);
        } else if (e.message.includes('TIMEOUT')) {
            results.errors.push(`❌ [Tests] npm test 超时 (>60s)`);
        } else {
            // 运行错误
            const errorLine = (stderr || e.message).split('\n')[0];
            results.errors.push(`❌ [Tests] npm test 运行失败: ${errorLine}`);
        }
    }
}

module.exports = { check };
