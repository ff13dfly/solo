import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { formatDate } from '../utils/format';

type Tab = 'sources' | 'deliveries';

interface Source {
  id: string;
  name: string;
  stream: string;
  enabled: boolean;
  dedupTtlSec: number;
  lastFiredAt: number | null;
  hitCount: number;
  dupCount: number;
  createdAt: number;
  healthUrl?: string | null;
}

interface Delivery {
  ts: number;
  source: string;
  request_id: string | null;
  outcome: 'accepted' | 'duplicate' | 'unauthorized' | 'disabled' | 'invalid';
  status: number;
  bytes: number;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const OUTCOMES = ['', 'accepted', 'duplicate', 'unauthorized', 'disabled', 'invalid'] as const;

function freshnessColor(ts: number | null): string {
  if (!ts) return 'bg-text-secondary/30';
  const age = Date.now() - ts;
  if (age < 60_000)  return 'bg-success';
  if (age < 300_000) return 'bg-warning';
  return 'bg-text-secondary/30';
}

function ttlHuman(s: number): string {
  if (!s) return '—';
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

function outcomeBadge(o: Delivery['outcome']): string {
  const map: Record<Delivery['outcome'], string> = {
    accepted:     'text-success border-success/40 bg-success/10',
    duplicate:    'text-warning border-warning/40 bg-warning/10',
    unauthorized: 'text-error border-error/40 bg-error/10',
    invalid:      'text-error/80 border-error/30 bg-error/5',
    disabled:     'text-text-secondary border-border bg-white/5',
  };
  return `text-[10px] px-1.5 py-0.5 border rounded font-mono ${map[o] || ''}`;
}

// ─── Sources Tab (settings) ───────────────────────────────────────────────────

function SourcesTab() {
  const { toast, confirm } = useUI();
  const { t } = useLang();

  const [sources, setSources] = useState<Source[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const pageSize = 20;

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', dedupTtlSec: '86400' });
  const [creating, setCreating] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [rawSource, setRawSource] = useState<Source | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; apiKey: string; action: string } | null>(null);
  const [fireModal, setFireModal] = useState<Source | null>(null);
  const [firePayload, setFirePayload] = useState('{}');
  const [firePayloadErr, setFirePayloadErr] = useState<string | null>(null);
  const [firing, setFiring] = useState<'fire' | 'send' | null>(null);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callRpc<{ items: Source[]; total: number }>('ingress.source.list', { page, pageSize });
      setSources(result.items || []);
      setTotal(result.total || 0);
    } catch (err: any) {
      setError(err.message || t('ingress_mgmt.err_load_sources'));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { fetchSources(); }, [fetchSources]);

  const handleCreate = async () => {
    if (!NAME_RE.test(form.name.trim())) return toast.error(t('ingress_mgmt.err_name_pattern'));
    setCreating(true);
    try {
      const ttl = form.dedupTtlSec ? Number(form.dedupTtlSec) : undefined;
      const result = await callRpc<{ name: string; apiKey: string }>('ingress.source.create', {
        name: form.name.trim(),
        ...(ttl ? { dedupTtlSec: ttl } : {}),
      });
      setShowCreate(false);
      setForm({ name: '', dedupTtlSec: '86400' });
      setRevealed({ name: result.name, apiKey: result.apiKey, action: 'created' });
      fetchSources();
    } catch (err: any) {
      toast.error(err.message || t('ingress_mgmt.err_create_failed'));
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (s: Source) => {
    setBusy(s.id);
    try {
      await callRpc(`ingress.source.${s.enabled ? 'disable' : 'enable'}`, { id: s.id });
      toast.success(s.enabled ? t('ingress_mgmt.toast_disabled', { name: s.name }) : t('ingress_mgmt.toast_enabled', { name: s.name }));
      fetchSources();
    } catch (err: any) {
      toast.error(err.message || t('ingress_mgmt.err_toggle_failed'));
    } finally {
      setBusy(null);
    }
  };

  const openFireModal = (s: Source) => {
    setFireModal(s);
    setFirePayload('{}');
    setFirePayloadErr(null);
  };

  const parsePayload = (raw: string) => {
    try { return { ok: true, data: JSON.parse(raw) }; }
    catch (e: any) { return { ok: false, error: e.message }; }
  };

  // Path 1: synthetic event via ingress.source.test (bypasses dedup/API-key)
  const handleFireSubmit = async () => {
    const parsed = parsePayload(firePayload);
    if (!parsed.ok) { setFirePayloadErr(parsed.error!); return; }
    if (!fireModal) return;
    setFiring('fire');
    try {
      const result = await callRpc<{ stream: string }>('ingress.source.test', { id: fireModal.id, data: parsed.data });
      toast.success(t('ingress_mgmt.toast_fired', { stream: result.stream }));
      fetchSources();
      setFireModal(null);
    } catch (err: any) {
      toast.error(err.message || t('ingress_mgmt.err_fire_failed'));
    } finally {
      setFiring(null);
    }
  };

  // Path 2: POST to mock listener /hook — full ingress pipeline (API key → dedup → relay)
  const handleSend = async () => {
    if (!fireModal?.healthUrl) return;
    const parsed = parsePayload(firePayload);
    if (!parsed.ok) { setFirePayloadErr(parsed.error!); return; }
    const hookUrl = fireModal.healthUrl.replace(/\/health$/, '/hook');
    setFiring('send');
    try {
      const r = await fetch(hookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(5000),
      });
      const body = await r.json().catch(() => ({}));
      // mock listener透传 Router 的 JSON-RPC 响应: { jsonrpc, result:{ok,stream,...}, id }
      const rpcResult = body.result ?? body;
      const rpcError  = body.error;
      if (rpcResult?.ok) {
        toast.success(t('ingress_mgmt.toast_sent', {
          stream: rpcResult.stream ?? 'ingress',
          outcome: rpcResult.duplicate ? t('ingress_mgmt.outcome_duplicate') : t('ingress_mgmt.outcome_accepted'),
        }));
      } else {
        const msg = rpcError?.message ?? rpcResult?.error ?? String(r.status);
        toast.error(t('ingress_mgmt.toast_listener_error', { msg }));
      }
      fetchSources();
      setFireModal(null);
    } catch (err: any) {
      toast.error(t('ingress_mgmt.toast_send_failed', { msg: err.message }));
    } finally {
      setFiring(null);
    }
  };

  const handlePing = async (s: Source) => {
    if (!s.healthUrl) return;
    setBusy(s.id);
    try {
      const r = await fetch(s.healthUrl, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.success(t('ingress_mgmt.toast_ping_alive', { name: s.name, uptime: body.uptime ?? '?' }));
      } else {
        toast.error(t('ingress_mgmt.toast_ping_responded', { name: s.name, status: r.status }));
      }
    } catch {
      toast.error(t('ingress_mgmt.toast_ping_unreachable', { name: s.name }));
    } finally {
      setBusy(null);
    }
  };

  const handleRotate = async (s: Source) => {
    const ok = await confirm({
      message: t('ingress_mgmt.confirm_rotate', { name: s.name }),
      confirmLabel: t('ingress_mgmt.btn_rotate'),
      isDangerous: true,
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      const result = await callRpc<{ apiKey: string }>('ingress.source.key.rotate', { id: s.id });
      setRevealed({ name: s.name, apiKey: result.apiKey, action: 'rotated' });
    } catch (err: any) {
      toast.error(err.message || t('ingress_mgmt.err_rotate_failed'));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (s: Source) => {
    const ok = await confirm({
      message: t('ingress_mgmt.confirm_delete', { name: s.name, stream: s.stream }),
      confirmLabel: t('ingress_mgmt.btn_delete'),
      isDangerous: true,
    });
    if (!ok) return;
    try {
      await callRpc('ingress.source.delete', { id: s.id });
      toast.success(t('ingress_mgmt.toast_deleted', { name: s.name }));
      fetchSources();
    } catch (err: any) {
      toast.error(err.message || t('ingress_mgmt.err_delete_failed'));
    }
  };

  const totalPages = Math.ceil(total / pageSize);
  const cols = '1.5fr 2.2fr 0.9fr 0.8fr 1.6fr 0.7fr 0.7fr 2.6fr';

  return (
    <>
      {/* Toolbar */}
      <div className="flex justify-end px-4 py-2 border-b border-border bg-white/[0.01] shrink-0">
        <button
          onClick={() => setShowCreate(true)}
          className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
        >
          {t('ingress_mgmt.btn_new_source')}
        </button>
      </div>

      {error && <div className="p-4 text-error text-[13px]">{t('ingress_mgmt.error_prefix', { msg: error })}</div>}

      <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10" style={{ gridTemplateColumns: cols }}>
        <div>{t('ingress_mgmt.col_name')}</div>
        <div>{t('ingress_mgmt.col_stream')}</div>
        <div>{t('ingress_mgmt.col_enabled')}</div>
        <div>{t('ingress_mgmt.col_dedup')}</div>
        <div>{t('ingress_mgmt.col_last_fired')}</div>
        <div>{t('ingress_mgmt.col_hits')}</div>
        <div>{t('ingress_mgmt.col_dups')}</div>
        <div>{t('ingress_mgmt.col_actions')}</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('ingress_mgmt.loading')}</div>}

        {sources.map(s => (
          <div key={s.id} className="grid gap-4 px-5 border-b border-border hover:bg-white/[0.02] items-center text-sm transition-colors min-h-[52px] py-2" style={{ gridTemplateColumns: cols }}>
            <div className="font-medium truncate" title={s.name}>{s.name}</div>
            <div className="font-mono text-[11px] text-accent truncate" title={s.stream}>{s.stream}</div>
            <div>
              <button
                onClick={() => handleToggle(s)}
                disabled={busy === s.id}
                className={`text-[10px] px-2 py-0.5 rounded border transition-all disabled:opacity-50 ${
                  s.enabled ? 'text-success border-success/40 bg-success/10 hover:bg-success/20' : 'text-text-secondary border-border bg-white/5 hover:bg-white/10'
                }`}
              >
                {s.enabled ? t('ingress_mgmt.toggle_on') : t('ingress_mgmt.toggle_off')}
              </button>
            </div>
            <div className="text-[11px] text-text-secondary">{ttlHuman(s.dedupTtlSec)}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${freshnessColor(s.lastFiredAt)}`} title={s.lastFiredAt ? t('ingress_mgmt.fired_ago', { n: Math.round((Date.now() - s.lastFiredAt) / 1000) }) : t('ingress_mgmt.never_fired')} />
              {s.lastFiredAt ? formatDate(s.lastFiredAt) : '—'}
            </div>
            <div className="text-[11px]">{s.hitCount ?? 0}</div>
            <div className="text-[11px] text-warning/70">{s.dupCount ?? 0}</div>
            <div className="flex gap-1.5 items-center flex-wrap">
              <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all" onClick={() => setRawSource(s)}>{t('ingress_mgmt.btn_raw')}</button>
              <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50" disabled={busy === s.id} onClick={() => openFireModal(s)}>{t('ingress_mgmt.btn_fire')}</button>
              {s.healthUrl && (
                <button className="bg-[rgba(63,185,80,0.12)] border border-[rgba(63,185,80,0.4)] text-[#3fb950] rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-[#3fb950] hover:text-white transition-all disabled:opacity-50" disabled={busy === s.id} onClick={() => handlePing(s)}>{t('ingress_mgmt.btn_ping')}</button>
              )}
              <button className="bg-[rgba(56,139,253,0.15)] border border-[rgba(56,139,253,0.4)] text-[#58a6ff] rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50" disabled={busy === s.id} onClick={() => handleRotate(s)}>{t('ingress_mgmt.btn_rotate_key')}</button>
              <button className="bg-error/10 border border-error/40 text-error rounded-md px-2.5 py-1 text-[11px] font-medium hover:bg-error hover:text-white transition-all" onClick={() => handleDelete(s)}>{t('ingress_mgmt.btn_del')}</button>
            </div>
          </div>
        ))}

        {!loading && sources.length === 0 && (
          <div className="p-6 text-center opacity-50 text-[13px]">
            {t('ingress_mgmt.empty_sources')}
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center shrink-0">
        <span className="text-xs text-text-secondary">{t('ingress_mgmt.pagination', { total, page, pages: totalPages || 1 })}</span>
        <div className="flex gap-2">
          <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>{t('ingress_mgmt.btn_prev')}</button>
          <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>{t('ingress_mgmt.btn_next')}</button>
        </div>
      </div>

      {/* Create Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => !creating && setShowCreate(false)}
        title={t('ingress_mgmt.create_title')}
        size="md"
        footer={
          <>
            <Button onClick={() => setShowCreate(false)} variant="secondary" disabled={creating}>{t('ingress_mgmt.btn_cancel')}</Button>
            <Button onClick={handleCreate} disabled={creating || !form.name.trim()}>{creating ? t('ingress_mgmt.btn_creating') : t('ingress_mgmt.btn_create')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('ingress_mgmt.label_name')}</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder={t('ingress_mgmt.placeholder_name')}
              className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            />
            <div className="mt-1 text-[10px] text-text-secondary">
              ^[a-zA-Z0-9_-]{'{1,64}'}$ · {t('ingress_mgmt.hint_name_stream')} <span className="font-mono">EVENT:WEBHOOK:{(form.name || 'NAME').toUpperCase()}</span>
            </div>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('ingress_mgmt.label_dedup_ttl')}</label>
            <input
              type="number"
              value={form.dedupTtlSec}
              onChange={e => setForm(f => ({ ...f, dedupTtlSec: e.target.value }))}
              placeholder="86400"
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            />
            <div className="mt-1 text-[10px] text-text-secondary">{t('ingress_mgmt.hint_dedup_ttl')}</div>
          </div>
        </div>
      </Modal>

      {/* One-time API key reveal */}
      <Modal
        isOpen={!!revealed}
        onClose={() => setRevealed(null)}
        title={revealed?.action === 'rotated'
          ? t('ingress_mgmt.reveal_title_rotated', { name: revealed?.name || '' })
          : t('ingress_mgmt.reveal_title_created', { name: revealed?.name || '' })}
        size="md"
        footer={<Button onClick={() => setRevealed(null)}>{t('ingress_mgmt.btn_done')}</Button>}
      >
        <div className="flex flex-col gap-3">
          <div className="border border-warning/40 bg-warning/5 rounded-md px-4 py-3 text-[12px] text-warning leading-relaxed">
            {t('ingress_mgmt.reveal_warn_pre')} <strong>{t('ingress_mgmt.reveal_warn_emph')}</strong>{t('ingress_mgmt.reveal_warn_mid')}（<span className="font-mono">INGRESS_API_KEY</span>）{t('ingress_mgmt.reveal_warn_post')}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] font-mono text-accent break-all">{revealed?.apiKey}</code>
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-2 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
              onClick={() => { if (revealed) { navigator.clipboard.writeText(revealed.apiKey); toast.success(t('ingress_mgmt.toast_copied')); } }}
            >
              {t('ingress_mgmt.btn_copy')}
            </button>
          </div>
          <div className="text-[11px] text-text-secondary">
            {t('ingress_mgmt.reveal_listener_pre')} <span className="font-mono">Authorization: ApiKey {'<key>'}</span> {t('ingress_mgmt.reveal_listener_mid')} <span className="font-mono">ingress.ingest</span>{t('ingress_mgmt.reveal_listener_post')}
          </div>
        </div>
      </Modal>

      {/* RAW Modal */}
      <Modal
        isOpen={!!rawSource}
        onClose={() => setRawSource(null)}
        title={t('ingress_mgmt.raw_title', { id: rawSource?.id || '' })}
        size="lg"
        footer={<Button onClick={() => setRawSource(null)}>{t('ingress_mgmt.btn_close')}</Button>}
      >
        <pre className="bg-bg-primary p-4 rounded-md text-xs font-mono overflow-auto border border-border text-text-secondary h-[60vh]">
          {rawSource && JSON.stringify(rawSource, null, 2)}
        </pre>
      </Modal>

      {/* FIRE Modal */}
      <Modal
        isOpen={!!fireModal}
        onClose={() => !firing && setFireModal(null)}
        title={t('ingress_mgmt.fire_title', { name: fireModal?.name ?? '' })}
        size="md"
        footer={
          <div className="flex gap-2 justify-end w-full">
            <Button onClick={() => setFireModal(null)} variant="secondary" disabled={!!firing}>{t('ingress_mgmt.btn_cancel')}</Button>
            {fireModal?.healthUrl && (
              <button
                onClick={handleSend}
                disabled={!!firing}
                className="bg-[rgba(63,185,80,0.12)] border border-[rgba(63,185,80,0.4)] text-[#3fb950] rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#3fb950] hover:text-white transition-all disabled:opacity-50"
              >
                {firing === 'send' ? t('ingress_mgmt.btn_sending') : t('ingress_mgmt.btn_send_via_listener')}
              </button>
            )}
            <Button onClick={handleFireSubmit} disabled={!!firing}>
              {firing === 'fire' ? t('ingress_mgmt.btn_firing') : t('ingress_mgmt.btn_fire')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="text-[11px] text-text-secondary leading-relaxed">
            <strong className="text-text-primary">{t('ingress_mgmt.btn_fire')}</strong>{t('ingress_mgmt.fire_desc')}
            {fireModal?.healthUrl && (
              <> &nbsp;<strong className="text-[#3fb950]">{t('ingress_mgmt.btn_send_via_listener')}</strong>{t('ingress_mgmt.fire_send_desc_pre')} <span className="font-mono">{fireModal.healthUrl.replace(/\/health$/, '/hook')}</span>{t('ingress_mgmt.fire_send_desc_post')}</>
            )}
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-1.5">{t('ingress_mgmt.label_payload')}</label>
            <textarea
              value={firePayload}
              onChange={e => { setFirePayload(e.target.value); setFirePayloadErr(null); }}
              rows={10}
              spellCheck={false}
              className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-y"
              placeholder="{}"
            />
            {firePayloadErr && (
              <div className="mt-1 text-[11px] text-error font-mono">{firePayloadErr}</div>
            )}
          </div>
          <div className="text-[11px] text-text-secondary">
            {t('ingress_mgmt.fire_hint_pre')} <span className="font-mono">$input.data.*</span> {t('ingress_mgmt.fire_hint_post')}
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─── Deliveries Tab (log) ─────────────────────────────────────────────────────

function DeliveriesTab() {
  const { t } = useLang();
  const [items, setItems] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('');

  const fetchLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callRpc<{ items: Delivery[]; total: number }>('ingress.log.recent', {
        limit: 200, days: 7, ...(outcome ? { outcome } : {}),
      });
      setItems(result.items || []);
    } catch (err: any) {
      setError(err.message || t('ingress_mgmt.err_load_log'));
    } finally {
      setLoading(false);
    }
  }, [outcome]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const cols = '1.8fr 1.2fr 2.4fr 1.2fr 0.8fr 0.8fr';

  return (
    <>
      {/* Toolbar */}
      <div className="flex justify-between items-center px-4 py-2 border-b border-border bg-white/[0.01] shrink-0">
        <select
          value={outcome}
          onChange={e => setOutcome(e.target.value)}
          className="bg-bg-primary border border-border rounded-md px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
        >
          {OUTCOMES.map(o => <option key={o} value={o}>{o ? t(`ingress_mgmt.outcome_${o}`) : t('ingress_mgmt.outcome_all')}</option>)}
        </select>
        <button
          onClick={fetchLog}
          disabled={loading}
          className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
        >
          {t('ingress_mgmt.btn_refresh')}
        </button>
      </div>

      {error && <div className="p-4 text-error text-[13px]">{t('ingress_mgmt.error_prefix', { msg: error })}</div>}

      <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10" style={{ gridTemplateColumns: cols }}>
        <div>{t('ingress_mgmt.col_time')}</div>
        <div>{t('ingress_mgmt.col_source')}</div>
        <div>{t('ingress_mgmt.col_request_id')}</div>
        <div>{t('ingress_mgmt.col_outcome')}</div>
        <div>{t('ingress_mgmt.col_status')}</div>
        <div>{t('ingress_mgmt.col_bytes')}</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('ingress_mgmt.loading')}</div>}

        {items.map((d, i) => (
          <div key={i} className="grid gap-4 px-5 border-b border-border hover:bg-white/[0.02] items-center text-sm transition-colors min-h-[44px] py-2" style={{ gridTemplateColumns: cols }}>
            <div className="text-[11px] text-text-secondary">{formatDate(d.ts)}</div>
            <div className="text-[12px] truncate" title={d.source}>{d.source}</div>
            <div className="font-mono text-[11px] text-text-secondary truncate" title={d.request_id || ''}>{d.request_id || '—'}</div>
            <div><span className={outcomeBadge(d.outcome)}>{t(`ingress_mgmt.outcome_${d.outcome}`)}</span></div>
            <div className="text-[11px]">{d.status}</div>
            <div className="text-[11px] text-text-secondary">{d.bytes}</div>
          </div>
        ))}

        {!loading && items.length === 0 && (
          <div className="p-6 text-center opacity-50 text-[13px]">
            {outcome ? t('ingress_mgmt.empty_deliveries_filtered', { outcome }) : t('ingress_mgmt.empty_deliveries')}
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex items-center shrink-0">
        <span className="text-xs text-text-secondary">
          {outcome ? t('ingress_mgmt.footer_showing_filtered', { n: items.length, outcome }) : t('ingress_mgmt.footer_showing', { n: items.length })} · logs/ingress/{'{year}'}/{'{day}'}.jsonl
        </span>
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function IngressManagement() {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>('sources');

  const TABS: { id: Tab; label: string }[] = [
    { id: 'sources',    label: t('ingress_mgmt.tab_sources') },
    { id: 'deliveries', label: t('ingress_mgmt.tab_deliveries') },
  ];

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex items-center shrink-0">
        <span>{t('ingress_mgmt.header')}</span>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-border shrink-0 bg-bg-secondary">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 h-10 text-[11px] font-mono uppercase tracking-wider transition-colors border-b-2
              ${tab === t.id
                ? 'border-accent text-accent bg-bg-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-white/[0.02]'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {tab === 'sources'    && <SourcesTab />}
        {tab === 'deliveries' && <DeliveriesTab />}
      </div>
    </div>
  );
}
