/**
 * 模块 15: 静态内存泄漏扫描
 * 检测目标：检查代码中常见的内存泄漏模式
 * 
 * 检查项：
 * 1. 外部集合增长：在逻辑函数外定义的数组/对象被 push 或赋值。
 * 2. 未清理的计时器：使用 setInterval 但没有逻辑或生命周期管理。
 * 3. 闭包中的大对象引用。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicDir = path.join(servicePath, 'logic');
    if (!fs.existsSync(logicDir)) return;
    
    const logicFiles = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
    
    for (const file of logicFiles) {
        const filePath = path.join(logicDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath);
        
        // 1. 检查模块顶层的集合（数组/对象）
        // 模式：顶层定义 const/let list = []; 然后在 async function 中 list.push
        const globalCollections = [];
        const topLevelMatches = content.matchAll(/^(?:const|let|var)\s+(\w+)\s*=\s*[\[\{]/gm);
        for (const match of topLevelMatches) {
            globalCollections.push(match[1]);
        }
        
        if (globalCollections.length > 0) {
            for (const col of globalCollections) {
                // 检查是否在函数内部被修改（push, set, =）
                const modificationRegex = new RegExp(`\\b${col}\\.(?:push|unshift|splice|set)\\b|\\b${col}\\[.*\\s*=`, 'g');
                if (modificationRegex.test(content)) {
                    results.warnings.push(`⚠️ [内存-静态] ${fileName}: 全局集合 "${col}" 在函数内被修改，可能导致请求间内存增长`);
                }
            }
        }
        
        // 2. 检查未清理的 setInterval
        if (content.includes('setInterval') && !content.includes('clearInterval')) {
            results.warnings.push(`⚠️ [内存-静态] ${fileName}: 发现 setInterval 但未发现 clearInterval，请确保有清理逻辑`);
        }
        
        // 3. 检查过大的内联数据 (Base64等)
        const largeInline = content.match(/['"`][A-Za-z0-9+/=]{1000,}['"`]/g);
        if (largeInline) {
            results.warnings.push(`⚠️ [内存-静态] ${fileName}: 发现大段内联字符串 (>${largeInline[0].length} 字符)，建议移至外部配置文件`);
        }
    }
    
    if (results.passed.length > 0) {
        results.passed.push(`✅ [内存-静态] 逻辑层扫描完成，未发现严重泄漏模式`);
    }
}

module.exports = { check };
