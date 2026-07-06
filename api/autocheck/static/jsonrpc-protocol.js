/**
 * 模块 4: JSON-RPC 协议标准检查
 * 检测目标：验证是否使用本地 jsonrpc.js 并正确输出响应（sample/README.md §207）
 * 核心规则：每个微服务必须有自己的 handlers/jsonrpc.js，用于终结 HTTP 响应
 * 常见错误：直接使用 library/jsonrpc（它只返回对象，不调用 res.json()）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const indexPath = path.join(servicePath, 'index.js');
    const jsonrpcPath = path.join(servicePath, 'handlers/jsonrpc.js');
    
    // 检查是否存在本地 jsonrpc.js
    if (!fs.existsSync(jsonrpcPath)) {
        results.errors.push(`❌ [协议] 缺少 handlers/jsonrpc.js`);
        return;
    }
    results.passed.push(`✅ [协议] handlers/jsonrpc.js 存在`);
    
    // 检查 jsonrpc.js 是否包含 res.json 调用（直接或通过 re-export library/jsonrpc）
    const jsonrpcContent = fs.readFileSync(jsonrpcPath, 'utf-8');
    const hasDirectResponse = jsonrpcContent.includes('res.json');
    const isReexportOfLib   = jsonrpcContent.includes('library/jsonrpc');
    if (hasDirectResponse || isReexportOfLib) {
        results.passed.push(`✅ [协议] jsonrpc.js 正确终结响应`);
    } else {
        results.errors.push(`❌ [协议] jsonrpc.js 未调用 res.json() 且未 re-export library/jsonrpc`);
    }
    
    // 检查 index.js 是否正确引用
    if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        
        if (indexContent.includes("require('./handlers/jsonrpc')")) {
            results.passed.push(`✅ [协议] index.js 正确引用本地 jsonrpc.js`);
        } else if (indexContent.includes("require('../../library/jsonrpc')") ||
                   indexContent.includes("require('../library/jsonrpc')")) {
            results.errors.push(`❌ [协议] index.js 引用共享库 jsonrpc (必须使用本地 handlers/jsonrpc.js 终结响应)`);
        } else {
             results.warnings.push(`⚠️ [协议] index.js 未检测到 jsonrpc 引用 (可能是引用路径不标准)`);
        }

        // 检查是否暴露了标准 /jsonrpc 接口
        // 允许单引号或双引号
        if (indexContent.includes("'/jsonrpc'") || indexContent.includes('"/jsonrpc"')) {
            results.passed.push(`✅ [协议] index.js 已暴露标准接口 /jsonrpc`);
        } else {
            results.errors.push(`❌ [协议] index.js 缺少标准接口 /jsonrpc (Router 注册将失败)`);
        }
    }
}

module.exports = { check };
