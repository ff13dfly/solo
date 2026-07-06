/**
 * 模块: 软删除一致性检查 (Soft-Delete Consistency Check)
 * 检测目标：确保 logic 层中的 softDelete 配置与 handlers/entities.js 中的声明一致
 * 
 * 规则：
 * 1. 扫描 logic/*.js，提取 Entity Factory 的 softDelete 配置。
 * 2. 检查 handlers/entities.js 中对应实体是否显式声明了 softDelete: true/false。
 * 3. 如果 logic 开启了软删除但 entities 未声明 -> ERROR (Missing Metadata)
 * 4. 如果 entities 声明了软删除但 logic 未开启 -> CRITICAL ERROR (False Promise)
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicDir = path.join(servicePath, 'logic');
    const entitiesPath = path.join(servicePath, 'handlers/entities.js');

    if (!fs.existsSync(logicDir) || !fs.existsSync(entitiesPath)) {
        return;
    }

    // 1. 加载实体定义
    let entities;
    try {
        delete require.cache[require.resolve(entitiesPath)];
        entities = require(entitiesPath);
    } catch (err) {
        // entities-definition.js 会处理语法错误，这里跳过
        return;
    }

    // 2. 扫描 logic 文件
    const files = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
    const logicConfig = {}; // { entityName: { softDelete: boolean, file: string } }

    files.forEach(file => {
        const content = fs.readFileSync(path.join(logicDir, file), 'utf-8');

        // 匹配 createEntityFactor(redis, { ... })
        // 这是一个简易的启发式匹配
        if (content.includes('createEntityFactor') || content.includes('createEntity')) {
            const entityMatch = content.match(/entityName:\s*['"](.*?)['"]/);
            const softDeleteMatch = content.match(/softDelete:\s*(true|false)/);

            if (entityMatch) {
                const name = entityMatch[1];
                const isSoftDelete = softDeleteMatch ? softDeleteMatch[1] === 'true' : false;
                logicConfig[name] = { softDelete: isSoftDelete, file };
            }
        }
    });

    // 3. 执行交叉比对
    Object.keys(logicConfig).forEach(name => {
        const logic = logicConfig[name];
        const entityDef = entities[name];

        if (!entityDef) return; // 实体未在定义中（可能是内部实体）

        const metaSoftDelete = entityDef.softDelete === true;

        if (logic.softDelete && !metaSoftDelete) {
            results.errors.push(`❌ [一致性] 实体 "${name}" (logic/${logic.file}) 开启了软删除，但 handlers/entities.js 中未声明 "softDelete: true" (将导致 Portal 隐藏回收站)`);
        } else if (!logic.softDelete && metaSoftDelete) {
            results.errors.push(`❌ [一致性] 实体 "${name}" 在 handlers/entities.js 中声明了软删除，但 logic/${logic.file} 实际为物理删除 (严重：会导致 UI 误导并丢数据)`);
        } else if (logic.softDelete && metaSoftDelete) {
            results.passed.push(`✅ [一致性] 实体 "${name}" 的软删除配置在 Logic 与 Metadata 间同步`);
        }
    });
}

module.exports = { check };
