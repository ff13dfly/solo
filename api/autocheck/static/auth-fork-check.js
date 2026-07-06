/**
 * 模块: auth 分叉禁令 (toFix §6.x — user/gateway/administrator 三连漏的教训)
 *
 * 检测目标：
 *   服务的 Router-token 鉴权必须经 library/auth(createAuthHandlers),不允许
 *   手搓分叉。教训:三个早于 library/auth 的服务各自手搓中间件,events.js 全队
 *   铺开时 3/3 全部漏掉 public 白名单同步(e2e 93 三连红)——分叉不跟着公共库
 *   进化,漏改率是结构性的,不是偶然。
 *
 *   判据(启发式,二选一即过):
 *     A. handlers/auth.js 引用 library/auth 的 createAuthHandlers → ✅
 *     B. 服务内任何地方出现手搓验签特征(x-router-token + tweetnacl/sign.detached)
 *        且不经 createAuthHandlers → ❌
 *   router 自身是验签的另一端(签发方),不适用本规则(checker 不跑 router 目录)。
 */
const fs = require('fs');
const path = require('path');

const HAND_ROLLED_MARKERS = ['x-router-token', 'sign.detached.verify'];

function readIfExists(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function check(servicePath, results) {
    // router 是信任根的签发端,不适用(防有人把 checker 指到 router 目录)
    if (path.basename(servicePath) === 'router') return;

    const candidates = [
        path.join(servicePath, 'handlers/auth.js'),
        path.join(servicePath, 'index.js'),
    ];

    let usesLibrary = false;
    let handRolledAt = null;

    for (const f of candidates) {
        const src = readIfExists(f);
        if (!src) continue;
        if (src.includes('createAuthHandlers')) usesLibrary = true;
        const lower = src.toLowerCase();
        if (HAND_ROLLED_MARKERS.every(m => lower.includes(m))) handRolledAt = f;
    }

    if (handRolledAt && !usesLibrary) {
        results.errors.push(
            `❌ [auth-fork] ${path.relative(servicePath, handRolledAt) || path.basename(handRolledAt)} ` +
            `手搓 Router-token 验签(x-router-token + sign.detached)且未经 library/auth — ` +
            `分叉不会跟随公共库进化(events 白名单三连漏的教训),改用 createAuthHandlers(config, { publicMethods })`
        );
        return;
    }

    if (usesLibrary) {
        results.passed.push(`✅ [auth-fork] 鉴权经 library/auth(createAuthHandlers),无分叉`);
    }
    // 既无 library 也无手搓特征:可能是无鉴权面的纯 worker——不报,由 ed25519Handshake 检查兜
}

module.exports = { check };
