/**
 * Cross-Box SOLO Peer RPC Relay (`api/library/peer-relay.js`)
 *
 * Symmetric to `api/library/relay.js` (which handles intra-box service-to-service
 * calls via the local Router), `peer-relay.js` is the official client for calling
 * a remote SOLO stack's Router (`/jsonrpc`) across boxes (e.g. Steward BC001 ->
 * Finance BC002, Catalog -> Pulse, or Agent -> Peer Agent on Mac mini).
 *
 * Supported authentication modes:
 *   1. M2M API Key (`apiKey`): sends `Authorization: ApiKey <apiKey>`.
 *   2. Static / Bot Bearer Token (`token`): sends `Authorization: Bearer <token>`,
 *      with optional `user.token.refresh` when `expiresAt` is known and `< 15%` TTL remains.
 *   3. Challenge-Response Login (`user` + `password`):
 *      - Performs `user.login.request` + SHA-256 `user.login.verify`;
 *      - Coalesces concurrent login/refresh attempts via a single-flight `inflight` Promise;
 *      - Automatically re-logs in once on `-32001` / HTTP 401 session expiry;
 *      - Proactively refreshes when `< 15%` TTL remains (plus optional background `.unref()` timer).
 *
 * Built-in safeguards:
 *   - Hop-count loop brake (`meta.hop`, default `maxHops = 3`) matching `gateway.webhook.send` (`target: 'solo'`);
 *   - `Connection: close` header to avoid stale keep-alive sockets across long intervals;
 *   - Exponential-backoff retry on transient network / 502 / 503 / 504 errors (never retries JSON-RPC business errors).
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TRIES = 3;
const DEFAULT_MAX_HOPS = 3;
const DEFAULT_REFRESH_RATIO = 0.15;
const FALLBACK_TTL_MS = 24 * 3600 * 1000;

function sha256(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function normalizeJsonRpcUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';
    const u = new URL(trimmed);
    if (!u.pathname || u.pathname === '/') {
        u.pathname = '/jsonrpc';
    } else if (!u.pathname.endsWith('/jsonrpc')) {
        u.pathname = u.pathname.replace(/\/+$/, '') + '/jsonrpc';
    }
    return u.toString();
}

function isTransientNetworkError(err) {
    if (!err) return false;
    if (err.isRpcError) return false;
    if (err.status && [502, 503, 504].includes(err.status)) return true;
    const msg = String(err.message || '').toLowerCase();
    const code = String(err.code || '').toLowerCase();
    return [
        'econnreset', 'etimedout', 'econnrefused', 'enotfound', 'ehostunreach',
        'socket hang up', 'network', 'fetch failed', 'aborted', 'timeout'
    ].some((pat) => msg.includes(pat) || code.includes(pat));
}

function createPeerRelay(options = {}) {
    const endpoint = normalizeJsonRpcUrl(
        options.endpoint || options.routerUrl || options.url || process.env.SOLO_PEER_URL || ''
    );
    const apiKey = options.apiKey || '';
    const user = options.user || options.username || '';
    const password = options.password || '';
    const deviceId = options.deviceId || 'solo-peer-relay';
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const tries = Number(options.tries) >= 1 ? Number(options.tries) : DEFAULT_TRIES;
    const maxHops = Number(options.maxHops) >= 1 ? Number(options.maxHops) : DEFAULT_MAX_HOPS;
    const refreshRatio = typeof options.refreshRatio === 'number' ? options.refreshRatio : DEFAULT_REFRESH_RATIO;
    const fetchFn = options.fetchFn || global.fetch;

    let state = {
        token: options.token || null,
        expiresAt: Number(options.expiresAt) || 0,
        issuedAt: options.token ? Date.now() : 0,
        ttlMs: Number(options.expiresAt) > Date.now() ? (Number(options.expiresAt) - Date.now()) : FALLBACK_TTL_MS,
        user: null,
        lastRefreshAt: 0,
    };

    let inflightAuth = null;
    let refreshTimer = null;

    function applyTokenResult(res) {
        if (!res || !res.token) return;
        const now = Date.now();
        const expiresAt = Number(res.expiresAt) || (now + FALLBACK_TTL_MS);
        const ttlMs = Math.max(expiresAt - now, 60000);
        state = {
            token: res.token,
            expiresAt,
            issuedAt: now,
            ttlMs,
            user: res.user || state.user || (user ? { username: user } : null),
            lastRefreshAt: now,
        };
    }

    function needsProactiveRefresh() {
        if (apiKey) return false;
        if (!state.token || !state.expiresAt) return false;
        const remaining = state.expiresAt - Date.now();
        return remaining <= state.ttlMs * refreshRatio;
    }

    function isExpired() {
        if (apiKey) return false;
        if (!state.token) return true;
        if (!state.expiresAt) return false;
        return Date.now() >= state.expiresAt - 5000;
    }

    async function rawPost(method, params, { authHeader = null, id = null, callTimeoutMs = timeoutMs } = {}) {
        if (!endpoint) {
            const err = new Error('peer-relay: endpoint URL is not configured');
            err.code = 'PEER_ENDPOINT_MISSING';
            throw err;
        }
        if (typeof fetchFn !== 'function') {
            throw new Error('peer-relay: fetch is not available in this runtime');
        }

        const headers = {
            'Content-Type': 'application/json',
            'Connection': 'close',
        };
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }

        const rpcId = id || `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const body = JSON.stringify({
            jsonrpc: '2.0',
            method,
            params: params || {},
            id: rpcId,
        });

        let lastErr;
        for (let attempt = 1; attempt <= tries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), callTimeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();

            try {
                const res = await fetchFn(endpoint, {
                    method: 'POST',
                    headers,
                    body,
                    signal: controller.signal,
                });
                const text = await res.text();
                let json = null;
                try { json = JSON.parse(text); } catch (_) { }

                if (json && json.error) {
                    const rpcErr = new Error(`[${method}] RPC ${json.error.code}: ${json.error.message}`);
                    rpcErr.code = json.error.code;
                    rpcErr.data = json.error.data;
                    rpcErr.status = res.status;
                    rpcErr.isRpcError = true;
                    throw rpcErr;
                }

                if (!res.ok) {
                    const httpErr = new Error(`[${method}] HTTP ${res.status}: ${text.slice(0, 200)}`);
                    httpErr.status = res.status;
                    throw httpErr;
                }

                if (!json || typeof json !== 'object') {
                    throw new Error(`[${method}] Invalid JSON-RPC response from ${endpoint}`);
                }

                return json.result;
            } catch (err) {
                lastErr = err;
                if (attempt < tries && isTransientNetworkError(err)) {
                    const delayMs = Math.min(300 * Math.pow(2, attempt - 1), 2000);
                    await new Promise((r) => setTimeout(r, delayMs));
                    continue;
                }
                throw err;
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastErr;
    }

    /**
     * Single-flight login or token refresh.
     */
    async function ensureAuth({ forceLogin = false } = {}) {
        if (apiKey) {
            return `ApiKey ${apiKey}`;
        }

        if (!forceLogin && state.token && !isExpired()) {
            if (needsProactiveRefresh()) {
                // Trigger single-flight refresh; if refresh fails and token isn't hard-expired yet, keep using it
                try {
                    await refreshOrLogin({ forceLogin: false });
                } catch (_) {
                    if (!isExpired()) return `Bearer ${state.token}`;
                }
            }
            return `Bearer ${state.token}`;
        }

        if (!user || !password) {
            if (state.token && !forceLogin) {
                return `Bearer ${state.token}`;
            }
            const err = new Error('peer-relay: no valid credentials configured (provide apiKey, token, or user+password)');
            err.code = 'PEER_AUTH_MISSING';
            throw err;
        }

        await refreshOrLogin({ forceLogin: true });
        return `Bearer ${state.token}`;
    }

    async function refreshOrLogin({ forceLogin = false } = {}) {
        if (inflightAuth) {
            return inflightAuth;
        }

        inflightAuth = (async () => {
            try {
                if (!forceLogin && state.token && !isExpired()) {
                    try {
                        const refreshed = await rawPost(
                            'user.token.refresh',
                            {},
                            { authHeader: `Bearer ${state.token}` }
                        );
                        if (refreshed && refreshed.token) {
                            applyTokenResult(refreshed);
                            return state.token;
                        }
                    } catch (_) {
                        // Fall through to full challenge-response login if user+password available
                        if (!user || !password) throw _;
                    }
                }

                if (!user || !password) {
                    const err = new Error('peer-relay: token expired and no user+password configured for re-login');
                    err.code = 'PEER_AUTH_EXPIRED';
                    throw err;
                }

                const ch = await rawPost('user.login.request', { username: user });
                if (!ch || !ch.challenge || !ch.salt) {
                    throw new Error('peer-relay: user.login.request returned incomplete challenge');
                }
                const passwordHash = sha256(password + ch.salt);
                const signature = sha256(ch.challenge + passwordHash);
                const verified = await rawPost('user.login.verify', {
                    username: user,
                    signature,
                    deviceId,
                });
                if (!verified || !verified.token) {
                    throw new Error('peer-relay: user.login.verify did not return a token');
                }
                applyTokenResult(verified);
                return state.token;
            } finally {
                inflightAuth = null;
            }
        })();

        return inflightAuth;
    }

    function isAuthFailure(err) {
        if (!err) return false;
        if (err.status === 401) return true;
        if (err.code === -32001 || err.code === -32002) return true;
        const msg = String(err.message || '').toLowerCase();
        return msg.includes('unauthorized') || msg.includes('token expired') || msg.includes('invalid token');
    }

    /**
     * Call a remote SOLO RPC method.
     *
     * @param {string} method - 2~4 segment lowercase dot-separated RPC method name
     * @param {object} [params={}] - Method parameters
     * @param {object} [callOpts={}] - Optional `{ hop, meta, idempotencyKey, timeoutMs, id }`
     */
    async function call(method, params = {}, callOpts = {}) {
        const incomingHop = Number(
            callOpts.hop ?? callOpts.meta?.hop ?? params?._meta?.hop ?? 0
        ) || 0;

        if (incomingHop >= maxHops) {
            const err = new Error(`peer-relay: maximum cross-box hop limit reached (${incomingHop}/${maxHops}) for ${method}`);
            err.code = 'PEER_MAX_HOPS_EXCEEDED';
            throw err;
        }

        const payloadParams = { ...(params || {}) };
        if (callOpts.idempotencyKey && !payloadParams.idempotencyKey) {
            payloadParams.idempotencyKey = callOpts.idempotencyKey;
        }
        const hasIncomingHop = callOpts.hop !== undefined || callOpts.meta?.hop !== undefined || params?._meta?.hop !== undefined;
        if (callOpts.propagateHop === true || (callOpts.propagateHop !== false && hasIncomingHop)) {
            payloadParams._meta = {
                ...(payloadParams._meta || {}),
                hop: incomingHop + 1,
            };
        }

        const authHeader = await ensureAuth({ forceLogin: false });
        try {
            return await rawPost(method, payloadParams, {
                authHeader,
                id: callOpts.id,
                callTimeoutMs: callOpts.timeoutMs || timeoutMs,
            });
        } catch (err) {
            if (!apiKey && user && password && isAuthFailure(err)) {
                await ensureAuth({ forceLogin: true });
                return await rawPost(method, payloadParams, {
                    authHeader: `Bearer ${state.token}`,
                    id: callOpts.id,
                    callTimeoutMs: callOpts.timeoutMs || timeoutMs,
                });
            }
            throw err;
        }
    }

    if (options.autoRefreshIntervalMs && Number(options.autoRefreshIntervalMs) > 0 && !apiKey) {
        refreshTimer = setInterval(() => {
            if (needsProactiveRefresh()) {
                refreshOrLogin({ forceLogin: false }).catch(() => { });
            }
        }, Number(options.autoRefreshIntervalMs));
        if (refreshTimer && typeof refreshTimer.unref === 'function') {
            refreshTimer.unref();
        }
    }

    function status() {
        if (apiKey) {
            return { mode: 'apiKey', endpoint, hasAuth: true };
        }
        if (!state.token) {
            return { mode: user ? 'challenge' : 'token', endpoint, hasAuth: false, hasToken: false };
        }
        const now = Date.now();
        return {
            mode: user ? 'challenge' : 'token',
            endpoint,
            hasAuth: !isExpired(),
            hasToken: true,
            expiresAt: state.expiresAt,
            ttlMs: state.ttlMs,
            remainingMs: state.expiresAt ? Math.max(0, state.expiresAt - now) : null,
            needsRefresh: needsProactiveRefresh(),
            expired: isExpired(),
            lastRefreshAt: state.lastRefreshAt,
        };
    }

    function close() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    return {
        call,
        login: (force = true) => refreshOrLogin({ forceLogin: Boolean(force) }),
        status,
        close,
        endpoint,
        maxHops,
    };
}

module.exports = {
    createPeerRelay,
    normalizeJsonRpcUrl,
};
