import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import { useLang } from '../providers/LanguageProvider';
import { formatDate } from '../utils/format';

/**
 * NexusStreamCatalog — the producer → stream → consumer map of the event bus.
 *
 * Stream keys are otherwise stringly-typed and scattered: a Sentinel's
 * eventSubscriptions (consumer) and context.emit.stream (producer), a Schedule's
 * emit_event action (producer), plus whatever is live on the bus. This view
 * aggregates all of them client-side into one graph so the nexus logic is legible:
 * for each EVENT:* stream you see who emits to it and who reacts.
 *
 * Read-only. Producers can ALSO be fulfillment transitions / ingress webhooks /
 * manual broadcasts — those live in other services, so a stream with consumers but
 * no nexus-side producer is flagged softly (it may still be fed externally).
 */

interface CatSentinel {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  eventSubscriptions?: string[];
  context?: { emit?: { stream?: string } | null } | null;
}
interface CatSchedule {
  schedule_id: string;
  enabled: boolean;
  action?: { kind: 'run_command' | 'emit_event'; stream?: string };
}
interface CatStream { key: string; length: number; lastAt: number | null }

interface Edge { kind: 'sentinel' | 'schedule'; name: string; disabled: boolean }
interface StreamRow {
  key: string;
  live: { length: number; lastAt: number | null } | null;
  producers: Edge[];
  consumers: Edge[];
}

export default function NexusStreamCatalog() {
  const { t } = useLang();
  const [rows, setRows] = useState<StreamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [streamsR, sentinelR, scheduleR] = await Promise.allSettled([
      callRpc<{ items: CatStream[] }>('nexus.event.streams', {}),
      callRpc<{ items: CatSentinel[] }>('nexus.sentinel.list', { page: 1, pageSize: 200 }),
      callRpc<CatSchedule[]>('nexus.schedule.list', {}),
    ]);
    if (streamsR.status === 'rejected' && sentinelR.status === 'rejected' && scheduleR.status === 'rejected') {
      setError((streamsR.reason as any)?.message || t('nexus_catalog.load_failed') || 'Failed to load');
      setLoading(false);
      return;
    }
    const live = streamsR.status === 'fulfilled' ? (streamsR.value?.items || []) : [];
    const sentinels = sentinelR.status === 'fulfilled' ? (sentinelR.value?.items || []) : [];
    const schedules = scheduleR.status === 'fulfilled' ? (scheduleR.value || []) : [];

    const map = new Map<string, StreamRow>();
    const ensure = (key: string): StreamRow => {
      let r = map.get(key);
      if (!r) { r = { key, live: null, producers: [], consumers: [] }; map.set(key, r); }
      return r;
    };

    for (const s of live) ensure(s.key).live = { length: s.length, lastAt: s.lastAt };
    for (const sen of sentinels) {
      const disabled = sen.status === 'DISABLED';
      for (const sub of sen.eventSubscriptions || []) {
        if (sub) ensure(sub).consumers.push({ kind: 'sentinel', name: sen.name, disabled });
      }
      const emitStream = sen.context?.emit?.stream;
      if (emitStream) ensure(emitStream).producers.push({ kind: 'sentinel', name: sen.name, disabled });
    }
    for (const sc of schedules) {
      if (sc.action?.kind === 'emit_event' && sc.action.stream) {
        ensure(sc.action.stream).producers.push({ kind: 'schedule', name: sc.schedule_id, disabled: !sc.enabled });
      }
    }

    const out = [...map.values()].sort((a, b) =>
      (b.live?.lastAt || 0) - (a.live?.lastAt || 0) || a.key.localeCompare(b.key));
    setRows(out);
    setLoading(false);
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const chip = (e: Edge, i: number) => (
    <span
      key={`${e.kind}-${e.name}-${i}`}
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-mono
        ${e.disabled ? 'border-border text-text-secondary line-through opacity-60' : 'border-accent/40 text-accent'}`}
      title={e.kind}
    >
      <span className="opacity-50">{e.kind === 'sentinel' ? '◆' : '⏱'}</span>{e.name}
    </span>
  );

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-white/[0.01] shrink-0">
        <div>
          <div className="text-sm font-bold text-text-primary">{t('nexus_catalog.title') || 'Stream Catalog'}</div>
          <div className="text-[10px] text-text-secondary mt-0.5 max-w-3xl">
            {t('nexus_catalog.desc') ||
              'Every EVENT:* stream — who emits to it (producers) and who reacts (consumers). Producers may also be fulfillment transitions / ingress / manual broadcasts.'}
          </div>
        </div>
        <button
          onClick={load}
          className="bg-accent-dim border border-accent/40 text-accent px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all shrink-0"
        >
          {t('nexus_catalog.refresh') || 'Refresh'}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {error && <div className="text-error text-xs mb-3">{error}</div>}
        {loading && <div className="text-text-secondary text-xs">…</div>}
        {!loading && rows.length === 0 && (
          <div className="text-text-secondary text-xs">{t('nexus_catalog.empty') || 'No streams or wiring found yet.'}</div>
        )}

        <div className="flex flex-col gap-2">
          {rows.map(r => (
            <div key={r.key} className="border border-border bg-bg-secondary/30 p-3">
              {/* stream key + live badge */}
              <div className="flex items-center justify-between gap-3 mb-2">
                <code className="text-xs text-accent font-mono break-all">{r.key}</code>
                {r.live
                  ? <span className="text-[10px] text-success border border-success/40 px-1.5 py-0.5 shrink-0 font-mono">
                      {t('nexus_catalog.live') || 'live'} · {r.live.length}
                      {r.live.lastAt ? ` · ${formatDate(r.live.lastAt)}` : ''}
                    </span>
                  : <span className="text-[10px] text-text-secondary border border-border px-1.5 py-0.5 shrink-0 font-mono">idle</span>}
              </div>
              {/* producers → consumers */}
              <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-[11px]">
                <div className="text-text-secondary uppercase tracking-wide pt-0.5">{t('nexus_catalog.producers') || 'Producers'}</div>
                <div className="flex flex-wrap gap-1 items-center">
                  {r.producers.length
                    ? r.producers.map(chip)
                    : <span className="text-text-secondary opacity-60 text-[10px]">{t('nexus_catalog.no_producer') || 'no nexus producer (may be fed externally)'}</span>}
                </div>
                <div className="text-text-secondary uppercase tracking-wide pt-0.5">{t('nexus_catalog.consumers') || 'Consumers'}</div>
                <div className="flex flex-wrap gap-1 items-center">
                  {r.consumers.length
                    ? r.consumers.map(chip)
                    : <span className="text-text-secondary opacity-60 text-[10px]">{t('nexus_catalog.no_consumer') || 'no consumer'}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
