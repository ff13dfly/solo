/**
 * library/relay.js — 服务间内部调用的统一中继客户端
 *
 * @why 实现 docs/protocol/zh/security.md §7 系统服务账号机制（ADR-007）。
 *      所有需要发起内部跨服务调用的微服务（notification / nexus / orchestrator）
 *      必须通过本库进行 token 生命周期管理与 Router 调用，禁止自行实现。
 *      原因见 §7.7。
 *
 * @contract 依赖 user 服务实现以下接口：
 *   - user.bot.create({ uid, permit })            → 创建无密码 bot 账号（admin only）
 *   - user.bot.issue.token({ uid })                → 签发 bot 的初始 token（admin only）
 *                                                   返回 { token, expiresAt }
 *   - user.token.refresh()                        → 用当前 token 续签
 *                                                   返回 { token, expiresAt }
 *                                                   user 服务必须校验 caller.uid === currentToken.sub
 *
 * @redis-schema
 *   RELAY:TOKEN:<serviceName>        JSON { token, expiresAt, lastRefreshAt, sub }
 *   RELAY:TOKEN:<serviceName>:LOCK   "1" (NX + EX 30s)
 */

const http = require('http');
const https = require('https');
// walContext: per-request/per-consumer AsyncLocalStorage ({ uid, trace, depth }) —
// the in-process trace carrier (entity.js owns it; no require cycle: entity ⇏ relay).
const { walContext } = require('./entity');

const DEFAULT_ROTATE_BEFORE_MS = 2 * 60 * 60 * 1000;  // 2 hours
const DEFAULT_LOCK_TTL_SEC = 30;
const REFRESH_WAIT_POLL_MS = 200;
const REFRESH_WAIT_MAX_MS = 10000;
// Bound every internal Router RPC so a stalled upstream can't wedge the caller
// forever. Generous by default (> the Router's longest forward timeout, agent=90s)
// so it never preempts a legitimately slow forwarded call (e.g. agent.chat) — it
// only catches a connection that accepts but never responds. Override per service.
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

// ── ERROR TYPES ──────────────────────────────────────────────────────────────

class RelayError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RelayError';
        this.code = code;
    }
}

const ERR = {
    NO_TOKEN:        () => new RelayError('NO_TOKEN', 'No service token configured. Admin must call setServiceToken.'),
    TOKEN_EXPIRED:   () => new RelayError('TOKEN_EXPIRED', 'Service token expired and refresh failed.'),
    REFRESH_FAILED:  (m) => new RelayError('REFRESH_FAILED', `Token refresh failed: ${m}`),
    SUB_MISMATCH:    (e, a) => new RelayError('SUB_MISMATCH', `Token sub "${a}" does not match service "${e}"`),
    INVALID_TOKEN:   (m) => new RelayError('INVALID_TOKEN', `Invalid token: ${m}`),
    RPC_FAILED:      (m) => new RelayError('RPC_FAILED', `RPC call failed: ${m}`),
    REFRESH_TIMEOUT: () => new RelayError('REFRESH_TIMEOUT', 'Timed out waiting for concurrent refresh.'),
    RPC_TIMEOUT:     (ms) => new RelayError('RPC_TIMEOUT', `Router RPC timed out after ${ms}ms`),
};

// ── FACTORY ──────────────────────────────────────────────────────────────────

/**
 * @param {object}  options
 * @param {object}  options.redis              ioredis / node-redis v4 client
 * @param {string}  options.serviceName        e.g. 'notification' — used as bot uid namespace
 * @param {string}  options.routerUrl          full Router RPC endpoint
 * @param {number} [options.rotateBeforeMs]    rotate when TTL < this (default 2h)
 * @param {number} [options.lockTtlSec]        refresh lock TTL (default 30s)
 * @param {function} [options.walLogger]       optional logger.insert function for audit (signature: (key, data) => void)
 * @param {function} [options.now]             time source for testing (default Date.now)
 */
function createRelay(options) {
    const {
        redis,
        serviceName,
        routerUrl,
        rotateBeforeMs = DEFAULT_ROTATE_BEFORE_MS,
        lockTtlSec = DEFAULT_LOCK_TTL_SEC,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        walLogger = null,
        now = Date.now,
    } = options || {};

    if (!redis) throw new Error('[relay] redis client is required');
    if (!serviceName) throw new Error('[relay] serviceName is required');
    if (!routerUrl) throw new Error('[relay] routerUrl is required');

    const expectedSub = `system.${serviceName}`;
    const tokenKey = `RELAY:TOKEN:${serviceName}`;
    const lockKey = `${tokenKey}:LOCK`;

    // ── INTERNAL HELPERS ─────────────────────────────────────────────────────

    async function readState() {
        const raw = await redis.get(tokenKey);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            throw ERR.INVALID_TOKEN('stored state is not valid JSON');
        }
    }

    async function writeState(state) {
        await redis.set(tokenKey, JSON.stringify(state));
    }

    async function clearState() {
        await redis.del(tokenKey);
    }

    function audit(event, extra) {
        if (!walLogger) return;
        try {
            walLogger(`RELAY:${serviceName}`, {
                event,
                serviceName,
                ts: now(),
                ...extra,
            });
        } catch (e) {
            // audit failure must not block business
        }
    }

    function validateState(state) {
        if (!state || !state.token || !state.expiresAt) {
            throw ERR.INVALID_TOKEN('missing token or expiresAt');
        }
        if (state.sub !== expectedSub) {
            throw ERR.SUB_MISMATCH(expectedSub, state.sub);
        }
    }

    function isExpired(state) {
        return now() >= state.expiresAt;
    }

    function needsRotation(state) {
        return (state.expiresAt - now()) < rotateBeforeMs;
    }

    // ── REFRESH FLOW ─────────────────────────────────────────────────────────

    async function acquireLock() {
        const result = await redis.set(lockKey, '1', { NX: true, EX: lockTtlSec });
        return result === 'OK' || result === true;
    }

    async function releaseLock() {
        await redis.del(lockKey);
    }

    async function waitForOtherRefresh() {
        const deadline = now() + REFRESH_WAIT_MAX_MS;
        while (now() < deadline) {
            await new Promise(r => setTimeout(r, REFRESH_WAIT_POLL_MS));
            const lockHeld = await redis.get(lockKey);
            if (!lockHeld) {
                const state = await readState();
                if (state && !needsRotation(state)) return state;
                return null;
            }
        }
        throw ERR.REFRESH_TIMEOUT();
    }

    async function performRefresh(currentToken) {
        const response = await rpcViaRouter('user.token.refresh', {}, currentToken);
        if (!response || !response.token || !response.expiresAt) {
            throw ERR.REFRESH_FAILED('response missing token or expiresAt');
        }
        const newState = {
            token: response.token,
            expiresAt: response.expiresAt,
            lastRefreshAt: now(),
            sub: expectedSub,
        };
        await writeState(newState);
        audit('refresh', { newExpiresAt: newState.expiresAt });
        return newState;
    }

    async function refreshIfNeeded(state) {
        if (!needsRotation(state)) return state;

        const gotLock = await acquireLock();
        if (!gotLock) {
            const fresh = await waitForOtherRefresh();
            if (fresh) return fresh;
            const reread = await readState();
            if (reread && !needsRotation(reread)) return reread;
            throw ERR.REFRESH_FAILED('concurrent refresh did not produce a usable token');
        }

        try {
            return await performRefresh(state.token);
        } catch (e) {
            audit('refresh_failed', { error: e.message });
            if (e.code === 'TOKEN_EXPIRED' || (e.code === 'RPC_FAILED' && isExpired(state))) {
                await clearState();
                throw ERR.TOKEN_EXPIRED();
            }
            throw e instanceof RelayError ? e : ERR.REFRESH_FAILED(e.message);
        } finally {
            await releaseLock();
        }
    }

    async function getValidToken() {
        const state = await readState();
        if (!state) throw ERR.NO_TOKEN();
        validateState(state);
        if (isExpired(state)) {
            await clearState();
            throw ERR.TOKEN_EXPIRED();
        }
        const refreshed = await refreshIfNeeded(state);
        return refreshed.token;
    }

    // ── ROUTER RPC ───────────────────────────────────────────────────────────

    function rpcViaRouter(method, params, token) {
        return new Promise((resolve, reject) => {
            const url = new URL(routerUrl);
            const client = url.protocol === 'https:' ? https : http;
            const body = JSON.stringify({
                jsonrpc: '2.0',
                id: `${serviceName}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
                method,
                params: params || {},
            });
            // Chain correlation: forward the current trace context (set by the service's
            // auth path or an async consumer via walContext) so the Router inherits the
            // chain instead of minting a new one. Absent context = this call starts a chain.
            const traceHeaders = {};
            const store = walContext.getStore();
            if (store && store.trace) {
                traceHeaders['X-Trace-Id'] = String(store.trace);
                traceHeaders['X-Trace-Depth'] = String(Number.isFinite(store.depth) ? store.depth : 0);
            }
            const req = client.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + (url.search || ''),
                method: 'POST',
                timeout: requestTimeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Authorization': `Bearer ${token}`,
                    ...traceHeaders,
                },
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        const err = ERR.RPC_FAILED(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
                        err.httpStatus = res.statusCode;   // lets callers classify permanent (4xx) vs transient
                        return reject(err);
                    }
                    let parsed;
                    try {
                        parsed = JSON.parse(text);
                    } catch (e) {
                        return reject(ERR.RPC_FAILED('invalid JSON response'));
                    }
                    if (parsed.error) {
                        const err = ERR.RPC_FAILED(parsed.error.message || 'rpc error');
                        err.rpcCode = parsed.error.code;   // downstream JSON-RPC code — no longer opaque
                        return reject(err);
                    }
                    resolve(parsed.result);
                });
            });
            // Socket idle-timeout: for a buffered JSON response this bounds total wait,
            // so a Router that accepts but never replies can't hang the caller forever.
            req.on('timeout', () => req.destroy(ERR.RPC_TIMEOUT(requestTimeoutMs)));
            req.on('error', e => reject(e instanceof RelayError ? e : ERR.RPC_FAILED(e.message)));
            req.write(body);
            req.end();
        });
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────

    /**
     * Call a service method via Router using the bot's service token.
     * Transparently handles token lifecycle (read, validate, refresh).
     *
     * @param {string} method  e.g. 'gateway.email.send'
     * @param {object} params  RPC params
     * @returns {Promise<any>} the `result` field of the JSON-RPC response
     * @throws  RelayError (NO_TOKEN | TOKEN_EXPIRED | REFRESH_FAILED | RPC_FAILED)
     */
    async function call(method, params) {
        const token = await getValidToken();
        audit('call', { method });
        return await rpcViaRouter(method, params, token);
    }

    /**
     * Return a currently-valid bot token string (refreshing if near expiry).
     * @why Some callers need to authenticate as the bot through a different
     *      transport than this relay's own rpcViaRouter — e.g. the orchestrator
     *      worker hands the token to runner.run as the step Authorization header
     *      (event.md §8). They need the raw token, not a wrapped call().
     * @throws RelayError (NO_TOKEN | TOKEN_EXPIRED | REFRESH_FAILED)
     */
    async function getToken() {
        return await getValidToken();
    }

    /**
     * Call a method via Router using an EXPLICIT, caller-supplied token instead of
     * this relay's own service-bot token. Bypasses the token lifecycle + SUB guard
     * so a caller can act AS a different principal.
     * @why §1.2 per-Sentinel identity (context.md §11): nexus issues each Sentinel's
     *      declarative data-fetch under that Sentinel's OWN bot token so Router
     *      checkAccess enforces the Sentinel's narrow permit (not the broad nexus
     *      permit) and the audit trail attributes the fetch to the Sentinel. The
     *      caller owns the supplied token's lifecycle (issue / refresh / revoke).
     * @param {string} token   a currently-valid bot session token for the principal to act as
     * @param {string} method  e.g. 'collection.payment.get'
     * @param {object} params  RPC params
     */
    async function callAs(token, method, params) {
        if (!token || typeof token !== 'string') throw ERR.INVALID_TOKEN('callAs requires a token string');
        audit('call_as', { method });
        return await rpcViaRouter(method, params, token);
    }

    /**
     * Inject a token issued by user.bot.issue.token. Called by the service's
     * setServiceToken admin handler.
     *
     * @param {object} payload
     * @param {string} payload.token      opaque session token from user.bot.issue.token
     * @param {number} payload.expiresAt  unix ms timestamp
     * @param {string} [payload.sub]      bot uid; must match `system.<serviceName>` if provided
     */
    async function setToken({ token, expiresAt, sub }) {
        if (!token || typeof token !== 'string') throw ERR.INVALID_TOKEN('token must be a string');
        if (!expiresAt || typeof expiresAt !== 'number') throw ERR.INVALID_TOKEN('expiresAt must be a number');
        if (expiresAt <= now()) throw ERR.INVALID_TOKEN('token is already expired');
        if (sub && sub !== expectedSub) throw ERR.SUB_MISMATCH(expectedSub, sub);

        const state = {
            token,
            expiresAt,
            lastRefreshAt: now(),
            sub: expectedSub,
        };
        await writeState(state);
        audit('set_token', { expiresAt });
    }

    /**
     * Inspect current token status. Safe to expose to ops dashboards.
     * Never returns the actual token string.
     */
    async function status() {
        const state = await readState();
        if (!state) {
            return { hasToken: false };
        }
        return {
            hasToken: true,
            sub: state.sub,
            expiresAt: state.expiresAt,
            ttlMs: Math.max(0, state.expiresAt - now()),
            lastRefreshAt: state.lastRefreshAt,
            needsRotation: needsRotation(state),
            expired: isExpired(state),
        };
    }

    /**
     * Emergency clear. Use only when admin needs to force re-injection
     * (e.g. suspected token compromise).
     */
    async function clear() {
        await clearState();
        await releaseLock();
        audit('clear', {});
    }

    return { call, callAs, getToken, setToken, status, clear };
}

module.exports = {
    createRelay,
    RelayError,
};
