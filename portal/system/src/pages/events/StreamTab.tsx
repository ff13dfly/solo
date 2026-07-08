import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { useLang } from '../../providers/LanguageProvider';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../utils/format';
import type { BusStream, BusEntry } from './types';

export default function StreamTab() {
  const { t } = useLang();
  const [streams, setStreams] = useState<BusStream[]>([]);
  const [selected, setSelected] = useState('');
  const [entries, setEntries] = useState<BusEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawEntry, setRawEntry] = useState<BusEntry | null>(null);

  const fetchStreams = useCallback(async () => {
    setError(null);
    try {
      const r = await callRpc<{ items: BusStream[] }>('nexus.event.streams', {});
      const items = r?.items || [];
      setStreams(items);
      // Auto-select the most recently active stream on first load.
      setSelected(prev => prev || items[0]?.key || '');
    } catch (err: any) {
      setError(err.message || t('event_mgmt.streams_list_failed'));
    }
  }, [t]);

  const fetchEntries = useCallback(async (stream: string) => {
    if (!stream) { setEntries([]); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await callRpc<{ entries: BusEntry[] }>('nexus.event.recent', { stream, count: 50 });
      setEntries(r?.entries || []);
    } catch (err: any) {
      setError(err.message || t('event_mgmt.stream_read_failed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { fetchStreams(); }, [fetchStreams]);
  useEffect(() => { fetchEntries(selected); }, [selected, fetchEntries]);

  const payloadPreview = (e: BusEntry): string => {
    const { id: _i, at: _a, type: _t, source: _s, actor: _ac, trace_id: _tr, event_id: _e, emitted_at: _em, ...rest } = e as any;
    const body = (rest as any).payload !== undefined ? (rest as any).payload : rest;
    try { return typeof body === 'string' ? body : JSON.stringify(body); } catch { return String(body); }
  };

  return (
    <>
      {/* Toolbar: stream selector + refresh */}
      <div className="flex justify-between items-center gap-3 px-4 py-2 border-b border-border bg-white/[0.01] shrink-0">
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          data-test="stream-select"
          className="bg-bg-primary border border-border rounded-md px-2 py-1 text-[12px] font-mono text-text-primary outline-none focus:border-accent transition-colors max-w-[60%]"
        >
          {streams.length === 0 && <option value="">{t('event_mgmt.no_streams_option')}</option>}
          {streams.map(s => (
            <option key={s.key} value={s.key}>{s.key} · {s.length}</option>
          ))}
        </select>
        <button
          onClick={() => { fetchStreams(); fetchEntries(selected); }}
          disabled={loading}
          data-test="stream-refresh"
          className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
        >
          {t('event_mgmt.refresh')}
        </button>
      </div>

      {error && <div className="p-4 text-error text-[13px]">{t('event_mgmt.error_prefix')}: {error}</div>}

      {/* Column headers */}
      <div className="grid px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10"
        style={{ gridTemplateColumns: '1.6fr 1.8fr 1.2fr 1.4fr 3fr 0.8fr' }}>
        <div>{t('event_mgmt.col_time')}</div>
        <div>{t('event_mgmt.col_type')}</div>
        <div>{t('event_mgmt.col_source')}</div>
        <div>{t('event_mgmt.col_actor')}</div>
        <div>{t('event_mgmt.col_payload')}</div>
        <div>{t('event_mgmt.col_actions')}</div>
      </div>

      <div className="flex-1 overflow-y-auto" data-test="stream-entries">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('event_mgmt.loading')}</div>}

        {entries.map(e => (
          <div
            key={e.id}
            data-test="stream-entry"
            className="grid px-5 border-b border-border hover:bg-white/[0.02] items-center transition-colors min-h-[44px] py-1.5"
            style={{ gridTemplateColumns: '1.6fr 1.8fr 1.2fr 1.4fr 3fr 0.8fr' }}
          >
            <div className="flex flex-col">
              <span className="text-[11px]">{e.at ? formatDate(e.at) : '—'}</span>
              <span className="font-mono text-[9px] text-text-secondary/60">{e.id}</span>
            </div>
            <div className="font-mono text-[11px] text-accent truncate" title={e.type}>{e.type || '—'}</div>
            <div className="font-mono text-[11px] text-text-secondary truncate">{e.source || '—'}</div>
            <div className="font-mono text-[11px] text-text-secondary truncate" title={e.actor}>{e.actor || '—'}</div>
            <div className="font-mono text-[10px] text-text-secondary truncate" title={payloadPreview(e)}>
              {payloadPreview(e)}
            </div>
            <div>
              <button
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                onClick={() => setRawEntry(e)}
              >
                {t('event_mgmt.raw')}
              </button>
            </div>
          </div>
        ))}

        {!loading && entries.length === 0 && (
          <div className="p-6 text-center opacity-50 text-[13px]">
            {selected ? t('event_mgmt.stream_empty') : t('event_mgmt.no_stream_selected')}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex items-center gap-4 shrink-0">
        <span className="text-xs text-text-secondary">{t('event_mgmt.entries_footer', { n: entries.length })}</span>
        {selected && <span className="text-xs font-mono text-text-secondary/60 truncate">{selected}</span>}
      </div>

      {/* RAW Modal */}
      <Modal
        isOpen={!!rawEntry}
        onClose={() => setRawEntry(null)}
        title={t('event_mgmt.modal_raw_event_title', { id: rawEntry?.id || '' })}
        size="lg"
        footer={<Button onClick={() => setRawEntry(null)}>{t('event_mgmt.close')}</Button>}
      >
        <pre className="bg-bg-primary p-4 rounded-md text-xs font-mono overflow-auto border border-border text-text-secondary max-h-[60vh]">
          {rawEntry && JSON.stringify(rawEntry, null, 2)}
        </pre>
      </Modal>
    </>
  );
}
