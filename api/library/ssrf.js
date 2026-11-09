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

function normalizeHostname(hostname) {
    return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLoopbackHost(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === '::1' || /^(?:0+:){7}0*1$/i.test(h)) return true;
    const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    const v4 = v4Mapped ? v4Mapped[1] : h;
    return /^127\./.test(v4);
}

function isInternalOrReservedHost(hostname, { allowLoopback = false } = {}) {
    const h = normalizeHostname(hostname);
    if (!h) return true;
    if (allowLoopback && isLoopbackHost(h)) return false;

    if (
        h === 'localhost' ||
        h.endsWith('.localhost') ||
        h === 'metadata.google.internal' ||
        h.endsWith('.internal')
    ) {
        return true;
    }

    if (
        h === '::1' ||
        h === '::' ||
        /^(?:0+:){7}0*[01]$/i.test(h) ||
        /^fe[89ab][0-9a-f]:/i.test(h) ||
        /^f[cd][0-9a-f]{2}:/i.test(h) ||
        /^ff[0-9a-f]{2}:/i.test(h)
    ) {
        return true;
    }

    const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) {
        return isInternalOrReservedHost(v4Mapped[1], { allowLoopback });
    }
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(h)) {
        return true;
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
