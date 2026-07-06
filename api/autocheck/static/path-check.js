/**
 * 模块 22: Library 路径检查
 * 检测目标：验证微服务的 library 引用路径正确
 * 
 * 问题：在 api/apps/xxx 目录下的服务，相对路径容易出错：
 *   - 从 api/apps/xxx/ 引用 library 应使用 ../../library
 *   - 从 api/apps/xxx/handlers/ 引用 library 应使用 ../../../library
 *   - 从 api/apps/xxx/logic/ 引用 library 应使用 ../../../library
 * 
 * 另外检查 entity.js 的导入方式（直接导出 vs 解构）
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    // 获取服务在 api 目录下的深度
    const apiIndex = servicePath.indexOf('/api/');
    if (apiIndex === -1) {
        results.warnings.push(`⚠️ [Path] 无法确定服务相对于 api/ 的位置`);
        return;
    }
    
    const relativePath = servicePath.substring(apiIndex + 5); // 去掉 '/api/'
    const depth = relativePath.split('/').filter(Boolean).length;
    // depth 1 = api/sample, depth 2 = api/apps/crm
    
    const expectedCorePrefix = '../'.repeat(depth) + 'library/';
    const expectedCoreHandlers = '../'.repeat(depth + 1) + 'library/';
    
    // 检查各目录下的文件
    const filesToCheck = [
        { dir: '', prefix: expectedCorePrefix, files: ['index.js'] },
        { dir: 'handlers', prefix: expectedCoreHandlers, files: ['auth.js', 'bootstrap.js', 'jsonrpc.js'] },
        { dir: 'logic', prefix: expectedCoreHandlers, files: [] }  // 动态扫描
    ];
    
    // 动态获取 logic 目录下的文件
    const logicDir = path.join(servicePath, 'logic');
    if (fs.existsSync(logicDir)) {
        const logicFiles = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
        filesToCheck[2].files = logicFiles;
    }
    
    let errorCount = 0;
    
    for (const check of filesToCheck) {
        const dirPath = check.dir ? path.join(servicePath, check.dir) : servicePath;
        
        for (const file of check.files) {
            const filePath = path.join(dirPath, file);
            if (!fs.existsSync(filePath)) continue;
            
            const content = fs.readFileSync(filePath, 'utf-8');
            
            // 检查 library 引用
            const libraryPattern = /require\(['"]([^'"]*library\/[^'"]*)['"]\)/g;
            let match;
            
            while ((match = libraryPattern.exec(content)) !== null) {
                const importPath = match[1];
                
                // 计算实际的 ../ 数量
                const dotDotCount = (importPath.match(/\.\.\//g) || []).length;
                const expectedCount = check.dir ? depth + 1 : depth;
                
                if (dotDotCount !== expectedCount) {
                    results.errors.push(
                        `❌ [Path] ${check.dir ? check.dir + '/' : ''}${file}: 路径 '${importPath}' 深度错误 (期望 ${'../'.repeat(expectedCount)}library/...)`
                    );
                    errorCount++;
                }
            }
            
            // 检查 entity.js 的解构导入问题
            if (content.includes('{ createEntityFactory }')) {
                results.errors.push(
                    `❌ [Path] ${check.dir ? check.dir + '/' : ''}${file}: entity.js 使用了错误的解构导入 { createEntityFactory }，应使用 const createEntityFactory = require(...)`
                );
                errorCount++;
            }
        }
    }
    
    if (errorCount === 0) {
        results.passed.push(`✅ [Path] Library 路径检查通过 (深度 ${depth})`);
    }
}

module.exports = { check };
