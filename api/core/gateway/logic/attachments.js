/**
 * Email attachments — storage references only (gateway-gaps G13).
 *
 * @why  Callers pass `attachments: [{ assetId, filename? }]`, never raw base64: a 20MB
 *       inline payload would ride through the Router (and its audit trail) on every
 *       retry. Gateway resolves each assetId via its own relay bot (system.gateway,
 *       permit: storage.asset.get/resolve), downloads the bytes with a hard size cap,
 *       and hands Buffers to the provider layer.
 *
 * @attention Requires RELAY:TOKEN:gateway (seeded from deploy/bot-permits.js). Without
 *       it, email.send with attachments fails with a -32602 naming the missing bot —
 *       permanent to the notification worker, so no retry storm against a deployment
 *       that simply hasn't provisioned the bot.
 */
const { isInternalOrReservedHost: sharedIsInternalOrReservedHost, assertPublicHostname } = require('../../../library/ssrf');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;   // total across all attachments
const DEFAULT_MAX_COUNT = 10;

function isBlockedAttachmentHost(hostname, { allowLoopback = true } = {}) {
    if (!hostname || typeof hostname !== 'string') return true;
    let h = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!h) return true;
    const mappedHex = h.match(/^(?:::ffff:|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        h = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    } else {
        const mappedDot = h.match(/^(?:::ffff:|(?:0+:){5}ffff:)(\d+\.\d+\.\d+\.\d+)$/);
        if (mappedDot) h = mappedDot[1];
    }
    return sharedIsInternalOrReservedHost(h, { allowLoopback });
}

function canCallerReadAsset(meta, callerCtx) {
    if (!callerCtx || !meta) return true;
    const isScopedExternal = Boolean(callerCtx.owner && callerCtx.owner.value !== undefined && callerCtx.owner.value !== null);
    if (callerCtx.permit === 'admin' && !isScopedExternal) return true;
    if (typeof callerCtx.user === 'string' && callerCtx.user.startsWith('system.') && !isScopedExternal) return true;
    const vis = meta.visibility || 'internal';
    if (vis === 'public') return true;
    const effectiveUser = isScopedExternal ? String(callerCtx.owner.value) : (callerCtx.user || null);
    if (vis === 'internal') {
        if (isScopedExternal) return Boolean(effectiveUser && meta.owner && effectiveUser === meta.owner);
        return Boolean(effectiveUser);
    }
    return Boolean(effectiveUser && meta.owner && effectiveUser === meta.owner);
}

async function downloadCapped(url, remainingBytes, { isExternal = false } = {}) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_) {
        throw new Error(`attachment download refused: invalid url "${url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`attachment download refused: unsupported protocol "${parsed.protocol}"`);
    }
    const allowLoopback = !isExternal || process.env.GATEWAY_ALLOW_LOCAL_ATTACHMENTS === '1';
    if (isBlockedAttachmentHost(parsed.hostname, { allowLoopback })) {
        throw new Error(`attachment download refused: internal/metadata host "${parsed.hostname}" is not allowed`);
    }
    try {
        await assertPublicHostname(parsed.hostname, { allowLoopback });
    } catch (e) {
        if (e && e.code === 'SSRF_BLOCKED') {
            throw new Error(`attachment download refused: internal/metadata host "${parsed.hostname}" is not allowed (${e.message})`);
        }
        throw e;
    }
    const res = await fetch(url, { redirect: 'error' });
    if (!res.ok) throw new Error(`attachment download failed: HTTP ${res.status}`);

    // Fast reject on a declared size before pulling a single byte.
    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared > remainingBytes) {
        throw new Error(`attachment exceeds size budget (${declared} > ${remainingBytes} bytes left)`);
    }

    // Stream with a running cap — content-length is advisory, not a guarantee.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > remainingBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`attachment exceeds size budget (${remainingBytes} bytes left)`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
}

/**
 * @param relay   gateway's relay (system.gateway bot)
 * @param items   [{ assetId, filename? }]
 * @param opts    { maxBytes?, maxCount? }
 * @returns [{ filename, contentType, content:Buffer }]
 */
async function fetchAttachments(relay, items, { maxBytes = DEFAULT_MAX_BYTES, maxCount = DEFAULT_MAX_COUNT, callerCtx = null } = {}) {
    if (items.length > maxCount) {
        throw new Error(`too many attachments (${items.length} > ${maxCount})`);
    }

    const out = [];
    let budget = maxBytes;
    for (const item of items) {
        const { assetId, filename } = item || {};
        if (!assetId || typeof assetId !== 'string') {
            throw new Error(`attachments[] items must be { assetId, filename? } (storage references — raw base64 is not accepted)`);
        }
        // Metadata first (filename/mimeType), then the byte URL. Both via the relay bot,
        // PLUS callerCtx visibility/ownership enforcement so a caller cannot attach
        // another user/tenant's private or scoped-internal asset via system.gateway.
        const meta = await relay.call('storage.asset.get', { id: assetId });
        if (meta && !canCallerReadAsset(meta, callerCtx)) {
            throw new Error(`No access to attachment asset ${assetId} (visibility: ${meta.visibility || 'internal'})`);
        }
        const { url } = await relay.call('storage.asset.resolve', { id: assetId });
        if (!url) throw new Error(`storage.asset.resolve(${assetId}) returned no url`);

        const isExternal = Boolean(meta && meta.kind === 'external');
        const content = await downloadCapped(url, budget, { isExternal });
        budget -= content.length;
        out.push({
            filename: filename || (meta && (meta.filename || meta.originalName)) || assetId,
            contentType: (meta && meta.mimeType) || 'application/octet-stream',
            content,
        });
    }
    return out;
}

module.exports = { fetchAttachments, DEFAULT_MAX_BYTES, DEFAULT_MAX_COUNT };
