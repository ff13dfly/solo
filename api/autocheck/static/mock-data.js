/**
 * 模块 13: Mock 数据合规检查
 * 检测目标：验证测试/种子数据的 Redis Key、ID 格式、数据关联是否合规
 *
 * 检查范围：
 * - Redis Key / 数据关联：tests/ test/ fixtures/ seeds/ 下的所有 .js
 * - **Base58 ID**：只查「播种数据」文件（tests/utils/、fixtures/、seeds/，或文件名含
 *   mock/seed/fixture），且只对**自己生成 ID 的服务**（config.js 声明了 idLengths）。
 *
 * @why ID 那条为什么比别的窄两层（docs/feedback/mock-data-id-base58-vs-business-codes.md）：
 *   规则按字面形状抓 `id: '…'`，而 `tests/*.test.js` 里的 `id: '…'` 多半是**断言的期望值**，
 *   不是种子。下游服务的主键常常是别人发的（ERP 编码、条码、第三方 itemId、快递单号），
 *   必然含 0/O/I/l —— catalog 的主键就是聚水潭/吉客云发的 `C1108`/`C2804`，用假编码写断言
 *   等于不测真形状。老实现把这类断言判成 ERROR，precheck.sh 当场挡住部署，而唯一的自救是
 *   把 `toMatchObject({ id: 'C1108' })` 改写成 `expect(...id).toBe('C1108')` —— 断言的东西
 *   一模一样，只是不命中那个正则：**规则的红绿取决于断言的句式，而不是数据对不对**。
 *   收窄后规则本意（我们自己发的 ID 必须 Base58）一条不少。
 */

const fs = require('fs');
const path = require('path');

// Base58 字符集 (排除 0, O, I, l)
const BASE58_REGEX = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

// `id: 'xxx'` —— 前置断言让 `id` 必须是独立的词。
// @why 没有词边界时 `uid: 'uid0abc9'` / `order_id: 'AB0CD9'` 也会被当成 `id` 抓走（实测）。
const ID_LITERAL_REGEX = /(?<![A-Za-z0-9_$])['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/g;

/**
 * 去掉 `//` 行注释与块注释（字符串里的 `//` 不动，URL 不能被当注释）。
 *
 * @why 写「这里为什么不能那么写」的注释时，注释里必然要引用那个被禁的写法——于是**讲这件事的
 *   注释本身又把规则点着了**（实测）。同一个坑 catalog 的 check-jsx-markdown.cjs 踩过并修好：
 *   静态规则必须跳注释，否则每次都要人工分辨真假 = 把「仔细看」换了个地方做。
 */
function stripComments(src) {
    let out = '';
    for (let i = 0; i < src.length;) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && d === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') out += '\n';   // 保住行数，别把上下两行粘成一行
                i++;
            }
            i += 2;
            out += ' ';
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            out += c;
            for (i++; i < src.length;) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
                out += src[i];
                if (src[i] === c) { i++; break; }
                i++;
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

/**
 * 这个文件是不是「播种数据」——Base58 ID 规则只对播种数据成立，不对断言成立。
 */
function isSeedFile(filePath) {
    const name = path.basename(filePath).toLowerCase();
    if (/mock|seed|fixture/.test(name)) return true;
    const dir = path.dirname(filePath).replace(/\\/g, '/');
    return /\/(tests\/utils|fixtures|seeds)$/.test(dir);
}

/**
 * 本服务自己生成 ID 吗？判据 = config.js 声明了 idLengths（api/sample/config.js 的形状）。
 *
 * @why 镜像型服务的主键是外部系统发的，它们刻意不写 idLengths——那本身就是「本服务不生成 ID」
 *   的声明，比加注释豁免可靠（注释豁免的前车之鉴见 dead-config-key-reserved-marker-not-implemented.md：
 *   文案说能加注释，代码里根本不检查）。读不到 config.js 时按「不检查」处理：这条规则是帮我们
 *   自己的种子数据别写出非法 ID，误报的代价（挡住部署、逼人改断言句式）远大于漏报一个 0。
 */
function generatesOwnIds(servicePath) {
    const cfgPath = path.join(servicePath, 'config.js');
    if (!fs.existsSync(cfgPath)) return false;
    try {
        return /(^|[^A-Za-z0-9_$])idLengths\s*:/.test(stripComments(fs.readFileSync(cfgPath, 'utf-8')));
    } catch { return false; }
}

function check(servicePath, results) {
    // 查找测试/种子文件
    const testDirs = [
        path.join(servicePath, 'tests'),
        path.join(servicePath, 'tests/utils'),
        path.join(servicePath, 'test'),
        path.join(servicePath, 'fixtures'),
        path.join(servicePath, 'seeds')
    ];
    
    const mockFiles = [];
    for (const dir of testDirs) {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
            files.forEach(f => mockFiles.push(path.join(dir, f)));
        }
    }
    
    if (mockFiles.length === 0) {
        results.warnings.push(`⚠️ [Mock] 未找到测试/种子文件`);
        return;
    }
    
    results.passed.push(`✅ [Mock] 找到 ${mockFiles.length} 个测试文件`);

    const ownIds = generatesOwnIds(servicePath);

    for (const filePath of mockFiles) {
        const fileName = path.basename(filePath);
        // 注释一律不参与任何一条规则：讲"别这么写"的注释不该把规则自己点着。
        const content = stripComments(fs.readFileSync(filePath, 'utf-8'));

        // 1. 检查 Redis Key 格式
        checkRedisKeys(content, fileName, results);

        // 2. 检查 ID 格式 (Base58) —— 只查播种数据，且只查自己生成 ID 的服务（见文件头 @why）
        if (ownIds && isSeedFile(filePath)) {
            checkIdFormat(content, fileName, results);
        }

        // 3. 检查数据关联一致性
        checkDataRelations(content, fileName, results);
    }
}

/**
 * 检查 Redis Key 是否符合 SERVICE:ENTITY:ID 格式
 */
function checkRedisKeys(content, fileName, results) {
    // 匹配 redis.set/get/json.set 中的 key
    const keyPatterns = [
        /redis\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /redis\.get\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /redis\.json\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /client\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g,
        /client\.json\.set\s*\(\s*['"`]([^'"`$]+)['"`]/g
    ];
    
    const foundKeys = new Set();
    for (const pattern of keyPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
            foundKeys.add(match[1]);
        }
    }
    
    for (const key of foundKeys) {
        const parts = key.split(':');
        if (parts.length < 2) {
            results.errors.push(`❌ [Mock] ${fileName}: 非法 Key 格式 "${key}" (应为 SERVICE:ENTITY:ID)`);
        } else if (parts.length >= 2) {
            // 检查是否全大写 (规范)
            const prefix = parts.slice(0, -1).join(':');
            if (prefix !== prefix.toUpperCase()) {
                results.warnings.push(`⚠️ [Mock] ${fileName}: Key 前缀建议大写 "${key}"`);
            } else {
                results.passed.push(`✅ [Mock] ${fileName}: Key 格式正确 "${key}"`);
            }
        }
    }
}

/**
 * 检查 ID 是否符合 Base58 格式
 */
function checkIdFormat(content, fileName, results) {
    // 匹配 id: "xxx" 或 id: 'xxx' 模式（`id` 须是独立的词，见 ID_LITERAL_REGEX）
    const idMatches = content.matchAll(ID_LITERAL_REGEX);
    
    for (const match of idMatches) {
        const id = match[1];
        
        // 跳过明显的占位符、动态引用和业务单号（含连字符的 display ID）
        if (id.includes('$') || id.includes('{') || id.length < 4 || id.includes('-')) continue;
        
        // 检查 Base58 合规性
        if (!BASE58_REGEX.test(id)) {
            // 检查是否包含非法字符
            const illegalChars = id.match(/[0OIl]/g);
            if (illegalChars) {
                results.errors.push(
                    `❌ [Mock] ${fileName}: 种子 ID "${id}" 包含 Base58 非法字符: ${illegalChars.join(', ')}` +
                    `（本规则只管**本服务自己生成的** ID；若这是外部系统发的业务编码，` +
                    `说明本服务不该声明 config.js 的 idLengths）`
                );
            }
        }
    }
}

/**
 * 检查数据关联一致性
 */
function checkDataRelations(content, fileName, results) {
    // 提取所有定义的 ID
    const definedIds = new Set();
    const idDefMatches = content.matchAll(/['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/g);
    for (const match of idDefMatches) {
        definedIds.add(match[1]);
    }
    
    // 提取所有引用的外键
    const referencedIds = new Map(); // { refId: fieldName }
    const refPatterns = [
        /['"]?(\w+Id)['"]?\s*:\s*['"]([^'"]+)['"]/g,  // xxxId: "value"
        /['"]?(uid)['"]?\s*:\s*['"]([^'"]+)['"]/g     // uid: "value"
    ];
    
    for (const pattern of refPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
            const fieldName = match[1];
            const refId = match[2];
            if (!refId.includes('$') && !refId.includes('{')) {
                referencedIds.set(refId, fieldName);
            }
        }
    }
    
    // 检查引用的 ID 是否在同文件中定义
    // 注意：跨文件引用无法检测，这里只做同文件内的一致性检查
    let orphanCount = 0;
    for (const [refId, fieldName] of referencedIds) {
        if (!definedIds.has(refId)) {
            orphanCount++;
            // 只在数量较少时报告，避免过多噪音
            if (orphanCount <= 3) {
                results.warnings.push(`⚠️ [Mock] ${fileName}: ${fieldName}="${refId}" 引用了未在同文件定义的 ID`);
            }
        }
    }
    
    if (orphanCount > 3) {
        results.warnings.push(`⚠️ [Mock] ${fileName}: 还有 ${orphanCount - 3} 个外键引用了外部 ID (可能是正常的跨实体关联)`);
    }
    
    if (orphanCount === 0 && referencedIds.size > 0) {
        results.passed.push(`✅ [Mock] ${fileName}: ${referencedIds.size} 个外键关联检查通过`);
    }
}

module.exports = { check };
