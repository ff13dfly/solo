/**
 * 模块: RediSearch 合规检查
 *
 * 规则：
 * 1. 如果 logic 层文件使用了 Entity Factory，
 *    检查是否指定了 storageType: 'json' (RediSearch ON JSON 的前提)
 * 2. 如果服务使用了 storageType: 'json'，
 *    检查 bootstrap.js 是否调用了 ensureIndex / ensureCrmIndexes / ensureOrderIndex 等
 * 3. 检查 handlers/bootstrap.js 是否 require 了 *_search.js 文件
 *
 * 背景：
 *   RediSearch ON JSON 要求实体以 RedisJSON 格式存储（storageType: 'json'）。
 *   现有 string 格式的 key 必须通过迁移脚本转换后才能被索引。
 *   启动时必须调用 ensureXxxIndex() 以重建或验证索引。
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const logicDir   = path.join(servicePath, 'logic');
    const handlersDir = path.join(servicePath, 'handlers');

    if (!fs.existsSync(logicDir)) return;

    const logicFiles = fs.readdirSync(logicDir).filter(f => f.endsWith('.js'));

    let hasJsonStorage = false;
    let hasSearchFile  = false;

    for (const file of logicFiles) {
        const filePath = path.join(logicDir, file);
        const content  = fs.readFileSync(filePath, 'utf-8');

        // Only check files that use Entity Factory
        const usesFactory = content.includes('/library/entity') ||
                            content.includes('../library/entity');
        if (!usesFactory) continue;

        // Check storageType: 'json'
        const hasJsonType = /storageType\s*:\s*['"]json['"]/.test(content);
        if (hasJsonType) {
            hasJsonStorage = true;
            results.passed.push(`✅ [RediSearch] logic/${file} 使用 storageType: 'json'`);
        } else {
            // Warn if the file has searchableFields (signals intent to use RediSearch)
            const hasSearchableFields = content.includes('searchableFields');
            if (hasSearchableFields) {
                results.warnings.push(
                    `⚠️ [RediSearch] logic/${file} 定义了 searchableFields 但缺少 storageType: 'json'` +
                    ` — RediSearch ON JSON 无法索引 string 类型的 key`
                );
            }
        }

        // Check if a corresponding *_search.js exists
        const baseName = path.basename(file, '.js');
        const searchFile = path.join(logicDir, `${baseName}_search.js`);
        const sharedSearch = logicFiles.some(f => f.endsWith('_search.js'));

        if (hasJsonType && !sharedSearch && !fs.existsSync(searchFile)) {
            results.warnings.push(
                `⚠️ [RediSearch] logic/${file} 有 storageType: 'json' 但找不到对应的 *_search.js` +
                ` — 实体数据将以 JSON 格式存储但不会被 RediSearch 索引`
            );
        }
    }

    // Check *_search.js files exist
    const searchFiles = logicFiles.filter(f => f.endsWith('_search.js'));
    for (const file of searchFiles) {
        hasSearchFile = true;
        results.passed.push(`✅ [RediSearch] logic/${file} 存在 (RediSearch 索引模块)`);
    }

    // Check bootstrap.js wires up ensureXxxIndex
    if (fs.existsSync(handlersDir)) {
        const bootstrapPath = path.join(handlersDir, 'bootstrap.js');
        if (fs.existsSync(bootstrapPath)) {
            const bootstrapContent = fs.readFileSync(bootstrapPath, 'utf-8');

            const requiresSearchModule = /_search['"]/.test(bootstrapContent);
            const callsEnsureIndex     = /ensureIndex|ensureCrmIndexes|ensureOrderIndex|ensureQrIndex/.test(bootstrapContent);

            if (hasJsonStorage || hasSearchFile) {
                if (requiresSearchModule && callsEnsureIndex) {
                    results.passed.push(`✅ [RediSearch] handlers/bootstrap.js 正确 require 并调用了 ensureIndex`);
                } else if (!requiresSearchModule) {
                    results.errors.push(
                        `❌ [RediSearch] handlers/bootstrap.js 未 require *_search.js` +
                        ` — 服务启动时不会建立 RediSearch 索引`
                    );
                } else if (!callsEnsureIndex) {
                    results.errors.push(
                        `❌ [RediSearch] handlers/bootstrap.js require 了 *_search.js` +
                        ` 但未调用 ensureXxxIndex() — 索引不会在启动时建立`
                    );
                }
            }
        }
    }

    // Check migration scripts exist when storageType: 'json' is in use
    if (hasJsonStorage) {
        const migrateDir = path.resolve(servicePath, '../../../deploy/migrate');
        if (fs.existsSync(migrateDir)) {
            const serviceName = path.basename(servicePath);
            const migrationFiles = fs.readdirSync(migrateDir).filter(f => f.endsWith('.js'));
            const hasMigration = migrationFiles.some(f =>
                f.includes(serviceName) || f.includes('_to_json')
            );

            if (!hasMigration) {
                results.warnings.push(
                    `⚠️ [RediSearch] 服务 ${serviceName} 使用 storageType: 'json'` +
                    ` 但 deploy/migrate/ 下缺少对应的迁移脚本` +
                    ` — 生产存量数据需要通过迁移脚本转换`
                );
            } else {
                results.passed.push(`✅ [RediSearch] deploy/migrate/ 下存在对应迁移脚本`);
            }
        }
    }
}

module.exports = { check };
