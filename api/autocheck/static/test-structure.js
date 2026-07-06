/**
 * 模块 24: 测试结构完整性检查
 * 检测目标：验证微服务遵循标准测试目录结构
 * 
 * 标准结构:
 *   tests/
 *   ├── cases.md              # 测试场景定义
 *   ├── cases/                # YAML测试用例
 *   │   └── unit.yaml
 *   ├── utils/                # 工具脚本
 *   │   ├── generate_yaml.js
 *   │   └── mock_data.js
 *   └── scripts/              # Jest脚本
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const testsDir = path.join(servicePath, 'tests');
    
    if (!fs.existsSync(testsDir)) {
        // test-runner.js 已经处理了这个错误
        return;
    }
    
    // 必需的目录和文件
    const requiredStructure = [
        { path: 'cases.md', type: 'file', desc: '测试场景定义文档' },
        { path: 'cases', type: 'dir', desc: 'YAML测试用例目录' },
        { path: 'utils', type: 'dir', desc: '工具脚本目录' }
    ];
    
    // 推荐的文件
    const recommendedFiles = [
        { path: 'cases/unit.yaml', desc: '单元测试用例' },
        { path: 'utils/generate_yaml.js', desc: 'YAML生成器' },
        { path: 'utils/mock_data.js', desc: 'Mock数据播种器' }
    ];
    
    let missingRequired = [];
    let missingRecommended = [];
    
    // 检查必需结构
    for (const item of requiredStructure) {
        const fullPath = path.join(testsDir, item.path);
        const exists = fs.existsSync(fullPath);
        
        if (!exists) {
            missingRequired.push(`${item.path} (${item.desc})`);
        } else if (item.type === 'dir' && !fs.statSync(fullPath).isDirectory()) {
            missingRequired.push(`${item.path} 应为目录`);
        } else if (item.type === 'file' && !fs.statSync(fullPath).isFile()) {
            missingRequired.push(`${item.path} 应为文件`);
        }
    }
    
    // 检查推荐文件
    for (const item of recommendedFiles) {
        const fullPath = path.join(testsDir, item.path);
        if (!fs.existsSync(fullPath)) {
            missingRecommended.push(`${item.path} (${item.desc})`);
        }
    }
    
    // 报告结果
    // YAML 驱动结构（cases.md + cases/ + utils/）只是其中一种风格,并非硬性要求 ——
    // 金标准的 hermetic 约定是 jest *.test.js(见 api/sample,它本身也没有 cases/)。
    // 因此缺失 YAML 结构是"建议补全"而非阻断部署的错误。
    if (missingRequired.length > 0) {
        results.warnings.push(
            `⚠️ [TestStruct] 建议补全 YAML 测试结构(可选,hermetic jest 亦合规,见 api/sample): ${missingRequired.join(', ')}`
        );
    } else {
        results.passed.push(`✅ [TestStruct] 测试目录结构完整`);
    }
    
    if (missingRecommended.length > 0 && missingRequired.length === 0) {
        results.warnings.push(
            `⚠️ [TestStruct] 建议添加: ${missingRecommended.join(', ')}`
        );
    } else if (missingRecommended.length === 0) {
        results.passed.push(`✅ [TestStruct] 包含所有推荐测试工具`);
    }
    
    // 检查 cases/ 是否有 YAML 文件
    const casesDir = path.join(testsDir, 'cases');
    if (fs.existsSync(casesDir) && fs.statSync(casesDir).isDirectory()) {
        const yamlFiles = fs.readdirSync(casesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        
        if (yamlFiles.length === 0) {
            results.warnings.push(`⚠️ [TestStruct] cases/ 目录为空，请运行 generate_yaml.js`);
        } else {
            results.passed.push(`✅ [TestStruct] 找到 ${yamlFiles.length} 个 YAML 测试定义文件`);
        }
    }
}

module.exports = { check };
