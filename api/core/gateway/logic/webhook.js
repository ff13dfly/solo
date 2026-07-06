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

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK_RE = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i;
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
        if (!ALLOW_LOOPBACK && LOOPBACK_RE.test(target.hostname)) {
            return reject(new Error('webhook.send: loopback targets are not allowed (internal calls go via the Router)'));
        }

        const sentAt = Date.now();
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

module.exports = { send };
