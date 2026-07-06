/**
 * 模块 7: config.js 校验
 * 检测目标：验证 idLengths, pageSize 等必需配置项
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const configPath = path.join(servicePath, 'config.js');
    if (!fs.existsSync(configPath)) {
        results.errors.push(`❌ [配置] 缺少 config.js`);
        return;
    }
    
    const content = fs.readFileSync(configPath, 'utf-8');
    
    // 检查必需配置项
    const requiredConfigs = ['serviceName', 'port', 'redisUrl'];
    for (const cfg of requiredConfigs) {
        if (content.includes(cfg)) {
            results.passed.push(`✅ [配置] 包含必需项: ${cfg}`);
        } else {
            results.errors.push(`❌ [配置] 缺少必需项: ${cfg}`);
        }
    }
    
    // port 接受两种合法写法：
    //   1. portFor(name, fallback)           — 推荐，由 library/ports.js 统一解析
    //   2. process.env.PORT || N             — 传统写法，仍然 work（portFor 内部也只是这套逻辑的封装）
    // 不接受：自定义端口环境变量（如 AGENT_PORT、SAMPLE_PORT 等），破坏统一接口约定。
    if (/port\s*:\s*portFor\s*\(/.test(content)) {
        results.passed.push(`✅ [配置] port 使用 portFor(name, fallback) — 推荐`);
    } else if (/port\s*:\s*process\.env\.PORT\s*\|\|/.test(content)) {
        results.passed.push(`✅ [配置] port 使用 process.env.PORT（建议升级到 portFor）`);
    } else if (/port\s*:\s*process\.env\.\w+PORT\s*\|\|/.test(content)) {
        results.errors.push(`❌ [配置] port 使用了非标准环境变量（如 AGENT_PORT），必须改为 portFor(name, fallback) 或 process.env.PORT`);
    } else if (/port\s*:/.test(content)) {
        results.warnings.push(`⚠️  [配置] port 字段写法无法识别，请使用 portFor(name, fallback) 或 process.env.PORT || N`);
    }

    // 检查推荐配置项
    const recommendedConfigs = ['idLengths', 'pageSize', 'version'];
    for (const cfg of recommendedConfigs) {
        if (content.includes(cfg)) {
            results.passed.push(`✅ [配置] 包含推荐项: ${cfg}`);
        } else {
            results.warnings.push(`⚠️ [配置] 缺少推荐项: ${cfg}`);
        }
    }

    // ── description.en.main 是 MCP 可用性要求 ──────────────────
    // Router 握手时读取 description，外部 AI 通过 system.manifest 获取服务语义
    // 格式要求：description.en.main 为非空字符串数组
    if (/description\s*:/.test(content) && /en\s*:/.test(content) && /main\s*:/.test(content)) {
        results.passed.push(`✅ [配置] 包含 description.en.main（服务语义描述）`);
    } else {
        results.warnings.push(
            `⚠️  [配置] 缺少 description.en.main — 外部 AI 无法通过 system.manifest 获取服务语义\n` +
            `       参考格式：description: { en: { main: ['描述1', '描述2'], methods: { ... } } }`
        );
    }

    // ── methods 返回格式需包含 description ─────────────────────
    const indexPath = path.join(servicePath, 'index.js');
    if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        // 检查 methods handler 是否返回 { methods, description } 格式
        const methodsReturnsObj = /['"]methods['"]\s*:\s*\(\s*\)\s*=>\s*\(\s*\{/.test(indexContent) ||
                                  /['"]methods['"]\s*:\s*\(\s*\)\s*=>\s*\{/.test(indexContent);
        const hasDescription = methodsReturnsObj && /description/.test(
            (indexContent.match(/['"]methods['"]\s*:\s*\(\s*\)\s*=>.*/) || [''])[0]
        );
        if (hasDescription || /methods.*description|description.*methods/.test(
            indexContent.split('\n').find(l => l.includes("'methods'") || l.includes('"methods"')) || ''
        )) {
            results.passed.push(`✅ [配置] methods 返回格式包含 description（Router 握手可获取服务语义）`);
        } else {
            results.warnings.push(
                `⚠️  [配置] methods 处理器返回纯数组，Router 握手时无法获取服务语义\n` +
                `       改为：'methods': () => ({ methods: introspectionMethods, description: config.description || {} })`
            );
        }
    }

    // 检查 logic 层是否硬编码了分页数字（应使用 config.pageSize）
    const logicDir = path.join(servicePath, 'logic');
    if (fs.existsSync(logicDir)) {
        const logicFiles = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));

        // 匹配分页上下文中的硬编码数字：
        //   .slice(0, 20)  .slice(0, 100)
        //   limit: 20      limit: 100
        //   LIMIT 20       pageSize = 20
        // 排除合理的小数字：0, 1, 2（常用于索引/布尔场景）
        const hardcodedPagePattern = /(?:\.slice\s*\(\s*(?:offset\s*,\s*)?(\d{2,4})\s*\)|(?:limit|LIMIT|pageSize)\s*[=:]\s*(\d{2,4}))/g;

        for (const file of logicFiles) {
            const lContent = fs.readFileSync(path.join(logicDir, file), 'utf-8');
            let m;
            hardcodedPagePattern.lastIndex = 0;
            while ((m = hardcodedPagePattern.exec(lContent)) !== null) {
                const num = m[1] || m[2];
                // 豁免：出现在注释行
                const lineIdx = lContent.slice(0, m.index).split('\n').length - 1;
                const lineText = lContent.split('\n')[lineIdx] || '';
                if (lineText.trimStart().startsWith('//') || lineText.trimStart().startsWith('*')) continue;
                // 豁免：已引用 config.pageSize（说明当前行是做默认值对比）
                if (lineText.includes('config.pageSize') || lineText.includes('pageSize')) continue;
                // 豁免：测试/种子文件
                if (file.includes('seed') || file.includes('test') || file.includes('mock')) continue;

                results.warnings.push(
                    `⚠️ [配置] logic/${file}:${lineIdx + 1}: 硬编码分页数字 ${num}，` +
                    `建议改为 config.pageSize（配置变更时无需修改代码）`
                );
            }
        }
    }
}

module.exports = { check };
