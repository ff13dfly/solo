/**
 * library/auth.js — 微服务通用 Z-Handshake + Level 3 Auth 中间件工厂
 *
 * 用法（在 handlers/auth.js 里）：
 *
 *   const config = require('../config');
 *   const { createAuthHandlers } = require('../../../library/auth');
 *
 *   module.exports = createAuthHandlers(config);
 *
 *   // 需要额外公开方法时：
 *   module.exports = createAuthHandlers(config, {
 *       publicMethods: ['storage.asset.resolve']
 *   });
 *
 * 注入到 req：
 *   req.user        — uid 字符串（payload.user）
 *   req.permit      — 'admin' | 'user'
 *   req.constraints — 数据权限约束对象（Router 透传）
 *   req.meta        — 路由级元数据
 */

const crypto = require('crypto');
const bs58 = require('bs58').default || require('bs58');
const tweetnacl = require('tweetnacl');
const { parseRouterToken } = require('./router-auth');
const { createLogger } = require('./logger');

const BASE_PUBLIC_METHODS = ['ping', 'methods', 'entities', 'events', 'guide'];

function createAuthHandlers(config, options = {}) {
    const logger = createLogger(config.serviceName || 'service');
    const publicMethods = [...BASE_PUBLIC_METHODS, ...(options.publicMethods || [])];

    // ── Z-Handshake state（per service instance）─────────────────────────────
    // PENDING_SEEDS：已发出、待验证的挑战种子（60s 过期）。/auth/verify 不回传 seed
    // （Router 只发 {signature, publicKey}，见 router/handlers/service.js），所以验证时
    // 只能遍历本表用签名反查命中的 seed。
    // ⚠️ 这是 per-process 状态：单机单进程（v1.1 部署假设，VERSION.md §2）无影响；
    //    多进程（pm2 cluster / k8s replicas）下 A 进程发的 seed 到 B 进程验不到 → 握手随机失败。
    //    干净的跨进程修复需要 Router 在 /auth/verify 回传 seed（让服务能对 Redis 做 O(1) 查
    //    而非内存遍历）——属协议改动 + 仅多机才触发，记 AUDIT M2 / v2 多机硬化。
    // （原 ACTIVE_SESSIONS 已删：握手 session 从不被 middleware 读取——鉴权每请求验 Router
    //   token，session 是 write-only 死状态。AUDIT M3。）
    const PENDING_SEEDS = new Map();

    const _seedSweeper = setInterval(() => {
        const now = Date.now();
        for (const [seed, ts] of PENDING_SEEDS)
            if (now - ts > 60000) PENDING_SEEDS.delete(seed);
    }, 60000);
    // 维护型定时器不应阻止进程退出(HTTP server 才负责保活;也让单测可干净退出).
    if (_seedSweeper.unref) _seedSweeper.unref();

    // ── Step 1: Issue challenge seed ──────────────────────────────────────────
    function handleSeed(req, res) {
        const seed = crypto.randomBytes(32).toString('hex');
        PENDING_SEEDS.set(seed, Date.now());
        res.json({ seed });
    }

    // ── Step 2: Verify Router's Ed25519 signature ─────────────────────────────
    function handleVerify(req, res, SERVICE_NAME, SERVICE_VERSION, STARTUP_TIME) {
        const { signature, publicKey } = req.body;
        if (!signature || !publicKey) {
            return res.status(400).json({ success: false, error: 'Missing params' });
        }

        let validSeed = null;
        try {
            const signatureBytes = bs58.decode(signature);
            const publicKeyBytes = bs58.decode(publicKey);
            if (publicKeyBytes.length !== 32) throw new Error('bad Ed25519 public key length');

            for (const [seed] of PENDING_SEEDS) {
                const message = new TextEncoder().encode(seed);
                if (tweetnacl.sign.detached.verify(message, signatureBytes, publicKeyBytes)) {
                    validSeed = seed;
                    break;
                }
            }
        } catch (e) {
            logger.error('Verification Error:', e.message);
            return res.status(400).json({ success: false, error: 'Invalid Format' });
        }

        if (validSeed) {
            PENDING_SEEDS.delete(validSeed);
            logger.info(`Link established with: ${publicKey}`);
            return res.json({
                success: true,
                serviceName: SERVICE_NAME,
                version: SERVICE_VERSION,
                startupTime: STARTUP_TIME,
            });
        } else {
            return res.status(401).json({ success: false, error: 'Invalid Signature or Expired Seed' });
        }
    }

    // ── Level 3 Auth Middleware ───────────────────────────────────────────────
    function middleware(req, res, next) {
        // Bypass: handshake endpoints
        if (req.path.startsWith('/auth/')) return next();

        // Bypass: public JSON-RPC methods (Router discovery). Public = auth not
        // REQUIRED — not identity-blind: when the Router forwarded a valid identity
        // anyway, parse it best-effort so downstream per-row authorization (e.g.
        // storage owner/visibility, toFix §6.4) sees who is calling. A missing or
        // unparsable token on a public method stays anonymous instead of erroring.
        if (req.body && publicMethods.includes(req.body.method)) {
            try {
                const payload = parseRouterToken(req.headers, config.routerPublicKey);
                req.user        = payload.user;
                req.permit      = payload.permit;
                req.constraints = payload.constraints;
                req.meta        = payload.meta;
            } catch (_) { /* anonymous public call */ }
            return next();
        }

        // Bypass: explicit local-dev opt-in ONLY — OFF by default.
        // Gated on the real loopback SOCKET IP (NOT the client-forgeable Host header) AND a
        // dedicated env flag, deliberately decoupled from config.debug / NODE_ENV: enabling
        // debug logging — or a stray NODE_ENV=test — must never silently disable auth.
        // (Set AUTH_ALLOW_LOCAL_BYPASS=1 for local bootstrap/seeding without the Router.)
        const isLoopback = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
        if (isLoopback && process.env.AUTH_ALLOW_LOCAL_BYPASS === '1') {
            logger.warn(`[Security] Local Auth Bypass active (AUTH_ALLOW_LOCAL_BYPASS) for: ${req.body?.method || 'unknown'}`);
            return next();
        }

        // Verify Router token
        try {
            const payload = parseRouterToken(req.headers, config.routerPublicKey);
            req.user        = payload.user;
            req.permit      = payload.permit;
            req.constraints = payload.constraints;
            req.meta        = payload.meta;
            next();
        } catch (e) {
            const status = e.code === -32000 ? 400 : (e.code === -32001 ? 401 : 403);
            return res.status(status).json({
                jsonrpc: '2.0',
                error: e.rpcError || { code: -32000, message: e.message },
                id: req.body?.id,
            });
        }
    }

    return { handleSeed, handleVerify, middleware };
}

module.exports = { createAuthHandlers };
