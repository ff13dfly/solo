/**
 * 模块: Dead Config Key 检测
 *
 * 检测目标：config.js 中定义的属性键在服务源码（logic/ handlers/ oss/ 等子目录）与 index.js 里从未被引用。
 * 背景：issue_20260425 根因之一 —— sha256Prefix 在 config.redis 里定义了 14 天，
 *       logic/asset.js 从未读取，后续实装时才意识到还没接上，同步引入了 race。
 *
 * 规则：
 *   - 扫描 config.js 导出对象的所有顶层 key 和二级 key（含 redis.*, thumbnails.* 等）
 *   - 在所有服务源码子目录与 index.js 里 grep 字面量引用（排除 config.js 自身与 tests/）
 *   - 未被引用 → warning（不报 error，config 里存在"仅供文档/未来使用"的 key 是合理的）
 *
 * 豁免：
 *   - 系统级通用 key（port, serviceName, redisUrl, debug, version 等）
 *   - 以 _ 开头的 key（约定为私有/临时占位）
 */

const fs = require('fs');
const path = require('path');

// 通用 key 或框架级 key，不检查（auth/bootstrap/index.js 消费，不在 logic/ 里）
const EXEMPT_KEYS = new Set([
    'port', 'serviceName', 'redisUrl', 'debug', 'version',
    'description', 'routerUrl', 'indexes', 'bodyLimit',
    'uploadDir', 'assetsPublicPath', 'forms', 'baseUrl',
    'host', 'url', 'timeout', 'retries', 'secret',
    'jwtSecret', 'appKey', 'appSecret',
    'routerPublicKey',  // 用于 handlers/auth.js
    'pageSize',         // 框架级分页默认值，logic 层通过 params 传入
    'seeds',            // library/bootstrap.ensureDefaultCategories 消费（index.js 启动调用），不在本服务源码里
]);

// 顶层父 key：只要父 key 被引用，子 key 不单独检查
const PARENT_KEYS = new Set([
    'description', 'redis', 'thumbnails', 'thumbnails.sizes',
    'indexes', 'forms', 'limits', 'ai', 'erp', 'sms',
]);

function extractKeys(obj, prefix = '') {
    const keys = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return keys;
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue;
        const full = prefix ? `${prefix}.${k}` : k;
        keys.push({ key: k, full });
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            keys.push(...extractKeys(v, full));
        }
    }
    return keys;
}

function check(servicePath, results) {
    const configPath = path.join(servicePath, 'config.js');
    const logicPath = path.join(servicePath, 'logic');
    const indexPath = path.join(servicePath, 'index.js');

    if (!fs.existsSync(configPath)) return;

    let config;
    try {
        delete require.cache[require.resolve(configPath)];
        config = require(configPath);
    } catch (e) {
        return; // config-check 模块已报错，这里不重复
    }

    // 收集服务全部源码子目录（logic/ handlers/ 以及 oss/ 等辅助子目录，递归）+ index.js。
    // 排除 tests/ 等非源码目录，且不扫描 config.js 本身——config.js 是 key 的定义处，
    // 把它算作"引用"会让本检查永远通过。某些 key 仅被 logic/ 之外的子模块消费（如
    // storage 的 oss/ provider 读取 config.storage.oss.*），只扫 logic/ 会误报为死键。
    const sources = [];
    const SKIP_SUBDIRS = new Set(['tests', 'test', 'node_modules', '.git', 'dist', 'build', 'coverage']);
    function collectJs(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIP_SUBDIRS.has(entry.name)) collectJs(path.join(dir, entry.name));
            } else if (entry.name.endsWith('.js')) {
                sources.push(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
            }
        }
    }
    for (const entry of fs.readdirSync(servicePath, { withFileTypes: true })) {
        if (entry.isDirectory() && !SKIP_SUBDIRS.has(entry.name)) {
            collectJs(path.join(servicePath, entry.name));
        }
    }
    if (fs.existsSync(indexPath)) {
        sources.push(fs.readFileSync(indexPath, 'utf-8'));
    }
    const combined = sources.join('\n');

    const keys = extractKeys(config);
    let deadCount = 0;

    for (const { key, full } of keys) {
        if (EXEMPT_KEYS.has(key)) continue;
        // 豁免（框架消费）key 的后代也豁免 —— 如 seeds.categories 在 bootstrap 消费的 seeds 之下。
        if ([...EXEMPT_KEYS].some(ek => full.startsWith(ek + '.'))) continue;
        // 跳过父 key 的子属性（只要父 key 被引用，子 key 视为已覆盖）
        const parentReferenced = [...PARENT_KEYS].some(pk =>
            full.startsWith(pk + '.') && new RegExp(`\\.${pk.split('.').pop()}\\b`).test(combined)
        );
        if (parentReferenced) continue;
        // 检查 key 字面量是否出现在源码中（属性访问或字符串形式）
        const patterns = [
            new RegExp(`\\.${key}\\b`),          // config.key
            new RegExp(`\\['${key}'\\]`),         // config['key']
            new RegExp(`["']${key}["']`),         // 字符串 key（redis key 拼接等）
        ];
        const referenced = patterns.some(p => p.test(combined));
        if (!referenced) {
            results.warnings.push(
                `⚠️ [DeadConfig] config.js 定义了 \`${full}\` 但在 logic/ 和 index.js 中未找到引用。` +
                `如为预留配置请加 \`// RESERVED:\` 注释，否则可能是"飞单"遗留。`
            );
            deadCount++;
        }
    }

    if (deadCount === 0) {
        results.passed.push(`✅ [DeadConfig] config.js 所有键均有引用`);
    }
}

module.exports = { check };
