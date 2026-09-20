/**
 * 模块: 软删除一致性检查 (Soft-Delete Consistency Check)
 * 检测目标：确保 logic 层中的 softDelete 配置与 handlers/entities.js 中的声明一致
 * 
 * 规则：
 * 1. 扫描 logic/*.js，提取 Entity Factory 的 softDelete 配置。
 * 2. 检查 handlers/entities.js 中对应实体是否显式声明了 softDelete: true/false。
 * 3. 如果 logic 开启了软删除但 entities 未声明 -> ERROR (Missing Metadata)
 * 4. 如果 entities 声明了软删除但 logic 未开启 -> CRITICAL ERROR (False Promise)
 * 5. 软删实体 + 大载荷字段（introspection 参数 maxLength >= 100KB）-> WARNING (载荷泄漏)
 *
 * 规则 5 的来历：docs/feedback/done/soft-delete-keeps-large-payloads.md（steward，2026-09-20）。
 * softDelete 只改 status，载荷一字不动——实测：85 条已软删记录占 10.39MB（81%），
 * 硬删后整库 44.64MB → 24.03MB。框架/文档/autocheck 三处原本只盯索引一致性，
 * 载荷这一维一个字都没有。这条规则不改行为，只把它变成写代码时就要
 * 显式回答的一个问题（而不是删了一个月后盘点才发现）。
 */

// 大载荷阈值：100KB。来源同上篇反馈的建议 ⑤。定在这个量级而不更低，
// 是为保住【零误报成本】——真需要软删大字段的，注释一句即可；
// 调到几十 KB 会把正常的文本字段扫进来，规则一旦吵就会被忽略。
const LARGE_PAYLOAD_BYTES = 100000;

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

    // 4. 规则 5：软删实体带大载荷字段 -> WARNING
    //    判据落在 introspection 的参数 maxLength 上，不是 entities.js：
    //    entities.js 的字段 schema 只有 type/description/required/format，没有长度维；
    //    实际的上限声明在方法参数里（steward 那个 400000 就是）。
    //    方法名按 {service}.{entity}.{action} 拆出实体段（CLAUDE.md §5 命名约定）。
    const softDeleted = new Set();
    Object.keys(logicConfig).forEach((n) => { if (logicConfig[n].softDelete) softDeleted.add(n); });
    Object.keys(entities).forEach((n) => { if (entities[n] && entities[n].softDelete === true) softDeleted.add(n); });

    if (softDeleted.size > 0) {
        const introPath = path.join(servicePath, 'handlers/introspection.js');
        if (fs.existsSync(introPath)) {
            let methods = null;
            try {
                delete require.cache[require.resolve(introPath)];
                methods = require(introPath);
            } catch (err) {
                methods = null;   // 语法错由 introspection.js 规则报，这里跳过
            }

            if (Array.isArray(methods)) {
                const hits = [];   // 按 实体+字段 去重：同一字段常在 create/update 重复出现
                const seen = new Set();
                methods.forEach((m) => {
                    if (!m || !m.name || !Array.isArray(m.params)) return;
                    const seg = m.name.split('.');
                    if (seg.length < 3) return;                 // ping/methods/entities 等系统方法
                    const entity = seg[1];
                    if (!softDeleted.has(entity)) return;
                    m.params.forEach((p) => {
                        if (!p || typeof p.maxLength !== 'number') return;
                        if (p.maxLength < LARGE_PAYLOAD_BYTES) return;
                        const k = entity + '.' + p.name;
                        if (seen.has(k)) return;
                        seen.add(k);
                        hits.push({ entity, field: p.name, max: p.maxLength });
                    });
                });

                hits.forEach((h) => {
                    results.warnings.push(
                        `⚠️ [载荷] 实体 "${h.entity}" 开了软删，但字段 "${h.field}" 上限 ${h.max} 字节` +
                        `（≥${LARGE_PAYLOAD_BYTES}）——softDelete 只改 status，这份载荷删后照样占内存、照样进备份包。` +
                        `请确认清理路径：真要可恢复就保持现状并注明，否则该走 entity.destroy() 硬删` +
                        `（见 docs/authoring/service.md 软删一节第 (c) 条）`
                    );
                });

                if (hits.length === 0) {
                    results.passed.push(`✅ [载荷] 软删实体未发现 ≥${LARGE_PAYLOAD_BYTES} 字节的载荷字段`);
                }
            }
        }
    }
}

module.exports = { check };
