import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { callRpc } from '../../../utils/rpc';
import { useLang } from '../../../providers/LanguageProvider';
import { IconButton } from '../../../components/ui';

/**
 * InstanceTraceModal — the full execution chain behind ONE fulfillment instance.
 *
 * A fulfillment instance doesn't carry a single trace id; each transition in its `history`
 * stamps the `trace` of the causal chain that drove it (null for direct/un-traced calls).
 * This modal collects those distinct trace ids and stitches their complete cross-stream chains
 * into one chronological timeline:
 *   - nexus.trace.get(traceId)  → every event across all EVENT:* streams + entity-WAL rows
 *   - orchestrator.run.list     → run docs whose `trace` is one of the instance's traces
 * (Replaces the former standalone /trace page; the entry point now lives where the trace ids do.)
 */

interface RunDoc {
  id: string; workflowId?: string; status?: string; trace?: string | null;
  triggerSource?: string; enqueuedAt?: number; startedAt?: number;
  failedStep?: string | null; lastError?: string | null;
  cleanupManifest?: unknown[] | null; missingMethods?: string[];
  [k: string]: unknown;
}
interface EventEntry {
  id: string; at?: number | string; type?: string; source?: string; actor?: string;
  trace_id?: string; event_id?: string; depth?: string | number; emitted_at?: string | number;
  stream?: string; op?: string; key?: string; payload?: { [k: string]: unknown };
  [k: string]: unknown;
}
type TraceNode =
  | { key: string; kind: 'event'; ts: number; stream: string; raw: EventEntry }
  | { key: string; kind: 'run'; ts: number; raw: RunDoc };

const eventTs = (e: EventEntry): number => {
  const em = Number(e.emitted_at);
  if (Number.isFinite(em) && em > 0) return em;
  const idMs = parseInt(String(e.id).split('-')[0], 10); // redis stream id = "<ms>-<seq>"
  return Number.isFinite(idMs) ? idMs : 0;
};
const runTs = (r: RunDoc): number => r.startedAt || r.enqueuedAt || 0;
const fmt = (ms: number): string => (ms ? new Date(ms).toLocaleString() : '—');

const STATUS_COLOR: Record<string, string> = {
  DONE: '#16a34a', RUNNING: '#2563eb', RESUMING: '#2563eb',
  FAILED: '#dc2626', DEADLETTER: '#dc2626',
  STALLED: '#d97706', PAUSED_AWAITING_HUMAN: '#d97706', ABORTED: '#6b7280',
};
const statusColor = (s?: string): string => (s && STATUS_COLOR[s]) || 'var(--text-secondary, #6b7280)';

const ENVELOPE_KEYS = new Set(['id', 'at', 'type', 'source', 'actor', 'trace_id', 'event_id', 'parent_event_id', 'depth', 'emitted_at']);
const payloadPreview = (e: EventEntry): string => {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!ENVELOPE_KEYS.has(k)) rest[k] = v;
  const s = JSON.stringify(rest);
  return s && s !== '{}' ? s : '';
};

export function InstanceTraceModal({ instance, onClose }: { instance: any; onClose: () => void }) {
  const { t } = useLang();
  const tt = (k: string, d: string, p?: Record<string, string | number>) => t(`trace.${k}`, { defaultValue: d, ...(p || {}) });

  const [nodes, setNodes] = useState<TraceNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The instance's distinct causal-chain ids, in first-seen order.
  const traceIds = useMemo<string[]>(() => {
    const hist: any[] = Array.isArray(instance?.history) ? instance.history : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const h of hist) {
      const tr = h?.trace;
      if (tr && !seen.has(tr)) { seen.add(tr); out.push(tr); }
    }
    return out;
  }, [instance]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null); setTruncated(false);
      try {
        if (traceIds.length === 0) { if (alive) setNodes([]); return; }
        const traceSet = new Set(traceIds);

        // Runs whose chain is one of this instance's traces.
        const runs = await callRpc<RunDoc[]>('orchestrator.run.list', {});
        const runNodes: TraceNode[] = (runs || [])
          .filter(r => r.trace && traceSet.has(r.trace))
          .map(r => ({ key: `run:${r.id}`, kind: 'run', ts: runTs(r), raw: r }));

        // Events + entity-WAL rows for each trace (server-side complete reconstruction).
        const eventNodes: TraceNode[] = [];
        const seen = new Set<string>();
        let scannedMax = 0;
        let trunc = false;
        for (const tid of traceIds) {
          const resp = await callRpc<{ events: EventEntry[]; streamsScanned: number; truncated: boolean }>('nexus.trace.get', { traceId: tid });
          scannedMax = Math.max(scannedMax, resp.streamsScanned || 0);
          if (resp.truncated) trunc = true;
          for (const e of (resp.events || [])) {
            const key = `evt:${e.stream || ''}:${e.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            eventNodes.push({ key, kind: 'event', ts: eventTs(e), stream: e.stream || '—', raw: e });
          }
        }

        const merged = [...runNodes, ...eventNodes].sort((a, b) => a.ts - b.ts);
        if (alive) { setNodes(merged); setScanned(scannedMax); setTruncated(trunc); }
      } catch (e) {
        if (alive) { setError(e instanceof Error ? e.message : String(e)); setNodes([]); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [traceIds]);

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const span = nodes.length ? `${fmt(nodes[0].ts)} → ${fmt(nodes[nodes.length - 1].ts)}` : '—';
  const eventCount = nodes.filter(n => n.kind === 'event').length;
  const runCount = nodes.filter(n => n.kind === 'run').length;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, width: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 700, color: '#1e293b' }}>{tt('title', 'Execution Trace')}</span>
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent-color, #2563eb)' }}>{instance?.id}</span>
          {instance?.state && <span style={{ fontSize: 11, color: '#64748b' }}>· {instance.state}</span>}
          <IconButton variant="ghost" onClick={onClose} style={{ marginLeft: 'auto', fontSize: 18 }}>×</IconButton>
        </div>

        {/* Summary / warnings */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
          {tt('summary', '{traces} traces · {events} events · {runs} runs · scanned {streams} streams · {span}',
            { traces: traceIds.length, events: eventCount, runs: runCount, streams: scanned, span })}
        </div>
        {truncated && (
          <div style={{ padding: '8px 20px', fontSize: 12, color: '#b45309', background: '#fffbeb', borderBottom: '1px solid #fde68a' }}>
            ⚠️ {tt('truncated', 'A stream exceeded the server-side scan budget — this trace may be partial.')}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>{tt('loading', 'Stitching…')}</div>
          ) : error ? (
            <div style={{ fontSize: 13, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px' }}>{error}</div>
          ) : traceIds.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>
              {tt('no_instance_trace', 'This instance has no traced transitions — it was created/changed by direct (un-traced) calls.')}
            </div>
          ) : nodes.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>
              {tt('empty', 'No runs or events found for this trace.')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, position: 'relative' }}>
              {nodes.map(n => {
                const open = expanded.has(n.key);
                const isWal = n.kind === 'event' && (n.raw as EventEntry).stream === 'WAL:STREAM';
                const color = n.kind === 'run' ? statusColor((n.raw as RunDoc).status) : isWal ? '#b45309' : 'var(--accent-color, #2563eb)';
                return (
                  <div key={n.key} style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
                    {/* rail */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 12, background: color, marginTop: 14, flexShrink: 0, border: '2px solid #fff' }} />
                      <span style={{ flex: 1, width: 2, background: 'var(--border-color, #e5e7eb)' }} />
                    </div>
                    {/* card */}
                    <div style={{ flex: 1, marginBottom: 10, border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
                      <button onClick={() => toggle(n.key)} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none', padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 5px' }}>
                            {n.kind === 'run' ? 'RUN' : isWal ? 'WAL' : 'EVENT'}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', fontFamily: 'monospace' }}>{fmt(n.ts)}</span>
                          {n.kind === 'event'
                            ? <span style={{ fontFamily: 'monospace', fontSize: 12, color: isWal ? '#b45309' : 'var(--accent-color, #2563eb)' }}>
                                {isWal ? `${String((n.raw as EventEntry).op || '?')} ${String((n.raw as EventEntry).key || '')}` : (n.raw.type || '—')}
                              </span>
                            : <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-primary, #111827)' }}>{(n.raw as RunDoc).workflowId || n.raw.id}</span>}
                          {n.kind === 'run' && <span style={{ fontSize: 11, color: statusColor((n.raw as RunDoc).status) }}>{(n.raw as RunDoc).status}</span>}
                        </div>
                        {n.kind === 'event' ? (
                          <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <span>{n.stream}</span>
                            {n.raw.actor && <span>actor={n.raw.actor}</span>}
                            {n.raw.depth !== undefined && <span>depth={String(n.raw.depth)}</span>}
                            {payloadPreview(n.raw) && <span style={{ fontFamily: 'monospace', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{payloadPreview(n.raw)}</span>}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            {(n.raw as RunDoc).triggerSource && <span>via {(n.raw as RunDoc).triggerSource}</span>}
                            {(n.raw as RunDoc).failedStep && <span style={{ color: '#dc2626' }}>step={(n.raw as RunDoc).failedStep}</span>}
                            {(n.raw as RunDoc).lastError && <span style={{ color: '#dc2626', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String((n.raw as RunDoc).lastError)}</span>}
                            {Array.isArray((n.raw as RunDoc).cleanupManifest) && (n.raw as RunDoc).cleanupManifest!.length > 0 && <span style={{ color: '#d97706' }}>cleanup×{(n.raw as RunDoc).cleanupManifest!.length}</span>}
                            {(n.raw as RunDoc).missingMethods && (n.raw as RunDoc).missingMethods!.length > 0 && <span style={{ color: '#d97706' }}>needs-grant: {(n.raw as RunDoc).missingMethods!.join(', ')}</span>}
                          </div>
                        )}
                      </button>
                      {open && (
                        <pre style={{ margin: 0, padding: '10px 12px', borderTop: '1px solid var(--border-color, #e5e7eb)', background: 'var(--bg-color, #f9fafb)', fontSize: 11, lineHeight: 1.5, overflowX: 'auto', color: 'var(--text-primary, #111827)' }}>
                          {JSON.stringify(n.raw, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
