/**
 * Outbound webhook channel — gateway is the OUTBOUND adapter layer (ingress is the
 * inbound mirror). Targets are machines (third-party callbacks, chat-ops bots), so
 * the URL comes from the caller (notification rule params / nexus sentinel profile),
 * never from a user profile.
 *
 * Authenticity: when a `secret` is configured the JSON body is signed with
 * HMAC-SHA256 → `X-Solo-Signature: sha256=<hex>` (+ `X-Solo-Timestamp`), the same
 * scheme third parties use to verify, mirroring ingress's API-key trust direction.
 *
 * SSRF note: URLs are admin-configured (notification.config.set / sentinel update
 * are permit-gated), not end-user input. Plain-IP loopback targets are still
 * refused as a guardrail — internal services talk via the Router, never via
 * gateway webhooks.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
const { URL } = require('url');
const clock = require('../../../library/clock');
const { isInternalOrReservedHost: sharedIsInternalOrReservedHost } = require('../../../library/ssrf');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SOLO_HOPS = 3;
const PATTERNS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IPV4_LOOPBACK_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function clientError(message, httpStatus = 400, code = -32602) {
    const err = new Error(message);
    err.httpStatus = httpStatus;
    err.code = code;
    return err;
}

function normalizeHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') return '';
    let h = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!h) return '';

    // Unwrap IPv4-mapped IPv6 (dotted-quad or canonical hex from WHATWG URL parser)
    const mappedHex = h.match(/^(?:::ffff:|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        h = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    } else {
        const mappedDot = h.match(/^(?:::ffff:|(?:0+:){5}ffff:)(\d+\.\d+\.\d+\.\d+)$/);
        if (mappedDot) h = mappedDot[1];
    }
    return h;
}

/**
 * Narrow loopback check for Cross-Box Bridge (`target: 'solo'`) on `/jsonrpc`.
 * Matches ONLY localhost / 127.0.0.0/8 / ::1 (including IPv4-mapped loopback).
 * NEVER matches 0.0.0.0, ::, *.localhost, cloud metadata (169.254.*, 100.100.100.200,
 * metadata.google.internal), or RFC1918 LAN ranges.
 */
function isLoopbackHost(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return false;
    if (h === 'localhost' || h === '::1' || /^(?:0+:){7}0*1$/.test(h)) return true;
    if (IPV4_LOOPBACK_RE.test(h)) return true;
    return false;
}

function isInternalOrReservedHost(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return true;
    return sharedIsInternalOrReservedHost(h);
}

// Test/dev escape hatch: e2e harnesses and the dev mock listener ARE loopback
// targets. Default stays fail-closed for production posture.
const ALLOW_LOOPBACK = process.env.WEBHOOK_ALLOW_LOOPBACK === '1';

function mapSoloIngressErrorStatus(errorMsg) {
    const msg = String(errorMsg || '');
    if (/invalid api key/i.test(msg)) return 401;
    if (/source disabled/i.test(msg)) return 403;
    if (/event not delivered/i.test(msg)) return 502;
    return 400;
}

function send({ url, payload, type, targetId, secret, timeoutMs, target: targetMode, meta, idempotencyKey }) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (_) {
            return reject(clientError(`webhook.send: invalid url "${url}"`));
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return reject(clientError(`webhook.send: unsupported protocol "${target.protocol}"`));
        }

        const mode = targetMode || 'webhook';
        if (mode !== 'webhook' && mode !== 'solo') {
            return reject(clientError(`webhook.send: unsupported target "${mode}" (expected 'webhook' or 'solo')`));
        }

        const sentAt = clock.now();
        let body;
        let headers;
        let requestId = null;

        if (mode === 'solo') {
            if (target.pathname !== '/jsonrpc') {
                return reject(clientError(`webhook.send (solo): target url path must be '/jsonrpc', got '${target.pathname}'`));
            }
            if (!secret || typeof secret !== 'string' || !secret.trim()) {
                return reject(clientError('webhook.send (solo): secret (peer ingress source API key) is required'));
            }
            if (!ALLOW_LOOPBACK && isInternalOrReservedHost(target.hostname) && !isLoopbackHost(target.hostname)) {
                return reject(clientError('webhook.send: internal or reserved targets are not allowed'));
            }
            if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
                return reject(clientError('webhook.send (solo): meta must be an object'));
            }
            const inHop = (meta && meta.hop !== undefined) ? meta.hop : 0;
            if (!Number.isInteger(inHop) || inHop < 0) {
                return reject(clientError('webhook.send (solo): meta.hop must be a non-negative integer'));
            }
            if (inHop >= MAX_SOLO_HOPS) {
                return reject(clientError(`webhook.send (solo): federation hop limit reached (hop=${inHop}, max=${MAX_SOLO_HOPS})`));
            }

            const nextMeta = { ...(meta || {}), hop: inHop + 1 };
            if (type && nextMeta.type === undefined) nextMeta.type = type;
            if (targetId && nextMeta.targetId === undefined) nextMeta.targetId = targetId;

            if (idempotencyKey !== undefined && idempotencyKey !== null && String(idempotencyKey).length > 0) {
                const rawKey = String(idempotencyKey);
                if (PATTERNS_ID_RE.test(rawKey)) {
                    requestId = rawKey;
                } else {
                    requestId = 'idem_' + crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32);
                    nextMeta.idempotency_key = rawKey;
                }
            } else {
                requestId = `brg_${sentAt}_${crypto.randomBytes(6).toString('hex')}`;
            }

            const data = (payload && typeof payload === 'object' && !Array.isArray(payload))
                ? payload
                : (payload === undefined || payload === null ? {} : { value: payload });

            body = JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                method: 'ingress.ingest',
                params: {
                    request_id: requestId,
                    data,
                    meta: nextMeta,
                },
            });
            headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization': `ApiKey ${secret.trim()}`,
                'X-Solo-Timestamp': String(sentAt),
            };
        } else {
            if (!ALLOW_LOOPBACK && isInternalOrReservedHost(target.hostname)) {
                return reject(clientError('webhook.send: loopback targets are not allowed (internal calls go via the Router)'));
            }
            body = JSON.stringify({ type: type || 'notification', targetId: targetId || null, payload: payload || {}, sent_at: sentAt });
            headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-Solo-Timestamp': String(sentAt),
            };
            if (secret) {
                headers['X-Solo-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
            }
        }

        const safeLookup = (hostname, opts, cb) => {
            const callback = typeof opts === 'function' ? opts : cb;
            const options  = typeof opts === 'object' && opts !== null ? opts : {};
            dns.lookup(hostname, options, (err, address, family) => {
                if (err) return callback(err);
                const checkIp = (ip) => {
                    if (ALLOW_LOOPBACK) return true;
                    if (mode === 'solo' && isLoopbackHost(ip)) return true;
                    return !isInternalOrReservedHost(ip);
                };
                if (Array.isArray(address)) {
                    for (const entry of address) {
                        if (!checkIp(entry && entry.address)) {
                            return callback(clientError(`webhook.send: resolved IP for "${hostname}" is internal or reserved`));
                        }
                    }
                } else if (!checkIp(address)) {
                    return callback(clientError(`webhook.send: resolved IP for "${hostname}" is internal or reserved`));
                }
                return callback(null, address, family);
            });
        };

        const client = target.protocol === 'https:' ? https : http;
        const req = client.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + (target.search || ''),
            method: 'POST',
            timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
            headers,
            lookup: safeLookup,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size <= MAX_RESPONSE_BYTES) chunks.push(c);   // SAFE: bounded
            });
            res.on('end', () => {
                if (mode === 'solo') {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        const err = new Error(`solo bridge target responded ${res.statusCode}`);
                        err.httpStatus = res.statusCode;
                        return reject(err);
                    }
                    let rpc;
                    try {
                        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch (_) {
                        const err = new Error('webhook.send (solo): peer returned invalid JSON');
                        err.httpStatus = 502;
                        return reject(err);
                    }
                    if (!rpc || typeof rpc !== 'object') {
                        const err = new Error('webhook.send (solo): empty JSON-RPC envelope from peer');
                        err.httpStatus = 502;
                        return reject(err);
                    }
                    if (rpc.error) {
                        const code = rpc.error.code;
                        const err = new Error(`webhook.send (solo): peer RPC error (${code}): ${rpc.error.message || 'unknown'}`);
                        err.httpStatus = (code === -32600 || code === -32601 || code === -32602) ? 400
                            : code === -32001 ? 401
                            : code === -32003 ? 403
                            : 502;
                        return reject(err);
                    }
                    const r = rpc.result;
                    if (!r || typeof r !== 'object') {
                        const err = new Error('webhook.send (solo): missing result in peer JSON-RPC response');
                        err.httpStatus = 502;
                        return reject(err);
                    }
                    if (r.ok === true) {
                        const resolvedId = r.request_id || requestId;
                        return resolve({
                            success: true,
                            status: 200,
                            provider: 'solo',
                            messageId: resolvedId,
                            requestId: resolvedId,
                            duplicate: r.duplicate === true,
                            ...(typeof r.stream === 'string' ? { stream: r.stream } : {}),
                        });
                    }
                    if (r.ok === false && Array.isArray(r.violations)) {
                        const resolvedId = r.request_id || requestId;
                        return resolve({
                            success: false,
                            held: true,
                            status: 422,
                            provider: 'solo',
                            messageId: resolvedId,
                            requestId: resolvedId,
                            error: r.error || 'dataSchema violation — held for human review',
                            violations: r.violations,
                        });
                    }
                    const err = new Error(`webhook.send (solo): peer ingress rejected delivery: ${r.error || 'unknown error'}`);
                    err.httpStatus = mapSoloIngressErrorStatus(r.error);
                    return reject(err);
                }

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ success: true, status: res.statusCode, provider: 'webhook', messageId: `wh-${sentAt}` });
                } else {
                    const err = new Error(`webhook target responded ${res.statusCode}`);
                    err.httpStatus = res.statusCode;
                    reject(err);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`webhook.send: timed out after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`)));
        req.on('error', (e) => reject(e));
        req.write(body);
        req.end();
    });
}

module.exports = { send, isInternalOrReservedHost, isLoopbackHost };
