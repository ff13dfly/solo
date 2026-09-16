/**
 * 模块: Entity Factory 使用检查
 * 检测目标：鼓励使用共享的 api/library/entity.js 
 * 
 * 规则：
 * 1. 如果 logic 层文件包含 CRUD 样式的函数名 (create, update, deleteItem 等)
 * 2. 且未导入 library/entity
 * 3. 则发出建议警告
 *
 * 两个正规豁免标记（都在文件任意位置写一整行注释即可）：
 *   // SAFE: singleton        单例配置类文件——没有 id、没有软删除、永远只有一份
 *   // SAFE: external-store   业务行存在 Redis 之外（PostgreSQL 等）
 * 两者语义不同、不可互相代用，详见各自定义处的注释。
 */

const fs = require('fs');
const path = require('path');

const SINGLETON_MARKER = '// SAFE: singleton';

// 这条规则想管的是「别绕过 Entity Factory 在 Redis 里各写各的 key」，但它的判据是
// 「有没有 import entity.js」——于是把「行根本不在 Redis 里」的实现也一并拦下了，
// 而那是个合理选择：查询形态是多维筛选 / JOIN / 聚合报表 / 全文检索时，Redis 不匹配
// （entity.list 的 filter 一律在取回之后跑，一次品类查询等于翻完整个集合）。
//
// 拿 singleton 去豁免它是把那个标记的语义用坏（商品表既有 id 也会软删，不是单例配置），
// 所以这里给一个语义对得上的标记，而不是逼人改函数名规避检查。
// 代价写在 service.md「什么时候不该用 Entity Factory」一节：行隔离 $owner、
// sensitiveFields 掩码、WAL 审计三样都得自己接回来——那才是这条路真正的成本。
const EXTERNAL_STORE_MARKER = '// SAFE: external-store';

// 剥掉整行注释与块注释再匹配 CRUD 关键字——否则一句解释这条规则本身的注释
// （字面包含 'async function update' 之类）会把自己触发一遍。只剥"整行都是注释"
// 的行（同 pagination-safety.js 的 `// SAFE:` 约定），不动行尾内联注释，够用且不会
// 误伤字符串/URL 里的 `//`。
function stripComments(content) {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(line => (line.trimStart().startsWith('//') ? '' : line))
        .join('\n');
}

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

        // 单例配置类文件（没有 id/没有软删除/永远只有一份）用不上 Entity Factory的
        // ID 生成/索引/游标分页——正规豁免，别逼人靠改函数名绕过检查。
        if (content.includes(SINGLETON_MARKER)) {
            results.passed.push(`✅ [架构] logic/${file} 声明为单例配置（${SINGLETON_MARKER}），豁免 Entity Factory 检查`);
            continue;
        }

        // 业务行存在 Redis 之外（见标记定义处的注释）——同样是正规豁免。
        if (content.includes(EXTERNAL_STORE_MARKER)) {
            results.passed.push(`✅ [架构] logic/${file} 声明为外部存储（${EXTERNAL_STORE_MARKER}），豁免 Entity Factory 检查`);
            continue;
        }

        // 如果没导入，检查是否像是 CRUD 模块
        // 简单的启发式检查：看是否有 CRUD 关键字函数定义（先剥注释，避免误伤，见上）
        const crudKeywords = ['async function create', 'async function update', 'async function delete',
            'exports.create', 'exports.update', 'exports.delete'];

        const strippedContent = stripComments(content);
        const hasCrud = crudKeywords.some(k => strippedContent.includes(k));

        if (hasCrud) {
            // 检查是否在 apps 目录下
            const isAppService = servicePath.includes(`${path.sep}apps${path.sep}`);
            const hint = `若确为单例配置（无 id，永远只有一份）加 \`${SINGLETON_MARKER}\`；`
                + `若业务行存在 Redis 之外（PostgreSQL 等，查询形态为 JOIN/聚合/全文检索）`
                + `加 \`${EXTERNAL_STORE_MARKER}\`，并自行接回 $owner 行隔离、sensitiveFields 掩码与 WAL 审计`;

            if (isAppService) {
                results.errors.push(`❌ [架构] logic/${file} 实现了 CRUD 但未使用共享 Entity Factory (必须统一标准；${hint})`);
            } else {
                results.warnings.push(`⚠️ [架构] logic/${file} 似乎实现了 CRUD 但未使用共享 Entity Factory (建议重构；${hint})`);
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
