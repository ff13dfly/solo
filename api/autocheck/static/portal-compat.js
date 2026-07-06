/**
 * 模块 26: Portal 兼容性检查
 * 检测目标：确保微服务与 Operator Portal 的 Model-Driven UI 完美兼容
 * 
 * 1. 检查是否允许本地播种 (127.0.0.1 bypass) - 避免 seeding 失败导致 portal 无数据
 * 2. 检查是否在 GenericList.tsx 中修复了长表头挤压问题
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    // 1. 检查 Auth 绕过逻辑 (用于播种)
    const authPath = path.join(servicePath, 'handlers/auth.js');
    if (fs.existsSync(authPath)) {
        const authContent = fs.readFileSync(authPath, 'utf-8');
        const hasBypass = authContent.includes('req.ip === \'127.0.0.1\'') || authContent.includes('req.hostname === \'localhost\'');
        const hasWarning = authContent.includes('logger.warn') && authContent.includes('Local Auth Bypass active');
        const hasDocs = authContent.includes('Z-Handshake Bypass') && authContent.includes('@security_constraints');

        if (hasBypass && hasWarning && hasDocs) {
            results.passed.push(`✅ [Portal] 发现标准本地安全绕过逻辑 (带详尽文档与日志)`);
        } else if (hasBypass) {
            results.warnings.push(`⚠️ [Portal] 发现本地安全绕过逻辑，但缺少标准文档或日志警告`);
        } else {
            results.warnings.push(`⚠️ [Portal] 缺少本地安全绕过逻辑，可能导致 mock_data.js 播种失败`);
        }
    }

    // 2. 检查 GenericList 布局 (全局检查)
    const listPath = path.resolve(servicePath, '../../../portal/operator/src/pages/default/GenericList.tsx');
    if (fs.existsSync(listPath)) {
        const listContent = fs.readFileSync(listPath, 'utf-8');
        if (listContent.includes('overflowX: \'auto\'') || listContent.includes('minWidth')) {
            results.passed.push(`✅ [Portal] GenericList 支持横向滚动 (长表头兼容)`);
        } else {
            results.errors.push(`❌ [Portal] GenericList 缺少横向滚动支持，长表头会产生挤压`);
        }
    }
}

module.exports = { check };
