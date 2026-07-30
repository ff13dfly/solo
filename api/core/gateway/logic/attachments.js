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
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;   // total across all attachments
const DEFAULT_MAX_COUNT = 10;

async function downloadCapped(url, remainingBytes) {
    const res = await fetch(url);
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
async function fetchAttachments(relay, items, { maxBytes = DEFAULT_MAX_BYTES, maxCount = DEFAULT_MAX_COUNT } = {}) {
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
        // so Router checkAccess + storage's own visibility rules apply to THIS caller's
        // deployment-granted permit, not to the original uploader.
        const meta = await relay.call('storage.asset.get', { id: assetId });
        const { url } = await relay.call('storage.asset.resolve', { id: assetId });
        if (!url) throw new Error(`storage.asset.resolve(${assetId}) returned no url`);

        const content = await downloadCapped(url, budget);
        budget -= content.length;
        out.push({
            filename: filename || (meta && meta.filename) || assetId,
            contentType: (meta && meta.mimeType) || 'application/octet-stream',
            content,
        });
    }
    return out;
}

module.exports = { fetchAttachments, DEFAULT_MAX_BYTES, DEFAULT_MAX_COUNT };
