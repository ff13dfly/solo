/**
 * 模块: Entity Factory 使用检查
 * 检测目标：鼓励使用共享的 api/library/entity.js 
 * 
 * 规则：
 * 1. 如果 logic 层文件包含 CRUD 样式的函数名 (create, update, deleteItem 等)
 * 2. 且未导入 library/entity
 * 3. 则发出建议警告
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicDir = path.join(servicePath, 'logic');

    if (!fs.existsSync(logicDir)) {
        return;
    }

    const files = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));
    let usesEntityFactory = false;

    for (const file of files) {
        const content = fs.readFileSync(path.join(logicDir, file), 'utf-8');

        // 检查是否导入了 entity 工厂
        const importsEntity = content.includes('/library/entity') ||
            content.includes('../lib/entity') ||
            content.includes('require(\'../../library/entity\')');

        if (importsEntity) {
            usesEntityFactory = true;
            results.passed.push(`✅ [架构] logic/${file} 使用了共享 Entity Factory`);

            // 新增：检查是否违规使用了 idPrefix
            if (content.includes('idPrefix')) {
                const prefixMatch = content.match(/idPrefix:\s*['"](.*?)['"]/);
                if (prefixMatch && prefixMatch[1] !== '') {
                    results.errors.push(`❌ [规则] logic/${file} 使用了 idPrefix: "${prefixMatch[1]}" (微服务 ID 不允许带前缀)`);
                } else {
                    results.passed.push(`✅ [规则] logic/${file} 未带 ID 前缀`);
                }
            } else {
                results.passed.push(`✅ [规则] logic/${file} 默认无 ID 前缀`);
            }
            continue;
        }

        // 如果没导入，检查是否像是 CRUD 模块
        // 简单的启发式检查：看是否有 CRUD 关键字函数定义
        const crudKeywords = ['async function create', 'async function update', 'async function delete',
            'exports.create', 'exports.update', 'exports.delete'];

        const hasCrud = crudKeywords.some(k => content.includes(k));

        if (hasCrud) {
            // 检查是否在 apps 目录下
            const isAppService = servicePath.includes(`${path.sep}apps${path.sep}`);

            if (isAppService) {
                results.errors.push(`❌ [架构] logic/${file} 实现了 CRUD 但未使用共享 Entity Factory (必须统一标准)`);
            } else {
                results.warnings.push(`⚠️ [架构] logic/${file} 似乎实现了 CRUD 但未使用共享 Entity Factory (建议重构)`);
            }
        }
    }

    // sensitiveFields 检查：entity 含密码/密钥类字段时必须声明 sensitiveFields
    // 触发词（字段名或赋值内容中含有这些词）
    const SENSITIVE_KEYWORDS = ['password', 'passwordHash', 'secret', 'privateKey', 'apiKey', 'token', 'credential'];
    for (const file of files) {
        const content = fs.readFileSync(path.join(logicDir, file), 'utf-8');
        if (!content.includes('/library/entity') && !content.includes('library/entity')) continue;

        const hasSensitiveField = SENSITIVE_KEYWORDS.some(kw => {
            // 匹配 entity field 定义（如 passwordHash: ... 或 'password': ...）
            return new RegExp(`['"]?${kw}['"]?\\s*:`).test(content);
        });

        if (hasSensitiveField) {
            if (!content.includes('sensitiveFields')) {
                results.errors.push(
                    `❌ [WAL] logic/${file}: entity 含敏感字段（password/secret/token 等）但未声明 sensitiveFields，` +
                    `WAL 日志将记录明文密码/密钥（参考 ADR-002）`
                );
            } else {
                results.passed.push(`✅ [WAL] logic/${file}: 含敏感字段且已声明 sensitiveFields`);
            }
        }
    }

    if (!usesEntityFactory && files.length > 0) {
        const isAppService = servicePath.includes(`${path.sep}apps${path.sep}`);
        if (isAppService) {
            // 如果整个 logic 目录都没有使用 EntityFactory，视情况而定，但如果有 CRUD 文件未用则是 Error
            // 这里主要针对 specifically flagged files based on heuristics above.
            // 但如果是一个全新的 Service，可能需要总体提示。
            // 暂时保持仅针对 detected files 报错，或者总体 Warning。
            // 用户指令是 "api/library/entity.js这个部分...必须是强制要求"，这通常指具体的 CRUD 实现。
            // 上面的 loop 已经处理了具体文件。这里是总体汇总。
            results.warnings.push(`⚠️ [架构] Logic 层未使用共享 Entity Factory`);
        } else {
            results.warnings.push(`⚠️ [架构] Logic 层未使用共享 Entity Factory (建议统一标准)`);
        }
    }
}

module.exports = { check };
