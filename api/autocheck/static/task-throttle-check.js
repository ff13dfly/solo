/**
 * 模块 36: 节流与并发锁检测 (Task Throttle Check)
 * 检测目标：检查 index.js 中的 ping 路由如果包含了后台业务调用，是否加了锁或节流（如 Date.now() 比较）。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const indexPath = path.join(servicePath, 'index.js');
    if (!fs.existsSync(indexPath)) return;

    const content = fs.readFileSync(indexPath, 'utf-8');
    
    // 定位 ping 代码块
    const pingMatch = content.match(/if\s*\(\s*method\s*===\s*['"]ping['"]\s*\)\s*{([^}]*)}/);
    if (!pingMatch) return;

    const pingBlock = pingMatch[1];
    
    // 检查是否有除了 jsonrpc.success 之外的方法调用 (比如 Methods.record.expireDrawn)
    // 简单判断: 如果有以大写字母或 Methods 开头的调用，或者包含 catch()
    const hasBusinessLogic = pingBlock.includes('Methods.') || pingBlock.includes('catch(') || pingBlock.includes('redis.');
    
    if (hasBusinessLogic) {
        // 检查是否有节流/锁的特征词
        const hasThrottle = pingBlock.includes('Date.now()') || 
                            pingBlock.includes('SETNX') || 
                            pingBlock.includes('throttle') || 
                            pingBlock.includes('_last');
        
        if (!hasThrottle) {
            results.warnings.push(`⚠️ [并发-安全] index.js: 在 \`ping\` 路由中检测到了后台业务逻辑执行，但没有发现节流阀（Throttle）或分布式锁。健康检查高频并发时可能引发服务器雪崩！`);
        } else {
            results.passed.push(`✅ [并发-安全] index.js: \`ping\` 路由后台任务已加装节流阀/锁`);
        }
    } else {
        results.passed.push(`✅ [并发-安全] index.js: \`ping\` 路由为纯净健康检查，无重负荷操作`);
    }
}

module.exports = { check };
