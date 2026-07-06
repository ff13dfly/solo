/**
 * 模块: 实体定义 (Entities Definition) 检查
 * 检测目标：确保微服务导出了兼容 Portal 的实体定义
 * 
 * 规则：
 * 1. 检查 handlers/entities.js 是否存在且能被成功 require (无语法或路径错误)
 * 2. 检查每个实体是否包含 description 和 fields
 * 3. 检查每个字段是否包含 type 和 description
 * 4. 检查 introspection.js 中是否注册了 entities 或 [service].entities 方法
 */

const fs = require('fs');
const path = require('path');

function check(servicePath, results) {
    const entitiesPath = path.join(servicePath, 'handlers/entities.js');
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');

    // 1. 检查文件是否存在
    if (!fs.existsSync(entitiesPath)) {
        results.warnings.push(`⚠️ [实体] 未发现 handlers/entities.js，该服务可能不支持 Model-Driven UI`);
        return;
    }

    // 2. 检查可加载性 (捕获 MODULE_NOT_FOUND 或 SyntaxError)
    let entities;
    try {
        // 使用 require 会有缓存，但在 autocheck 环境下通常 OK
        // 或者使用 fs 读取并简单检查结构
        entities = require(entitiesPath);
        results.passed.push(`✅ [实体] handlers/entities.js 语法正确且依赖完整`);
    } catch (err) {
        results.errors.push(`❌ [实体] 无法加载 handlers/entities.js: ${err.message}`);
        return;
    }

    // 3. 检查结构完整性
    const entityNames = Object.keys(entities);
    if (entityNames.length === 0) {
        results.warnings.push(`⚠️ [实体] handlers/entities.js 导出为空对象`);
    }

    entityNames.forEach(name => {
        const entity = entities[name];

        // 检查实体基本信息
        if (!entity.description) {
            results.errors.push(`❌ [实体] 实体 "${name}" 缺少 description`);
        }
        if (!entity.fields || typeof entity.fields !== 'object') {
            results.errors.push(`❌ [实体] 实体 "${name}" 缺少 fields 定义`);
            return;
        }

        // 检查字段定义
        const fields = Object.keys(entity.fields);
        if (fields.length === 0) {
            results.warnings.push(`⚠️ [实体] 实体 "${name}" 没有定义任何字段`);
        }

        fields.forEach(fieldName => {
            const field = entity.fields[fieldName];
            if (!field.type) {
                results.errors.push(`❌ [实体] 实体 "${name}" 的字段 "${fieldName}" 缺少 type`);
            }
            if (!field.description) {
                results.warnings.push(`⚠️ [实体] 实体 "${name}" 的字段 "${fieldName}" 建议增加 description`);
            }
        });
    });

    // 4. 检查 entities key 命名规范：必须是合法的 RPC entity 段
    //    Portal 用 `${serviceId}.${key}.list` 拼出 RPC 方法名，因此 key 必须与实际方法名中的实体段一致
    //    正确: customer, order, instance, project（全小写，无服务前缀）
    //    错误: CustomerProfile（驼峰）, customer-profile（连字符）
    entityNames.forEach(key => {
        if (!/^[a-z][a-z0-9_]*$/.test(key)) {
            results.errors.push(
                `❌ [实体] entities.js key "${key}" 命名不合法，必须全小写且不含连字符` +
                `（Portal 用此 key 拼出 RPC 调用 \`${key}.list\`）`
            );
        }
    });

    // 6. 检查自省注册
    if (fs.existsSync(introspectionPath)) {
        const introspectionContent = fs.readFileSync(introspectionPath, 'utf-8');
        const hasEntitiesRpc = introspectionContent.includes('"entities"') || introspectionContent.includes("'entities'");

        // 禁止带前缀的 entities (如 sample.entities)
        const hasPrefixedEntities = introspectionContent.includes('.entities');

        if (!hasEntitiesRpc || hasPrefixedEntities) {
            results.errors.push(`❌ [实体] handlers/introspection.js 中未注册或错误注册了 entities (必须使用不带前缀的名称)`);
        } else {
            results.passed.push(`✅ [实体] 已在自省配置中注册实体查询方法`);
        }
    }
}

module.exports = { check };
