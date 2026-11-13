/**
 * Shared SSRF / Private-Address Denylist Helper
 *
 * Centralizes hostname / IP inspection across `apps/storage`, `core/gateway`
 * (webhook, email attachments, IMAP), and any outbound fetch/socket client.
 *
 * Blocks:
 *   - Loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0:0:...:1`)
 *   - Unspecified (`0.0.0.0/8`, `::`, `0:0:...:0`)
 *   - RFC1918 private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
 *   - Link-local & cloud metadata (`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`)
 *   - CGNAT / Tailscale / Alibaba Cloud ECS metadata (`100.64.0.0/10`, incl. `100.100.100.200`)
 *   - Benchmark (`198.18.0.0/15`) and Multicast/Reserved (`224.0.0.0/4`, `ff00::/8`)
 *   - Unique-local IPv6 (`fc00::/7`) and IPv4-mapped IPv6 (`::ffff:...`)
 */

const dns = require('dns');

const REBINDING_HOST_RE = [
    /^localhost$/i,
    /\.localhost$/i,
    /\.local$/i,
    /\.internal$/i,
    /(^|\.)metadata\.google\.internal\.?$/i,
    /\.(nip|sslip|xip)\.io$/i,
    /(^|\.)(localtest\.me|lvh\.me)$/i,
];

function normalizeHostname(hostname) {
    return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * Parse an IPv6 literal into 8 16-bit words (0..65535), or return null if not a valid IPv6 literal.
 * Handles `::` zero-compression and trailing dotted-quad IPv4 (`::ffff:127.0.0.1`, `64:ff9b::10.0.0.1`).
 */
function parseIpv6Words(host) {
    if (!host || typeof host !== 'string' || !host.includes(':')) return null;
    const clean = host.split('%')[0]; // strip zone index if any
    let working = clean;

    const lastColon = working.lastIndexOf(':');
    const tail = working.slice(lastColon + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
        const octets = tail.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        const hi = ((octets[0] << 8) | octets[1]).toString(16);
        const lo = ((octets[2] << 8) | octets[3]).toString(16);
        working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
    }

    const dblParts = working.split('::');
    if (dblParts.length > 2) return null;

    const parseGroup = (part) => {
        if (!part) return [];
        const tokens = part.split(':');
        const nums = [];
        for (const t of tokens) {
            if (!/^[0-9a-f]{1,4}$/i.test(t)) return null;
            nums.push(parseInt(t, 16));
        }
        return nums;
    };

    if (dblParts.length === 2) {
        const left = parseGroup(dblParts[0]);
        const right = parseGroup(dblParts[1]);
        if (!left || !right) return null;
        const missing = 8 - (left.length + right.length);
        if (missing < 1) return null;
        return [...left, ...new Array(missing).fill(0), ...right];
    }

    const full = parseGroup(working);
    if (!full || full.length !== 8) return null;
    return full;
}

function wordsToIpv4(hiWord, loWord) {
    return `${(hiWord >> 8) & 0xff}.${hiWord & 0xff}.${(loWord >> 8) & 0xff}.${loWord & 0xff}`;
}

function isLoopbackHost(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    const v6 = parseIpv6Words(h);
    if (v6) {
        const isZero0to5 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
        if (isZero0to5 && v6[5] === 0 && v6[6] === 0 && v6[7] === 1) return true;
        if (isZero0to5 && (v6[5] === 0xffff || v6[5] === 0)) {
            const embeddedV4 = wordsToIpv4(v6[6], v6[7]);
            return /^127\./.test(embeddedV4);
        }
        return false;
    }
    return /^127\./.test(h);
}

function isInternalOrReservedHost(hostname, { allowLoopback = false } = {}) {
    const h = normalizeHostname(hostname);
    if (!h) return true;
    if (allowLoopback && isLoopbackHost(h)) return false;

    if (REBINDING_HOST_RE.some((re) => re.test(h))) {
        return true;
    }

    const v6 = parseIpv6Words(h);
    if (v6) {
        const isZero0to4 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
        // Unspecified (::) or Loopback (::1)
        if (isZero0to4 && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) {
            return true;
        }
        // IPv4-mapped (::ffff:w6:w7) or IPv4-compatible (::w6:w7)
        if (isZero0to4 && (v6[5] === 0xffff || v6[5] === 0)) {
            const embeddedV4 = wordsToIpv4(v6[6], v6[7]);
            if (v6[5] === 0) return true; // RFC 4291 deprecated IPv4-compatible IPv6 is always reserved
            return isInternalOrReservedHost(embeddedV4, { allowLoopback });
        }
        // NAT64 well-known prefix (64:ff9b::/96 or 64:ff9b:1::/48)
        if (v6[0] === 0x0064 && v6[1] === 0xff9b) {
            return true;
        }
        // 6to4 (2002::/16) — embeds IPv4 in v6[1], v6[2]
        if (v6[0] === 0x2002) {
            const embedded6to4 = wordsToIpv4(v6[1], v6[2]);
            if (isInternalOrReservedHost(embedded6to4, { allowLoopback })) return true;
            return true; // 6to4 relay anycast / tunneling blocked by default
        }
        // Teredo (2001:0000::/32) or Documentation (2001:db8::/32)
        if (v6[0] === 0x2001 && (v6[1] === 0x0000 || v6[1] === 0x0db8)) {
            return true;
        }
        // Link-local (fe80::/10), Unique-Local (fc00::/7), Multicast (ff00::/8)
        if (
            (v6[0] & 0xffc0) === 0xfe80 ||
            (v6[0] & 0xfe00) === 0xfc00 ||
            (v6[0] & 0xff00) === 0xff00
        ) {
            return true;
        }
        return false;
    }

    if (
        /^127\./.test(h) ||
        /^0\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^169\.254\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
        /^198\.1[89]\./.test(h) ||
        /^(22[4-9]|23\d|24\d|25[0-5])\./.test(h)
    ) {
        return true;
    }

    return false;
}

/**
 * Resolve hostname via DNS (if not an IP literal) and verify both the literal
 * and all resolved addresses are public (or loopback when `allowLoopback: true`).
 */
async function assertPublicHostname(hostname, { allowLoopback = false, lookupFn = dns.promises.lookup } = {}) {
    const h = normalizeHostname(hostname);
    if (isInternalOrReservedHost(h, { allowLoopback })) {
        const err = new Error(`Target host "${hostname}" is internal or reserved`);
        err.code = 'SSRF_BLOCKED';
        throw err;
    }
    // Skip DNS lookup if already an IPv4 literal
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return;
    if (typeof lookupFn === 'function') {
        let records;
        try {
            records = await lookupFn(h, { all: true });
        } catch (e) {
            // If DNS fails in offline/unit-test environments where lookup isn't mocked,
            // allow only if ENOTFOUND/EAI_AGAIN is handled by the caller, or rethrow.
            throw e;
        }
        const list = Array.isArray(records) ? records : (records ? [records] : []);
        for (const rec of list) {
            const addr = typeof rec === 'string' ? rec : rec?.address;
            if (addr && isInternalOrReservedHost(addr, { allowLoopback })) {
                const err = new Error(`Target host "${hostname}" resolved to internal/reserved IP "${addr}"`);
                err.code = 'SSRF_BLOCKED';
                throw err;
            }
        }
    }
}

module.exports = {
    normalizeHostname,
    isLoopbackHost,
    isInternalOrReservedHost,
    assertPublicHostname
};
