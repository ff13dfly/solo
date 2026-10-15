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
const crypto = require('crypto');
const { URL } = require('url');
const clock = require('../../../library/clock');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
function isInternalOrReservedHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    let h = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!h) return true;

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

    if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') {
        return true;
    }

    // IPv6 loopback, unspecified, link-local (fe80::/10), ULA (fc00::/7)
    if (
        h === '::1' ||
        h === '::' ||
        /^(?:0+:){7}0*[01]$/.test(h) ||
        /^fe[89ab][0-9a-f]:/.test(h) ||
        /^f[cd][0-9a-f]{2}:/.test(h)
    ) {
        return true;
    }

    // IPv4 loopback (127.0.0.0/8), unspecified (0.0.0.0/8), link-local/metadata (169.254.0.0/16),
    // Alibaba metadata (100.100.100.200), RFC1918 private ranges (10/8, 192.168/16, 172.16/12)
    if (
        /^127\./.test(h) ||
        /^0\./.test(h) ||
        /^169\.254\./.test(h) ||
        h === '100.100.100.200' ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
    ) {
        return true;
    }

    return false;
}

// Test/dev escape hatch: e2e harnesses and the dev mock listener ARE loopback
// targets. Default stays fail-closed for production posture.
const ALLOW_LOOPBACK = process.env.WEBHOOK_ALLOW_LOOPBACK === '1';

function send({ url, payload, type, targetId, secret, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (_) {
            return reject(new Error(`webhook.send: invalid url "${url}"`));
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return reject(new Error(`webhook.send: unsupported protocol "${target.protocol}"`));
        }
        if (!ALLOW_LOOPBACK && isInternalOrReservedHost(target.hostname)) {
            return reject(new Error('webhook.send: loopback targets are not allowed (internal calls go via the Router)'));
        }

        const sentAt = clock.now();
        const body = JSON.stringify({ type: type || 'notification', targetId: targetId || null, payload: payload || {}, sent_at: sentAt });

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Solo-Timestamp': String(sentAt),
        };
        if (secret) {
            headers['X-Solo-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
        }

        const client = target.protocol === 'https:' ? https : http;
        const req = client.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + (target.search || ''),
            method: 'POST',
            timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
            headers,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size <= MAX_RESPONSE_BYTES) chunks.push(c);   // SAFE: bounded
            });
            res.on('end', () => {
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

module.exports = { send, isInternalOrReservedHost };
