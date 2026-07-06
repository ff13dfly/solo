const fs = require('fs');
const path = require('path');
const clock = require('../../../library/clock');
const { redactSensitive } = require('../../../library/logger');

/**
 * Run execution trace log — daily-partitioned JSONL, mirrors ingress/logic/audit.js.
 *
 * toFix.md ("无版本化/不可变快照/执行轨迹持久化"): runner.js:run() builds a full
 * per-step trace (id/service/method/params/result/status/timing) and returns it,
 * but nothing durable ever kept it — worker.js only persists failedStep/error/
 * cleanup_manifest onto the run entity; a DONE run leaves zero step-level record.
 * This closes that gap the same way ingress closes its own — a file, not the
 * RedisJSON run entity (a full trace per run would bloat that document the same
 * way oversized WAL snapshots did before storage-CAS was on the table).
 *
 *   {LOG_DIR}/orchestrator-trace/{YYYY}/{YYYY-MM-DD}.jsonl
 *
 * UNLIKE ingress's audit log (metadata only, explicitly not the body — the body
 * already survives elsewhere), the whole point here IS the step params/results —
 * so every record is redacted (library/logger.js redactSensitive) before it ever
 * touches disk, not left to the caller to remember.
 */
const LOG_ROOT = process.env.LOG_DIR || path.join(__dirname, '../../../../logs');

function fileFor(ts) {
    const d = new Date(ts);
    const year = String(d.getUTCFullYear());
    const day = d.toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
    return { dir: path.join(LOG_ROOT, 'orchestrator-trace', year), file: path.join(LOG_ROOT, 'orchestrator-trace', year, `${day}.jsonl`) };
}

function append(record) {
    const ts = record.ts || clock.now();
    const { dir, file } = fileFor(ts);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const safe = { ...record, trace: redactSensitive(record.trace) };
        fs.appendFileSync(file, JSON.stringify({ ts, ...safe }) + '\n');
    } catch (e) {
        // Best-effort: a trace-write failure must never break run execution.
        console.error('[orchestrator:trace-audit] write failed:', e.message);
    }
    return file;
}

// Read the most recent run traces, newest-first, scanning back over the last
// `days` daily files. Optional filters by runId / workflowId. Admin only.
function recent({ limit = 100, runId, workflowId, days = 2 } = {}) {
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
            if (runId && rec.runId !== runId) continue;
            if (workflowId && rec.workflowId !== workflowId) continue;
            items.push(rec);
        }
    }
    return { items, total: items.length };
}

module.exports = () => ({ append, recent });
