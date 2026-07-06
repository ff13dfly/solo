const fs = require('fs');
const path = require('path');
const clock = require('../../../library/clock');

/**
 * Ingress delivery audit log — daily append, mirroring SOLO's WAL layout.
 *
 * SOLO's WAL index already partitions by year/day (logs/wal/{year}/{date}.index,
 * see library/logger.js); this writes the inbound-delivery audit alongside it at
 *   {LOG_DIR}/ingress/{YYYY}/{YYYY-MM-DD}.jsonl
 * one JSON object per line (greppable + machine-parseable).
 *
 * Metadata only by default — NOT the body. Webhook payloads can carry sensitive
 * data, and the body already survives via the EVENT:WEBHOOK:* stream + downstream
 * processing. The raw original request is archived at the LISTENER, keyed by
 * sha256(request_id) (see deploy/mock/listener.js). Reverse-trace correlates all
 * three layers via request_id.
 */
const LOG_ROOT = process.env.LOG_DIR || path.join(__dirname, '../../../../logs');

function fileFor(ts) {
    const d = new Date(ts);
    const year = String(d.getUTCFullYear());
    const day = d.toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
    return { dir: path.join(LOG_ROOT, 'ingress', year), file: path.join(LOG_ROOT, 'ingress', year, `${day}.jsonl`) };
}

function append(record) {
    const ts = record.ts || clock.now();
    const { dir, file } = fileFor(ts);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, JSON.stringify({ ts, ...record }) + '\n');
    } catch (e) {
        // Best-effort: an audit-write failure must never break ingestion.
        console.error('[ingress:audit] write failed:', e.message);
    }
    return file;
}

// Read the most recent delivery entries, newest-first, scanning back over the
// last `days` daily files. Optional filters by source / outcome. Admin only.
function recent({ limit = 100, source, outcome, days = 2 } = {}) {
    const cap = Math.min(Math.max(1, limit | 0), 1000);
    const back = Math.min(Math.max(1, days | 0), 31);
    const nowMs = clock.now();
    const items = [];

    for (let d = 0; d < back && items.length < cap; d++) {
        const { file } = fileFor(nowMs - d * 86400000);
        if (!fs.existsSync(file)) continue;
        let lines;
        try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
        catch { continue; }
        for (let i = lines.length - 1; i >= 0 && items.length < cap; i--) {
            const ln = lines[i];
            if (!ln) continue;
            let rec;
            try { rec = JSON.parse(ln); } catch { continue; }
            if (source && rec.source !== source) continue;
            if (outcome && rec.outcome !== outcome) continue;
            items.push(rec);
        }
    }
    return { items, total: items.length };
}

module.exports = () => ({ append, recent });
