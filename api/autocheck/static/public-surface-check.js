/**
 * 模块: public 面白名单守门 (toFix.md 二.router — "checkAccess public 面无 Router 侧白名单
 * ceiling" 的服务侧缓解)
 *
 * 背景:
 *   Router `access.js` Phase 3 信任每个服务 introspection 自报的 `public: true`
 *   ——单个方法误标即对未鉴权流量开洞,Router 侧没有上限校验(该改动需改
 *   access.js,属红线,未授权不动)。
 *   本检查在服务侧补一道等效防线:把当前**已核实、必要**的 public 方法钉成显式
 *   白名单,任何服务出现白名单之外的新 public:true 方法 → CI 直接拦(不必等
 *   Router 侧改动,也不因为白名单本身没改就失去意义——目标是"沉默开洞"变成
 *   "显式当场发现")。
 *
 *   白名单收紧方向随意(删除/收窄不受限);新增 public 方法必须同步改这份白名单
 *   ——这本身就是一次显式代码评审动作。
 */
const fs = require('fs');
const path = require('path');

// service 目录 basename → 允许 public:true 的完整方法名集合。
// 未出现在这里的服务 = 不允许任何 public 方法(默认空集)。
const ALLOWED_PUBLIC_METHODS = {
    user: new Set([
        'user.register',
        'user.login.request',
        'user.login.verify',
        'user.passport.verify',
        'user.passport.otp.request',
        'user.passport.otp.verify',
        'user.passport.device.issue',
        'user.passport.upgrade',
    ]),
    administrator: new Set([
        'admin.login.request',
        'admin.login.verify',
    ]),
    ingress: new Set([
        'ingress.ingest', // 另有 API key 鉴权(Authorization header),非真裸露
    ]),
    fulfillment: new Set([
        'ping',
        'methods',
        'entities',
    ]),
};

// 顶层方法名的形状:带点的 service.entity.action,或保留的裸自省名。
// 用于把 returns_schema 里嵌套的 { name: 'token' } 这类字段名过滤掉,避免
// public:true 被错误归因到最近的嵌套字段而不是真正的方法名。
const RESERVED_BARE_NAMES = new Set(['ping', 'methods', 'entities']);
function isMethodNameCandidate(name) {
    return name.includes('.') || RESERVED_BARE_NAMES.has(name);
}

function check(servicePath, results) {
    const introspectionPath = path.join(servicePath, 'handlers/introspection.js');
    if (!fs.existsSync(introspectionPath)) return;

    const serviceName = path.basename(servicePath);
    const allowed = ALLOWED_PUBLIC_METHODS[serviceName] || new Set();

    const src = fs.readFileSync(introspectionPath, 'utf-8');
    const positions = [...src.matchAll(/name:\s*['"]([a-zA-Z0-9_.]+)['"]/g)]
        .map(m => ({ index: m.index, name: m[1] }))
        .filter(p => isMethodNameCandidate(p.name));

    const foundPublic = [];
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = i + 1 < positions.length ? positions[i + 1].index : src.length;
        const chunk = src.slice(start, end);
        if (/public:\s*true/.test(chunk)) foundPublic.push(positions[i].name);
    }

    const unexpected = foundPublic.filter(name => !allowed.has(name));

    if (unexpected.length > 0) {
        results.errors.push(
            `❌ [public-surface] ${unexpected.length} 个未登记的 public:true 方法:\n` +
            unexpected.map(m => `       - ${m}`).join('\n') +
            `\n       若确需公开,先评审必要性,再把方法名加进 autocheck/static/public-surface-check.js 的 ALLOWED_PUBLIC_METHODS['${serviceName}']`
        );
        return;
    }

    if (foundPublic.length > 0) {
        results.passed.push(`✅ [public-surface] ${foundPublic.length} 个 public 方法均在白名单内`);
    } else {
        results.passed.push(`✅ [public-surface] 无 public 方法`);
    }
}

module.exports = { check };
