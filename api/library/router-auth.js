/**
 * Router Auth Parser
 *
 * @why 所有下游微服务的 auth.js middleware 都重复实现了同一套
 *      X-Router-Token 解码 + 验签逻辑，但只取了 payload.user，
 *      丢弃了 permit / constraints / meta。
 *      此 lib 统一解析逻辑，并完整暴露 payload 所有字段。
 *
 * @usage
 *   const { parseRouterToken } = require('../../../library/router-auth');
 *
 *   // 在 middleware 中替换原有内联解码：
 *   const payload = parseRouterToken(req.headers, config.routerPublicKey);
 *   req.user        = payload.user;
 *   req.permit      = payload.permit;       // 'admin' | 'user'
 *   req.constraints = payload.constraints;  // 数据权限约束对象
 *   req.meta        = payload.meta;         // 路由级元数据
 */

const bs58 = require('bs58').default || require('bs58');
const tweetnacl = require('tweetnacl');

// --- ERROR CODES ---

const ERR_MISSING  = { code: -32001, message: 'Level 3 Security: Missing Authorization Headers' };
const ERR_INVALID  = { code: -32001, message: 'Invalid Router Signature' };
const ERR_MALFORMED = { code: -32000, message: 'Malformed Auth Token' };
const ERR_STALE    = { code: -32001, message: 'Router token expired (replay protection)' };

// Replay protection: the Router signs a fresh token per request (iat = signing time),
// and downstream verification happens within milliseconds of receipt — so a captured
// (token, signature) pair must stop working quickly. 300s default leaves generous
// room for clock drift between co-located processes; FUTURE_SKEW tolerates a service
// clock slightly behind the Router's. Override: ROUTER_TOKEN_MAX_AGE_MS.
const TOKEN_MAX_AGE_MS = (() => {
    const n = parseInt(process.env.ROUTER_TOKEN_MAX_AGE_MS, 10);
    return Number.isFinite(n) && n > 0 ? n : 300_000;
})();
const TOKEN_FUTURE_SKEW_MS = 60_000;

function makeError(descriptor) {
    const err = new Error(descriptor.message);
    err.code = descriptor.code;
    err.rpcError = descriptor;
    return err;
}

// --- CORE PARSER ---

/**
 * Decode and verify an X-Router-Token / X-Router-Signature header pair.
 *
 * @param {object} headers         - Express req.headers (lowercase keys)
 * @param {string} routerPublicKey - Base58 Ed25519 public key from service config
 * @returns {{ iss, iat, user, permit, constraints, meta }} Decoded payload
 * @throws {Error} err.code = -32001 on missing/invalid, -32000 on malformed
 */
function parseRouterToken(headers, routerPublicKey) {
    const tokenB58 = headers['x-router-token'];
    const sigB58   = headers['x-router-signature'];

    if (!tokenB58 || !sigB58) {
        throw makeError(ERR_MISSING);
    }

    let payloadBytes, signatureBytes, publicKeyBytes;
    try {
        payloadBytes   = bs58.decode(tokenB58);
        signatureBytes = bs58.decode(sigB58);
        publicKeyBytes = bs58.decode(routerPublicKey);
        if (publicKeyBytes.length !== 32) throw new Error('bad Ed25519 public key length');
    } catch (e) {
        throw makeError(ERR_MALFORMED);
    }

    if (!tweetnacl.sign.detached.verify(payloadBytes, signatureBytes, publicKeyBytes)) {
        throw makeError(ERR_INVALID);
    }

    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch (e) {
        throw makeError(ERR_MALFORMED);
    }

    // Freshness gate (fail-closed): a token without iat, too old, or too far in the
    // future is rejected — a captured pair can no longer be replayed indefinitely.
    const age = Date.now() - (typeof payload.iat === 'number' ? payload.iat : 0);
    if (typeof payload.iat !== 'number' || age > TOKEN_MAX_AGE_MS || age < -TOKEN_FUTURE_SKEW_MS) {
        throw makeError(ERR_STALE);
    }

    return {
        iss:         payload.iss         || 'router',
        iat:         payload.iat         || 0,
        user:        payload.user        || 'anonymous',
        permit:      payload.permit      || 'user',
        constraints: payload.constraints || {},
        meta:        payload.meta        || {}
    };
}

module.exports = { parseRouterToken };
