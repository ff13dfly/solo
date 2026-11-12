/**
 * Safe Outbound HTTP Client (`api/library/outbound.js`)
 *
 * Canonical SSRF-hardened outbound HTTP/HTTPS client for SOLO services,
 * workflow HTTP steps, and connector workers.
 *
 * Defense-in-depth guarantees:
 *   1. Hostname & DNS Rebinding Denylist:
 *      Blocks `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`,
 *      and wildcard DNS rebinding domains (`*.nip.io`, `*.sslip.io`, `*.xip.io`, `localtest.me`, `lvh.me`).
 *   2. Private / Loopback / Link-Local / CGNAT / Metadata IP Blocking:
 *      Delegates to `library/ssrf.js` (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
 *      `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`, IPv6 loopback/ULA/link-local/mapped).
 *   3. Explicit Trusted Peer Allowlist (`trustedPeers` / `SOLO_OUTBOUND_TRUSTED_PEERS`):
 *      Allows specific `(hostPattern, ip)` pairs (e.g. Tailscale peer boxes `*.w3os.net=100.68.103.124`)
 *      without opening the entire `100.64.0.0/10` or RFC1918 range.
 *   4. Socket-Level DNS Pinning:
 *      Resolves DNS once via `assertPublicHost` and injects a custom `lookup` hook into
 *      `http.request` / `https.request` returning the verified IP, eliminating DNS Rebinding TOCTOU
 *      between pre-flight inspection and socket connection while preserving TLS SNI (`servername`).
 *   5. Hop-by-Hop Redirect Re-validation:
 *      Never follows redirects blindly. When `followRedirects: false` (default), 3xx responses are
 *      returned as-is without following `Location`. When `followRedirects: true` (up to `maxRedirects`),
 *      each redirect hop's target URL is parsed and re-verified through `assertPublicHost` + DNS pinning.
 *   6. Streaming Response Cap & Hard Timeout:
 *      Enforces `maxBodyBytes` (default 2 MiB) on the response stream and `maxTimeoutMs` (default 60s).
 */

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { normalizeHostname, isInternalOrReservedHost } = require('./ssrf');

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_TIMEOUT_MS = 60000;           // 60 s
const DEFAULT_TIMEOUT_MS = 15000;       // 15 s
const DEFAULT_MAX_REDIRECTS = 5;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE_MAX = 256;
const DNS_LOOKUP_TIMEOUT_MS = 4000;

const FORBIDDEN_HOST_RE = [
    /^localhost$/i,
    /\.localhost$/i,
    /\.local$/i,
    /\.internal$/i,
    /(^|\.)metadata\.google\.internal\.?$/i,
    /\.(nip|sslip|xip)\.io$/i,
    /(^|\.)(localtest\.me|lvh\.me)$/i,
];

const _dnsCache = new Map();

function isForbiddenHostname(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return true;
    return FORBIDDEN_HOST_RE.some((re) => re.test(h));
}

function isPrivateOrReservedIp(ip, { allowLoopback = false } = {}) {
    const clean = normalizeHostname(ip);
    if (!clean) return true;
    const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) return isPrivateOrReservedIp(v4Mapped[1], { allowLoopback });
    if (!net.isIP(clean)) return true;
    return isInternalOrReservedHost(clean, { allowLoopback });
}

/**
 * Parse trusted peer entries from array or comma-separated env string.
 * Supported formats:
 *   - Array of `{ host: '*.w3os.net', ip: '100.68.103.124' }` or `'*.w3os.net=100.68.103.124'` or `'100.68.103.124'`
 *   - Env string: `SOLO_OUTBOUND_TRUSTED_PEERS="*.w3os.net=100.68.103.124,100.71.109.85"`
 *   - Legacy Steward env: `STEWARD_OUTBOUND_ALLOW_TAILNET_IPS="100.68.103.124,100.71.109.85"` (matches `*.w3os.net` or direct IP)
 */
function parseTrustedPeers(trustedPeersOpt) {
    const entries = [];
    const addEntry = (hostPattern, ip) => {
        const cleanIp = normalizeHostname(ip);
        if (!cleanIp || !net.isIP(cleanIp)) return;
        const cleanHost = normalizeHostname(hostPattern || '*');
        entries.push({ host: cleanHost || '*', ip: cleanIp });
    };

    if (Array.isArray(trustedPeersOpt)) {
        for (const item of trustedPeersOpt) {
            if (!item) continue;
            if (typeof item === 'string') {
                const eqIdx = item.indexOf('=');
                if (eqIdx > 0) addEntry(item.slice(0, eqIdx).trim(), item.slice(eqIdx + 1).trim());
                else addEntry('*', item.trim());
            } else if (typeof item === 'object' && item.ip) {
                addEntry(item.host || '*', item.ip);
            }
        }
    }

    const soloEnv = String(process.env.SOLO_OUTBOUND_TRUSTED_PEERS || '').trim();
    if (soloEnv) {
        for (const raw of soloEnv.split(',')) {
            const token = raw.trim();
            if (!token) continue;
            const eqIdx = token.indexOf('=');
            if (eqIdx > 0) addEntry(token.slice(0, eqIdx).trim(), token.slice(eqIdx + 1).trim());
            else addEntry('*', token);
        }
    }

    const legacyTailnet = String(process.env.STEWARD_OUTBOUND_ALLOW_TAILNET_IPS || '').trim();
    if (legacyTailnet) {
        for (const raw of legacyTailnet.split(',')) {
            const ip = raw.trim();
            if (!ip) continue;
            addEntry('*.w3os.net', ip);
            addEntry(ip, ip);
        }
    }

    return entries;
}

function matchHostPattern(hostname, pattern) {
    const h = normalizeHostname(hostname);
    const p = normalizeHostname(pattern);
    if (!p || p === '*') return true;
    if (p.startsWith('*.')) {
        const suffix = p.slice(1); // '.w3os.net'
        return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === p;
}

function isTrustedPeer(hostname, ip, trustedPeersOpt) {
    const cleanHost = normalizeHostname(hostname);
    const cleanIp = normalizeHostname(ip);
    const peers = parseTrustedPeers(trustedPeersOpt);
    if (peers.length === 0) return false;
    return peers.some((p) => p.ip === cleanIp && matchHostPattern(cleanHost, p.host));
}

function dnsLookupWithTimeout(hostname, options, timeoutMs = DNS_LOOKUP_TIMEOUT_MS, lookupFn = dns.lookup) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`DNS lookup timed out after ${timeoutMs}ms for ${hostname}`);
            err.code = 'ETIMEDOUT';
            reject(err);
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([lookupFn(hostname, options), timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Validate hostname and resolve it to a verified public (or trusted-peer) IP.
 * Returns `{ address: string, family: 4 | 6 }`.
 */
async function assertPublicHost(hostname, opts = {}) {
    const {
        allowLoopback = false,
        trustedPeers = null,
        lookupFn = dns.lookup,
        useCache = lookupFn === dns.lookup,
    } = opts;

    const clean = normalizeHostname(hostname);
    if (!clean) {
        const err = new Error('outbound: empty hostname');
        err.code = 'SSRF_BLOCKED';
        throw err;
    }

    if (isForbiddenHostname(clean) && !(allowLoopback && (clean === 'localhost' || clean.endsWith('.localhost')))) {
        const err = new Error(`outbound: forbidden hostname "${hostname}"`);
        err.code = 'SSRF_BLOCKED';
        throw err;
    }

    const literalFamily = net.isIP(clean);
    if (literalFamily) {
        if (isPrivateOrReservedIp(clean, { allowLoopback }) && !isTrustedPeer(clean, clean, trustedPeers)) {
            const err = new Error(`outbound: private or reserved IP blocked (${clean})`);
            err.code = 'SSRF_BLOCKED';
            throw err;
        }
        return { address: clean, family: literalFamily };
    }

    let records;
    const now = Date.now();
    const cached = useCache ? _dnsCache.get(clean) : null;

    try {
        records = await dnsLookupWithTimeout(clean, { all: true, verbatim: false }, DNS_LOOKUP_TIMEOUT_MS, lookupFn);
    } catch (e) {
        try {
            records = await dnsLookupWithTimeout(clean, { all: true, family: 4 }, DNS_LOOKUP_TIMEOUT_MS, lookupFn);
        } catch (e4) {
            if (cached && cached.expiresAt > now) {
                records = cached.records;
            } else {
                const err = new Error(`outbound: DNS lookup failed for "${hostname}": ${e4.message || e.message}`);
                err.code = e4.code || e.code || 'ENOTFOUND';
                throw err;
            }
        }
    }

    const list = Array.isArray(records) ? records : (records ? [records] : []);
    if (list.length === 0) {
        const err = new Error(`outbound: DNS lookup returned no records for "${hostname}"`);
        err.code = 'ENOTFOUND';
        throw err;
    }

    for (const r of list) {
        const addr = typeof r === 'string' ? r : r?.address;
        if (!addr) continue;
        if (isPrivateOrReservedIp(addr, { allowLoopback }) && !isTrustedPeer(clean, addr, trustedPeers)) {
            const err = new Error(`outbound: hostname "${hostname}" resolved to private/reserved IP (${addr})`);
            err.code = 'SSRF_BLOCKED';
            throw err;
        }
    }

    if (useCache) {
        if (_dnsCache.size >= DNS_CACHE_MAX) {
            const oldestKey = _dnsCache.keys().next().value;
            if (oldestKey !== undefined) _dnsCache.delete(oldestKey);
        }
        _dnsCache.set(clean, { records: list, expiresAt: now + DNS_CACHE_TTL_MS });
    }

    const first = list[0];
    const firstAddr = typeof first === 'string' ? first : first.address;
    const firstFamily = (typeof first === 'object' && first.family) ? first.family : (net.isIP(firstAddr) || 4);
    return { address: firstAddr, family: firstFamily };
}

/**
 * Execute a single HTTP/HTTPS request with socket-level DNS pinning and response size cap.
 */
function pinnedHttpRequest(parsedUrl, {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBodyBytes = MAX_BODY_BYTES,
    pinnedAddress,
    pinnedFamily,
}) {
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const cleanHost = normalizeHostname(parsedUrl.hostname);

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (err) reject(err);
            else resolve(val);
        };

        const reqOpts = {
            protocol: parsedUrl.protocol,
            hostname: cleanHost,
            port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
            path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
            method,
            headers: {
                ...headers,
                Host: headers.Host || headers.host || parsedUrl.host,
            },
            servername: cleanHost,
            lookup: (_host, lookupOpts, cb) => {
                if (typeof lookupOpts === 'function') {
                    return lookupOpts(null, pinnedAddress, pinnedFamily);
                }
                if (lookupOpts && lookupOpts.all) {
                    return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
                }
                return cb(null, pinnedAddress, pinnedFamily);
            },
        };

        const req = transport.request(reqOpts, (res) => {
            const chunks = [];
            let received = 0;

            res.on('data', (chunk) => {
                if (settled) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                received += buf.byteLength;
                if (received > maxBodyBytes) {
                    req.destroy();
                    const err = new Error(`outbound: response exceeded ${maxBodyBytes} bytes cap`);
                    err.code = 'ERR_OUTBOUND_MAX_BODY';
                    finish(err);
                    return;
                }
                chunks.push(buf);
            });

            res.on('end', () => {
                const rawBuffer = Buffer.concat(chunks);
                const respHeaders = {};
                for (const [k, v] of Object.entries(res.headers || {})) {
                    respHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
                }
                finish(null, {
                    status: res.statusCode || 0,
                    ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
                    headers: respHeaders,
                    rawBuffer,
                    rawText: rawBuffer.toString('utf8'),
                });
            });

            res.on('error', (err) => finish(err));
        });

        req.on('error', (err) => finish(err));

        timer = setTimeout(() => {
            req.destroy();
            const err = new Error(`outbound: request timed out after ${timeoutMs}ms`);
            err.code = 'ETIMEDOUT';
            finish(err);
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();

        if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
            req.write(body);
        }
        req.end();
    });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Execute an SSRF-hardened outbound HTTP/HTTPS request.
 *
 * @param {string|URL} urlInput
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers={}]
 * @param {string|Buffer|object} [opts.body]
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.maxBodyBytes=2097152]
 * @param {boolean} [opts.followRedirects=false] - When true, validates every redirect hop against SSRF rules
 * @param {number} [opts.maxRedirects=5]
 * @param {boolean} [opts.allowLoopback=false]
 * @param {Array|string} [opts.trustedPeers]
 * @param {Function} [opts.lookupFn]
 */
async function outboundRequest(urlInput, {
    method = 'GET',
    headers = {},
    body = undefined,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBodyBytes = MAX_BODY_BYTES,
    followRedirects = false,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowLoopback = false,
    trustedPeers = null,
    lookupFn = dns.lookup,
} = {}) {
    let currentUrl = new URL(String(urlInput));
    let currentMethod = String(method || 'GET').toUpperCase();
    let currentHeaders = { ...(headers || {}) };
    let reqBody = body;

    if (reqBody !== undefined && reqBody !== null && typeof reqBody !== 'string' && !Buffer.isBuffer(reqBody)) {
        reqBody = JSON.stringify(reqBody);
        if (!currentHeaders['content-type'] && !currentHeaders['Content-Type']) {
            currentHeaders['Content-Type'] = 'application/json';
        }
    }

    const effectiveTimeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 500), MAX_TIMEOUT_MS);
    const effectiveMaxBody = Math.min(Math.max(Number(maxBodyBytes) || MAX_BODY_BYTES, 1024), MAX_BODY_BYTES * 10);
    const redirectLimit = followRedirects ? Math.min(Math.max(Number(maxRedirects) || 0, 0), 10) : 0;

    let redirectsFollowed = 0;

    while (true) {
        if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
            const err = new Error(`outbound: unsupported protocol "${currentUrl.protocol}" (only http/https allowed)`);
            err.code = 'SSRF_BLOCKED';
            throw err;
        }
        if (currentUrl.username || currentUrl.password) {
            const err = new Error('outbound: URL userinfo credentials are not allowed');
            err.code = 'SSRF_BLOCKED';
            throw err;
        }

        const pinned = await assertPublicHost(currentUrl.hostname, {
            allowLoopback,
            trustedPeers,
            lookupFn,
        });

        const res = await pinnedHttpRequest(currentUrl, {
            method: currentMethod,
            headers: currentHeaders,
            body: reqBody,
            timeoutMs: effectiveTimeout,
            maxBodyBytes: effectiveMaxBody,
            pinnedAddress: pinned.address,
            pinnedFamily: pinned.family,
        });

        if (REDIRECT_STATUSES.has(res.status) && res.headers.location) {
            if (!followRedirects) {
                break;
            }
            if (redirectsFollowed >= redirectLimit) {
                const err = new Error(`outbound: exceeded maximum redirects (${redirectLimit})`);
                err.code = 'ERR_OUTBOUND_TOO_MANY_REDIRECTS';
                throw err;
            }
            const nextUrl = new URL(res.headers.location, currentUrl);
            // Strip sensitive headers when crossing origins on redirect
            if (nextUrl.origin !== currentUrl.origin) {
                delete currentHeaders.authorization;
                delete currentHeaders.Authorization;
                delete currentHeaders.cookie;
                delete currentHeaders.Cookie;
            }
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
                currentMethod = 'GET';
                reqBody = undefined;
                delete currentHeaders['content-length'];
                delete currentHeaders['Content-Length'];
                delete currentHeaders['content-type'];
                delete currentHeaders['Content-Type'];
            }
            currentUrl = nextUrl;
            redirectsFollowed += 1;
            continue;
        }

        let json = null;
        try { json = JSON.parse(res.rawText); } catch (_) { }

        return {
            status: res.status,
            ok: res.ok,
            headers: res.headers,
            body: json !== null ? json : res.rawText,
            rawText: res.rawText,
            rawBuffer: res.rawBuffer,
            url: currentUrl.toString(),
            redirects: redirectsFollowed,
            pinnedAddress: pinned.address,
        };
    }
}

module.exports = {
    outboundRequest,
    assertPublicHost,
    isPrivateOrReservedIp,
    isForbiddenHostname,
    isTrustedPeer,
    parseTrustedPeers,
    pinnedHttpRequest,
    MAX_BODY_BYTES,
    MAX_TIMEOUT_MS,
    DEFAULT_MAX_REDIRECTS,
};
