import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import { fetchKnownStreams } from '../utils/streamCatalog';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { formatDate } from '../utils/format';
import type { Sentinel, SentinelContext, FetcherRow } from './nexus/types';
import {
  TRACK_OPTIONS,
  REACHABILITY_OPTIONS,
  ON_ERROR_OPTIONS,
  READ_SUFFIXES,
  emptyFetcher,
  fetcherToRow,
} from './nexus/utils';
import SentinelPermitModal from './nexus/SentinelPermitModal';
import SentinelDeliveriesModal from './nexus/SentinelDeliveriesModal';

const defaultForm = {
  name: '',
  authorityRole: '',
  description: '',
  track: 'internal' as const,
  reachability: '' as string,
  webhookUrl: '',
  eventSubscriptions: '',
};

export default function NexusManagement() {
  const { toast } = useUI();
  const { t } = useLang();

  const [sentinels, setSentinels] = useState<Sentinel[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const pageSize = 20;

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [knownStreams, setKnownStreams] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // ── Context assembly editor state (context.md) ──────────────────────────────
  const [ctxEnabled, setCtxEnabled] = useState(false);
  const [ctxGuard, setCtxGuard] = useState('');
  const [ctxPrompt, setCtxPrompt] = useState('');
  const [ctxFetchers, setCtxFetchers] = useState<FetcherRow[]>([]);
  // autorun — AI decision via agent.decide. enabled + no choices = free-form (true);
  // with choices/threshold = the inverted-gate object { choices, confidence_threshold }.
  const [ctxAutorunEnabled, setCtxAutorunEnabled] = useState(false);
  const [ctxAutorunChoices, setCtxAutorunChoices] = useState('');     // comma-separated
  const [ctxAutorunThreshold, setCtxAutorunThreshold] = useState(''); // number string
  const [ctxAutorunSchema, setCtxAutorunSchema] = useState('');       // optional JSON (advanced)
  // emit — the declarative action: publish a decision event onto the bus.
  const [ctxEmitEnabled, setCtxEmitEnabled] = useState(false);
  const [ctxEmitStream, setCtxEmitStream] = useState('');
  const [ctxEmitType, setCtxEmitType] = useState('');
  const [ctxEmitWhen, setCtxEmitWhen] = useState('');                 // optional JsonLogic JSON
  const [ctxEmitPayload, setCtxEmitPayload] = useState('');           // optional payload_template JSON
  // Context keys the form STILL doesn't manage (future additions) — carried through
  // save verbatim so editing never silently strips them.
  const [ctxPassthrough, setCtxPassthrough] = useState<Record<string, unknown>>({});

  const updateFetcher = (i: number, patch: Partial<FetcherRow>) =>
    setCtxFetchers(fs => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addFetcher = () => setCtxFetchers(fs => [...fs, emptyFetcher()]);
  const removeFetcher = (i: number) => setCtxFetchers(fs => fs.filter((_, idx) => idx !== i));

  const clearCtxAutorun = () => { setCtxAutorunEnabled(false); setCtxAutorunChoices(''); setCtxAutorunThreshold(''); setCtxAutorunSchema(''); };
  const clearCtxEmit = () => { setCtxEmitEnabled(false); setCtxEmitStream(''); setCtxEmitType(''); setCtxEmitWhen(''); setCtxEmitPayload(''); };

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
    setCtxEnabled(false);
    setCtxGuard('');
    setCtxPrompt('');
    setCtxFetchers([]);
    clearCtxAutorun();
    clearCtxEmit();
    setCtxPassthrough({});
  };

  const openCreate = () => { resetForm(); setShowForm(true); };

  const openEdit = (s: Sentinel) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      authorityRole: s.authorityRole,
      description: s.description || '',
      track: s.track,
      reachability: s.reachability || '',
      webhookUrl: s.webhookUrl || '',
      eventSubscriptions: (s.eventSubscriptions || []).join('\n'),
    } as typeof defaultForm);
    const ctx = s.context;
    if (ctx) {
      setCtxEnabled(true);
      setCtxGuard(ctx.guard ? JSON.stringify(ctx.guard, null, 2) : '');
      setCtxPrompt(ctx.system_prompt_template || '');
      setCtxFetchers((ctx.data_fetchers || []).map(fetcherToRow));

      // autorun: boolean true (free-form) | object { choices, confidence_threshold, schema }
      const a = ctx.autorun;
      if (a === true) { setCtxAutorunEnabled(true); setCtxAutorunChoices(''); setCtxAutorunThreshold(''); setCtxAutorunSchema(''); }
      else if (a && typeof a === 'object') {
        setCtxAutorunEnabled(true);
        setCtxAutorunChoices((a.choices || []).join(', '));
        setCtxAutorunThreshold(a.confidence_threshold != null ? String(a.confidence_threshold) : '');
        setCtxAutorunSchema(a.schema ? JSON.stringify(a.schema, null, 2) : '');
      } else { clearCtxAutorun(); }

      // emit: { stream, type, emit_when?, payload_template? }
      const em = ctx.emit as { stream?: string; type?: string; emit_when?: unknown; payload_template?: unknown } | undefined;
      if (em) {
        setCtxEmitEnabled(true);
        setCtxEmitStream(em.stream || '');
        setCtxEmitType(em.type || '');
        setCtxEmitWhen(em.emit_when ? JSON.stringify(em.emit_when, null, 2) : '');
        setCtxEmitPayload(em.payload_template ? JSON.stringify(em.payload_template, null, 2) : '');
      } else { clearCtxEmit(); }

      // Preserve any keys the form still doesn't manage (now narrowed: guard / prompt /
      // fetchers / autorun / emit are all managed above).
      const { guard: _g, system_prompt_template: _p, data_fetchers: _f, autorun: _a, emit: _e, ...rest } = ctx as Record<string, unknown>;
      setCtxPassthrough(rest);
    } else {
      setCtxEnabled(false); setCtxGuard(''); setCtxPrompt(''); setCtxFetchers([]); clearCtxAutorun(); clearCtxEmit(); setCtxPassthrough({});
    }
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
    resetForm();
  };

  // Build the `context` object from the editor, mirroring the backend's static
  // gate (read-only suffix) so the user gets an inline error before the RPC.
  // Returns { context } on success or { error } to surface via toast.
  const buildContext = (): { context: SentinelContext | null; error?: string } => {
    if (!ctxEnabled) return { context: null };
    // Start from the unmanaged keys (autorun / emit …) so a prompt edit can never
    // strip them; the managed keys below overwrite their own slots only.
    const context: SentinelContext = { ...ctxPassthrough } as SentinelContext;

    if (ctxGuard.trim()) {
      let g: unknown;
      try { g = JSON.parse(ctxGuard); } catch { return { context: null, error: t('nexus_mgmt.err_guard_invalid_json') }; }
      if (typeof g !== 'object' || g === null || Array.isArray(g)) return { context: null, error: t('nexus_mgmt.err_guard_not_object') };
      context.guard = g as Record<string, unknown>;
    }

    if (ctxPrompt.trim()) context.system_prompt_template = ctxPrompt;

    const fetchers: Array<Record<string, unknown>> = [];
    for (const [i, f] of ctxFetchers.entries()) {
      const label = f.key.trim() ? `"${f.key.trim()}"` : `#${i + 1}`;
      if (!f.key.trim() && !f.method.trim()) continue; // ignore a fully-blank row
      if (!f.key.trim()) return { context: null, error: t('nexus_mgmt.err_fetcher_key_required', { label }) };
      if (!f.method.trim()) return { context: null, error: t('nexus_mgmt.err_fetcher_method_required', { label }) };
      const action = f.method.trim().split('.').pop() || '';
      if (!READ_SUFFIXES.includes(action)) {
        return { context: null, error: t('nexus_mgmt.err_fetcher_method_readonly', { label, suffixes: READ_SUFFIXES.join('/'), action }) };
      }
      const fetcher: Record<string, unknown> = { key: f.key.trim(), method: f.method.trim() };

      if (f.params.trim()) {
        try { fetcher.params = JSON.parse(f.params); } catch { return { context: null, error: t('nexus_mgmt.err_fetcher_params_invalid_json', { label }) }; }
      } else {
        fetcher.params = {};
      }
      if (f.result_path.trim()) fetcher.result_path = f.result_path.trim();
      const deps = f.depends_on.split(',').map(s => s.trim()).filter(Boolean);
      if (deps.length) fetcher.depends_on = deps;
      if (f.on_error !== 'abort') fetcher.on_error = f.on_error;
      if (f.on_error === 'fallback' && f.fallback.trim()) {
        try { fetcher.fallback = JSON.parse(f.fallback); } catch { return { context: null, error: t('nexus_mgmt.err_fetcher_fallback_invalid_json', { label }) }; }
      }
      if (f.guard.trim()) {
        let g: unknown;
        try { g = JSON.parse(f.guard); } catch { return { context: null, error: t('nexus_mgmt.err_fetcher_guard_invalid_json', { label }) }; }
        if (typeof g !== 'object' || g === null || Array.isArray(g)) return { context: null, error: t('nexus_mgmt.err_fetcher_guard_not_object', { label }) };
        fetcher.guard = g;
      }
      fetchers.push(fetcher);
    }
    if (fetchers.length) context.data_fetchers = fetchers;

    // autorun (mirror validateContext: boolean | { choices?: string[], schema?: object,
    // confidence_threshold?: number }). enabled + nothing set = free-form `true`.
    if (ctxAutorunEnabled) {
      const choices = ctxAutorunChoices.split(',').map(s => s.trim()).filter(Boolean);
      const a: { choices?: string[]; schema?: Record<string, unknown>; confidence_threshold?: number } = {};
      if (choices.length) a.choices = choices;
      if (ctxAutorunThreshold.trim()) {
        const n = Number(ctxAutorunThreshold);
        if (!Number.isFinite(n)) return { context: null, error: t('nexus_mgmt.err_autorun_threshold_number') };
        a.confidence_threshold = n;
      }
      if (ctxAutorunSchema.trim()) {
        let s: unknown;
        try { s = JSON.parse(ctxAutorunSchema); } catch { return { context: null, error: t('nexus_mgmt.err_autorun_schema_invalid_json') }; }
        if (typeof s !== 'object' || s === null || Array.isArray(s)) return { context: null, error: t('nexus_mgmt.err_autorun_schema_not_object') };
        a.schema = s as Record<string, unknown>;
      }
      context.autorun = Object.keys(a).length ? a : true;
    }

    // emit (mirror validateContext: { stream, type, emit_when?, payload_template? }).
    if (ctxEmitEnabled) {
      if (!ctxEmitStream.trim()) return { context: null, error: t('nexus_mgmt.err_emit_stream_required') };
      if (!ctxEmitType.trim()) return { context: null, error: t('nexus_mgmt.err_emit_type_required') };
      const emit: Record<string, unknown> = { stream: ctxEmitStream.trim(), type: ctxEmitType.trim() };
      if (ctxEmitWhen.trim()) {
        let w: unknown;
        try { w = JSON.parse(ctxEmitWhen); } catch { return { context: null, error: t('nexus_mgmt.err_emit_when_invalid_json') }; }
        if (typeof w !== 'object' || w === null || Array.isArray(w)) return { context: null, error: t('nexus_mgmt.err_emit_when_not_object') };
        emit.emit_when = w;
      }
      if (ctxEmitPayload.trim()) {
        let p: unknown;
        try { p = JSON.parse(ctxEmitPayload); } catch { return { context: null, error: t('nexus_mgmt.err_emit_payload_invalid_json') }; }
        if (typeof p !== 'object' || p === null || Array.isArray(p)) return { context: null, error: t('nexus_mgmt.err_emit_payload_not_object') };
        emit.payload_template = p;
      }
      context.emit = emit;
    }

    if (Object.keys(context).length === 0) return { context: null }; // enabled but empty → treat as none
    return { context };
  };

  const [rawSentinel, setRawSentinel] = useState<Sentinel | null>(null);
  const [permitView, setPermitView] = useState<Sentinel | null>(null);
  const [deliveriesView, setDeliveriesView] = useState<Sentinel | null>(null);
  const [broadcasting, setBroadcasting] = useState<string | null>(null);

  const fetchSentinels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callRpc<{ items: Sentinel[]; total: number }>(
        'nexus.sentinel.list',
        { page, pageSize }
      );
      setSentinels(result.items);
      setTotal(result.total);
    } catch (err: any) {
      setError(err.message || t('nexus_mgmt.failed_load_sentinels'));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { fetchSentinels(); }, [fetchSentinels]);
  useEffect(() => { fetchKnownStreams().then(setKnownStreams).catch(() => {}); }, []);

  const handleSubmit = async () => {
    if (!form.name.trim()) return toast.error(t('nexus_mgmt.err_name_required'));
    if (!form.authorityRole.trim()) return toast.error(t('nexus_mgmt.err_authority_role_required'));
    if (form.reachability === 'webhook' && !form.webhookUrl.trim()) return toast.error(t('nexus_mgmt.err_webhook_url_required'));

    const { context, error: ctxError } = buildContext();
    if (ctxError) return toast.error(ctxError);

    const eventSubscriptions = form.eventSubscriptions
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    const payload = {
      name: form.name.trim(),
      authorityRole: form.authorityRole.trim(),
      description: form.description.trim() || null,
      track: form.track,
      reachability: form.reachability || null,
      webhookUrl: form.reachability === 'webhook' ? form.webhookUrl.trim() : null,
      eventSubscriptions,
      context,
    };

    setSaving(true);
    try {
      if (editingId) {
        await callRpc('nexus.sentinel.update', { id: editingId, ...payload });
        toast.success(t('nexus_mgmt.toast_updated', { name: form.name }));
      } else {
        await callRpc('nexus.sentinel.create', payload);
        toast.success(t('nexus_mgmt.toast_created', { name: form.name }));
      }
      setShowForm(false);
      resetForm();
      fetchSentinels();
    } catch (err: any) {
      toast.error(err.message || (editingId ? t('nexus_mgmt.update_failed') : t('nexus_mgmt.create_failed')));
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async (sentinel: Sentinel) => {
    try {
      await callRpc('nexus.sentinel.disable', { id: sentinel.id });
      toast.success(t('nexus_mgmt.toast_disabled', { name: sentinel.name }));
      fetchSentinels();
    } catch (err: any) {
      toast.error(err.message || t('nexus_mgmt.disable_failed'));
    }
  };

  const handleBroadcast = async (sentinel: Sentinel) => {
    setBroadcasting(sentinel.id);
    try {
      const result = await callRpc<{ broadcasted: boolean; channel?: string; reason?: string }>(
        'nexus.sentinel.broadcast',
        { id: sentinel.id }
      );
      if (result.broadcasted) {
        toast.success(t('nexus_mgmt.toast_broadcasted', { channel: result.channel || '' }));
      } else {
        toast.error(t('nexus_mgmt.toast_nothing_broadcast', { reason: result.reason || '' }));
      }
    } catch (err: any) {
      toast.error(err.message || t('nexus_mgmt.broadcast_failed'));
    } finally {
      setBroadcasting(null);
    }
  };

  const needsBroadcast = (reachability: string | null) =>
    reachability === 'sse' || reachability === 'webhook';

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span>{t('nexus_mgmt.header_title')}</span>
        </div>
        <div className="flex gap-3 items-center bg-white/[0.03] px-3 py-1 rounded-md border border-white/5">
          <button
            onClick={openCreate}
            className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
          >
            {t('nexus_mgmt.new_sentinel')}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {error && <div className="p-4 text-error text-[13px]">{t('nexus_mgmt.error_prefix')}: {error}</div>}

        {/* Header Row */}
        <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10 grid-cols-[2fr_2.5fr_1fr_2.5fr_1fr_1fr_2.5fr]">
          <div>{t('nexus_mgmt.col_id')}</div>
          <div>{t('nexus_mgmt.col_name_role')}</div>
          <div>{t('nexus_mgmt.col_track')}</div>
          <div>{t('nexus_mgmt.col_event_subscriptions')}</div>
          <div>{t('nexus_mgmt.col_activity')}</div>
          <div>{t('nexus_mgmt.col_status')}</div>
          <div>{t('nexus_mgmt.col_actions')}</div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sentinels.map(sentinel => (
            <div
              key={sentinel.id}
              className="grid gap-4 px-5 border-b border-border hover:bg-white/[0.02] items-center text-sm transition-colors grid-cols-[2fr_2.5fr_1fr_2.5fr_1fr_1fr_2.5fr] min-h-[52px] py-2"
            >
              <div className="font-mono text-[11px] text-accent truncate" title={sentinel.id}>
                {sentinel.id}
              </div>

              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium truncate" title={sentinel.name}>{sentinel.name}</span>
                  {sentinel.context && (
                    <span
                      className="shrink-0 text-[9px] px-1 py-0.5 border border-accent/40 text-accent bg-accent/10 rounded"
                      title={t('nexus_mgmt.ctx_badge_tooltip')}
                    >
                      ⚙ ctx
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-secondary font-mono truncate flex items-center gap-1" title={sentinel.authorityRole}>
                  <span className="truncate">{sentinel.authorityRole}</span>
                  {(sentinel.identity?.mode === 'bot' || sentinel.authorityRole.startsWith('system.')) ? (
                    <span
                      data-test="identity-badge"
                      className={`shrink-0 text-[9px] px-1 py-0.5 border rounded ${
                        sentinel.identity?.hasToken === false || sentinel.identity?.expired
                          ? 'border-error/40 text-error bg-error/10'
                          : 'border-accent/40 text-accent bg-accent/10'
                      }`}
                      title={
                        sentinel.identity?.expired
                          ? t('nexus_mgmt.identity_tooltip_expired')
                          : sentinel.identity?.hasToken === false
                            ? t('nexus_mgmt.identity_tooltip_not_provisioned')
                            : sentinel.identity?.hasToken
                              ? t('nexus_mgmt.identity_tooltip_provisioned')
                              : t('nexus_mgmt.identity_tooltip_unknown')
                      }
                    >
                      {sentinel.identity?.expired ? t('nexus_mgmt.badge_bot_expired') : `${t('nexus_mgmt.badge_bot')}${sentinel.identity?.hasToken === true ? ' ●' : sentinel.identity?.hasToken === false ? ' ○' : ''}`}
                    </span>
                  ) : (
                    <span
                      data-test="identity-badge"
                      className="shrink-0 text-[9px] px-1 py-0.5 border border-border text-text-secondary bg-white/5 rounded"
                      title={t('nexus_mgmt.identity_tooltip_shared')}
                    >
                      {t('nexus_mgmt.badge_shared')}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <span className={`text-[10px] px-1.5 py-0.5 border rounded ${
                  sentinel.track === 'internal'
                    ? 'border-success/40 text-success bg-success/10'
                    : 'border-warning/40 text-warning bg-warning/10'
                }`}>
                  {sentinel.track.toUpperCase()}
                </span>
              </div>

              <div className="flex flex-col gap-0.5">
                {sentinel.eventSubscriptions.length === 0 ? (
                  <span className="text-[11px] opacity-30">—</span>
                ) : (
                  sentinel.eventSubscriptions.slice(0, 2).map(ev => (
                    <span key={ev} className="font-mono text-[10px] text-text-secondary truncate" title={ev}>{ev}</span>
                  ))
                )}
                {sentinel.eventSubscriptions.length > 2 && (
                  <span className="text-[10px] opacity-40">{t('nexus_mgmt.more_count', { n: sentinel.eventSubscriptions.length - 2 })}</span>
                )}
              </div>

              <div className="flex flex-col gap-0.5" data-test="sentinel-activity">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${sentinel.online ? 'bg-success shadow-[0_0_6px_rgba(var(--color-success),0.8)]' : 'bg-border'}`} title={sentinel.online ? t('nexus_mgmt.online_heartbeat') : t('nexus_mgmt.offline')} />
                  {sentinel.activity ? (
                    <span className="font-mono text-[10px] text-text-secondary whitespace-nowrap"
                      title={t('nexus_mgmt.activity_tooltip', { fired: sentinel.activity.fired, skipped: sentinel.activity.skipped, failed: sentinel.activity.failed })}>
                      ⚡{sentinel.activity.fired} ↷{sentinel.activity.skipped}
                      {sentinel.activity.failed > 0 && <span className="text-error"> ✗{sentinel.activity.failed}</span>}
                    </span>
                  ) : (
                    <span className="text-[10px] opacity-30">—</span>
                  )}
                </div>
                {sentinel.activity?.lastFiredAt ? (
                  <span className="text-[9px] text-text-secondary/60">{t('nexus_mgmt.last_label')}: {formatDate(sentinel.activity.lastFiredAt)}</span>
                ) : sentinel.activity && (
                  <span className="text-[9px] text-text-secondary/40">{t('nexus_mgmt.never_fired')}</span>
                )}
              </div>

              <div>
                <span className={`text-[10px] px-2 py-0.5 rounded border ${
                  sentinel.status === 'ACTIVE'
                    ? 'text-success border-success/30 bg-success/10'
                    : 'text-error border-error/30 bg-error/10'
                }`}>
                  {sentinel.status}
                </span>
              </div>

              <div className="flex gap-2 items-center flex-wrap">
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => openEdit(sentinel)}
                >
                  {t('nexus_mgmt.edit')}
                </button>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => setRawSentinel(sentinel)}
                >
                  {t('nexus_mgmt.raw')}
                </button>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => setPermitView(sentinel)}
                  title={t('nexus_mgmt.permit_btn_tooltip')}
                >
                  {t('nexus_mgmt.permit')}
                </button>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => setDeliveriesView(sentinel)}
                  title={t('nexus_mgmt.deliveries_btn_tooltip')}
                >
                  {t('nexus_mgmt.deliveries')}
                </button>
                {needsBroadcast(sentinel.reachability) && (
                  <button
                    className="bg-[rgba(56,139,253,0.15)] border border-[rgba(56,139,253,0.4)] text-[#58a6ff] rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
                    onClick={() => handleBroadcast(sentinel)}
                    disabled={broadcasting === sentinel.id}
                    title={t('nexus_mgmt.broadcast_btn_tooltip')}
                  >
                    {broadcasting === sentinel.id ? t('nexus_mgmt.broadcasting') : t('nexus_mgmt.broadcast')}
                  </button>
                )}
                {sentinel.status === 'ACTIVE' && (
                  <button
                    className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-error hover:text-white transition-all"
                    onClick={() => handleDisable(sentinel)}
                  >
                    {t('nexus_mgmt.disable')}
                  </button>
                )}
              </div>
            </div>
          ))}

          {!loading && sentinels.length === 0 && (
            <div className="p-6 text-center opacity-50 text-[13px]">
              {t('nexus_mgmt.empty_prefix')} <strong>{t('nexus_mgmt.new_sentinel')}</strong> {t('nexus_mgmt.empty_suffix')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center">
          <span className="text-xs text-text-secondary">{t('nexus_mgmt.footer_pagination', { total, page, pages: totalPages || 1 })}</span>
          <div className="flex gap-2">
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={page <= 1 || loading}
              onClick={() => setPage(p => p - 1)}
            >
              {t('nexus_mgmt.prev')}
            </button>
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={page >= totalPages || loading}
              onClick={() => setPage(p => p + 1)}
            >
              {t('nexus_mgmt.next')}
            </button>
          </div>
        </div>
      </div>

      {/* Create / Edit Modal */}
      <Modal
        isOpen={showForm}
        onClose={closeForm}
        title={editingId ? t('nexus_mgmt.edit_sentinel_title') : t('nexus_mgmt.register_sentinel_title')}
        size="lg"
        footer={
          <>
            <Button onClick={closeForm} variant="secondary" disabled={saving}>{t('nexus_mgmt.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={saving || !form.name.trim() || !form.authorityRole.trim()}>
              {saving ? (editingId ? t('nexus_mgmt.saving') : t('nexus_mgmt.creating')) : (editingId ? t('nexus_mgmt.save') : t('nexus_mgmt.create'))}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_name')}</label>
            <input
              data-test="sentinel-name"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder={t('nexus_mgmt.ph_name')}
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_authority_role')}</label>
            <input
              data-test="sentinel-role"
              value={form.authorityRole}
              onChange={e => setForm(f => ({ ...f, authorityRole: e.target.value }))}
              placeholder={t('nexus_mgmt.ph_authority_role')}
              className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            />
            <div className="mt-1 text-[10px] text-text-secondary">{t('nexus_mgmt.hint_authority_role')}</div>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_description')}</label>
            <input
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder={t('nexus_mgmt.ph_description')}
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_track')}</label>
              <select
                value={form.track}
                onChange={e => setForm(f => ({ ...f, track: e.target.value as typeof form.track }))}
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
              >
                {TRACK_OPTIONS.map(tk => (
                  <option key={tk} value={tk}>{tk}</option>
                ))}
              </select>
            </div>

            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_reachability')}</label>
              <select
                value={form.reachability}
                onChange={e => setForm(f => ({ ...f, reachability: e.target.value, webhookUrl: '' }))}
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
              >
                {REACHABILITY_OPTIONS.map(r => (
                  <option key={r} value={r}>{r || '—'}</option>
                ))}
              </select>
            </div>
          </div>

          {form.reachability === 'webhook' && (
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_webhook_url')}</label>
              <input
                value={form.webhookUrl}
                onChange={e => setForm(f => ({ ...f, webhookUrl: e.target.value }))}
                placeholder="https://your-sentinel.example.com/events"
                className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
              />
              <div className="mt-1 text-[10px] text-text-secondary">{t('nexus_mgmt.hint_webhook_url')}</div>
            </div>
          )}

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_event_subscriptions')}</label>
            <textarea
              data-test="sentinel-subscriptions"
              value={form.eventSubscriptions}
              onChange={e => setForm(f => ({ ...f, eventSubscriptions: e.target.value }))}
              placeholder={'EVENT:WORKFLOW:STATUS:PENDING_REVIEW\nEVENT:ERP:ORDER_PLACED'}
              rows={3}
              className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-none"
            />
            <div className="mt-1 text-[10px] text-text-secondary">{t('nexus_mgmt.hint_event_subscriptions')}</div>
            {(() => {
              const current = new Set(form.eventSubscriptions.split('\n').map(s => s.trim()).filter(Boolean));
              const suggestions = knownStreams.filter(s => !current.has(s));
              if (!suggestions.length) return null;
              return (
                <div className="mt-2">
                  <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexusHub.pick_streams') || 'Known streams · click to add'}</div>
                  <div className="flex flex-wrap gap-1">
                    {suggestions.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, eventSubscriptions: (f.eventSubscriptions.trim() ? f.eventSubscriptions.trim() + '\n' : '') + s }))}
                        className="inline-flex items-center gap-1 border border-accent/40 text-accent px-1.5 py-0.5 text-[10px] font-mono hover:bg-accent-dim transition-all"
                      >
                        <span className="opacity-50">+</span>{s}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* ── Context Assembly (context.md) ───────────────────────────────── */}
          <div className="border border-border rounded-md bg-white/[0.02]">
            <label className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                data-test="ctx-enable"
                checked={ctxEnabled}
                onChange={e => setCtxEnabled(e.target.checked)}
                className="accent-accent w-3.5 h-3.5"
              />
              <span className="text-[11px] uppercase tracking-wider text-accent font-medium">{t('nexus_mgmt.ctx_assembly_title')}</span>
              <span className="text-[10px] text-text-secondary normal-case tracking-normal">
                {t('nexus_mgmt.ctx_assembly_subtitle')}
              </span>
            </label>

            {ctxEnabled && (
              <div className="flex flex-col gap-4 px-3 pb-4 pt-1 border-t border-border">
                {/* Unmanaged context keys (autorun / emit — editors are a v2 item) */}
                {Object.keys(ctxPassthrough).length > 0 && (
                  <div data-test="ctx-passthrough-note" className="text-[11px] text-text-secondary border border-warning/30 bg-warning/5 rounded-md px-3 py-2 leading-relaxed">
                    {t('nexus_mgmt.ctx_passthrough_prefix')}
                    <code className="text-warning font-mono mx-1">{Object.keys(ctxPassthrough).join(', ')}</code>
                    {t('nexus_mgmt.ctx_passthrough_suffix')}
                  </div>
                )}

                {/* Trigger guard */}
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_trigger_guard')} <span className="normal-case tracking-normal opacity-60">{t('nexus_mgmt.hint_jsonlogic_optional')}</span></label>
                  <textarea
                    value={ctxGuard}
                    onChange={e => setCtxGuard(e.target.value)}
                    placeholder={'{ "==": [ { "var": "event.status" }, "PENDING_REVIEW" ] }'}
                    rows={2}
                    className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-y"
                  />
                  <div className="mt-1 text-[10px] text-text-secondary">{t('nexus_mgmt.hint_trigger_guard')} <code className="text-accent">{'{{event.*}}'}</code>.</div>
                </div>

                {/* Data fetchers */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[11px] uppercase tracking-wider text-text-secondary">{t('nexus_mgmt.label_data_fetchers')}</label>
                    <button
                      type="button"
                      onClick={addFetcher}
                      className="bg-accent-dim border border-accent/40 text-accent rounded px-2 py-0.5 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                    >
                      {t('nexus_mgmt.add_fetcher')}
                    </button>
                  </div>

                  {ctxFetchers.length === 0 && (
                    <div className="text-[10px] text-text-secondary opacity-60 border border-dashed border-border rounded-md px-3 py-3 text-center">
                      {t('nexus_mgmt.no_fetchers', { suffixes: READ_SUFFIXES.join('/') })}
                    </div>
                  )}

                  <div className="flex flex-col gap-3">
                    {ctxFetchers.map((f, i) => (
                      <div key={i} className="border border-border rounded-md p-3 bg-bg-primary/40 flex flex-col gap-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-text-secondary">{t('nexus_mgmt.fetcher_n', { n: i + 1 })}</span>
                          <button
                            type="button"
                            onClick={() => removeFetcher(i)}
                            className="text-error/70 hover:text-error text-[11px] leading-none"
                            title={t('nexus_mgmt.remove_fetcher_tooltip')}
                          >
                            {t('nexus_mgmt.remove')}
                          </button>
                        </div>

                        <div className="flex gap-2">
                          <input
                            value={f.key}
                            onChange={e => updateFetcher(i, { key: e.target.value })}
                            placeholder={t('nexus_mgmt.ph_fetcher_key')}
                            className="flex-1 font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
                          />
                          <input
                            value={f.method}
                            onChange={e => updateFetcher(i, { method: e.target.value })}
                            placeholder={t('nexus_mgmt.ph_fetcher_method')}
                            className="flex-[2] font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
                          />
                        </div>

                        <input
                          value={f.params}
                          onChange={e => updateFetcher(i, { params: e.target.value })}
                          placeholder={'params (JSON) — e.g. { "id": "{{event.workflow_id}}" }'}
                          className="w-full font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
                        />

                        <div className="flex gap-2">
                          <input
                            value={f.result_path}
                            onChange={e => updateFetcher(i, { result_path: e.target.value })}
                            placeholder={t('nexus_mgmt.ph_fetcher_result_path')}
                            className="flex-1 font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent transition-colors"
                          />
                          <input
                            value={f.depends_on}
                            onChange={e => updateFetcher(i, { depends_on: e.target.value })}
                            placeholder={t('nexus_mgmt.ph_fetcher_depends_on')}
                            className="flex-1 font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent transition-colors"
                          />
                          <select
                            value={f.on_error}
                            onChange={e => updateFetcher(i, { on_error: e.target.value as FetcherRow['on_error'] })}
                            className="bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent transition-colors"
                            title={t('nexus_mgmt.on_error_policy_tooltip')}
                          >
                            {ON_ERROR_OPTIONS.map(o => <option key={o} value={o}>on_error: {o}</option>)}
                          </select>
                        </div>

                        {f.on_error === 'fallback' && (
                          <input
                            value={f.fallback}
                            onChange={e => updateFetcher(i, { fallback: e.target.value })}
                            placeholder={'fallback (JSON) — e.g. { "name": "unknown" }'}
                            className="w-full font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent transition-colors"
                          />
                        )}

                        <input
                          value={f.guard}
                          onChange={e => updateFetcher(i, { guard: e.target.value })}
                          placeholder={t('nexus_mgmt.ph_fetcher_guard')}
                          className="w-full font-mono bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent transition-colors"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* System prompt template */}
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('nexus_mgmt.label_system_prompt')}</label>
                  <textarea
                    value={ctxPrompt}
                    onChange={e => setCtxPrompt(e.target.value)}
                    placeholder={'You are a security auditor.\n\nWorkflow under review:\n{{fetch.workflow}}\n\nSubmitter: {{fetch.submitter.name}}'}
                    rows={4}
                    className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-y"
                  />
                  <div className="mt-1 text-[10px] text-text-secondary">
                    {t('nexus_mgmt.variables_label')} <code className="text-accent">{'{{event.*}}'}</code> <code className="text-accent">{'{{fetch.<key>.*}}'}</code> <code className="text-accent">{'{{sentinel.*}}'}</code>. {t('nexus_mgmt.rendered_before_delivery')}
                  </div>
                </div>

                {/* Autorun — AI decision via agent.decide */}
                <div className="border-t border-border pt-3" data-test="ctx-autorun">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={ctxAutorunEnabled} onChange={e => setCtxAutorunEnabled(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-[var(--color-accent)]" />
                    <span className="text-[11px] uppercase tracking-wider text-text-secondary font-semibold">{t('nexus_mgmt.label_autorun')}</span>
                    <span className="text-[10px] text-text-secondary opacity-60 normal-case tracking-normal">{t('nexus_mgmt.autorun_subtitle')}</span>
                  </label>
                  {ctxAutorunEnabled && (
                    <div className="mt-3 flex flex-col gap-3 pl-5">
                      <div className="flex gap-3">
                        <div className="flex-[2]">
                          <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_choices')} <span className="normal-case tracking-normal opacity-60">{t('nexus_mgmt.hint_choices')}</span></label>
                          <input value={ctxAutorunChoices} onChange={e => setCtxAutorunChoices(e.target.value)} placeholder={t('nexus_mgmt.ph_choices')}
                            className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors" />
                        </div>
                        <div className="flex-1">
                          <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_confidence')}</label>
                          <input value={ctxAutorunThreshold} onChange={e => setCtxAutorunThreshold(e.target.value)} placeholder="0.7"
                            className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_output_schema')} <span className="normal-case tracking-normal opacity-60">{t('nexus_mgmt.hint_output_schema')}</span></label>
                        <textarea value={ctxAutorunSchema} onChange={e => setCtxAutorunSchema(e.target.value)} placeholder={'{ "severity": "number 1-5" }'} rows={2}
                          className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-y" />
                      </div>
                      <div className="text-[10px] text-text-secondary">
                        {t('nexus_mgmt.autorun_help_1')} <code className="text-accent">agent.decide</code> {t('nexus_mgmt.autorun_help_2')} <code className="text-accent">{'{{output.decision}}'}</code> / <code className="text-accent">{'{{output.confidence}}'}</code> / <code className="text-accent">{'{{output.escalate}}'}</code>.
                      </div>
                    </div>
                  )}
                </div>

                {/* Emit — declarative action: publish a decision event */}
                <div className="border-t border-border pt-3" data-test="ctx-emit">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={ctxEmitEnabled} onChange={e => setCtxEmitEnabled(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-[var(--color-accent)]" />
                    <span className="text-[11px] uppercase tracking-wider text-text-secondary font-semibold">{t('nexus_mgmt.label_emit_event')}</span>
                    <span className="text-[10px] text-text-secondary opacity-60 normal-case tracking-normal">{t('nexus_mgmt.emit_subtitle')}</span>
                  </label>
                  {ctxEmitEnabled && (
                    <div className="mt-3 flex flex-col gap-3 pl-5">
                      <div className="flex gap-3">
                        <div className="flex-[2]">
                          <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_stream')}</label>
                          <input value={ctxEmitStream} onChange={e => setCtxEmitStream(e.target.value)} placeholder="EVENT:SENTINEL:RISK-REVIEW"
                            className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors" />
                        </div>
                        <div className="flex-[1.5]">
                          <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_type')}</label>
                          <input value={ctxEmitType} onChange={e => setCtxEmitType(e.target.value)} placeholder="sentinel.risk.assessed"
                            className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_emit_when')} <span className="normal-case tracking-normal opacity-60">{t('nexus_mgmt.hint_jsonlogic_optional')}</span></label>
                        <textarea value={ctxEmitWhen} onChange={e => setCtxEmitWhen(e.target.value)} placeholder={'{ "==": [ { "var": "output.decision" }, "approve" ] }'} rows={2}
                          className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-y" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">{t('nexus_mgmt.label_payload_template')} <span className="normal-case tracking-normal opacity-60">{t('nexus_mgmt.hint_json_optional')}</span></label>
                        <textarea value={ctxEmitPayload} onChange={e => setCtxEmitPayload(e.target.value)} placeholder={'{ "decision": "{{output.decision}}", "sourceId": "{{event.payload.sourceId}}" }'} rows={3}
                          className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent transition-colors resize-y" />
                      </div>
                      <div className="text-[10px] text-text-secondary">
                        {t('nexus_mgmt.emit_help_1')} <code className="text-accent">{'{{event.*}}'}</code> <code className="text-accent">{'{{fetch.*}}'}</code> <code className="text-accent">{'{{output.*}}'}</code>. {t('nexus_mgmt.emit_help_2')} <code className="text-accent">actor: sentinel:{'{id}'}</code> {t('nexus_mgmt.emit_help_3')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {needsBroadcast(form.reachability) && (
            <div className="text-[11px] text-text-secondary border border-border rounded-md p-3 bg-white/[0.02] leading-relaxed">
              {t('nexus_mgmt.broadcast_hint_prefix')} <strong>{t('nexus_mgmt.broadcast')}</strong> {t('nexus_mgmt.broadcast_hint_suffix')}
            </div>
          )}
        </div>
      </Modal>

      {/* RAW Modal */}
      <Modal
        isOpen={!!rawSentinel}
        onClose={() => setRawSentinel(null)}
        title={`${t('nexus_mgmt.raw_modal_title')}: ${rawSentinel?.id || ''}`}
        size="lg"
        footer={<Button onClick={() => setRawSentinel(null)}>{t('nexus_mgmt.close')}</Button>}
      >
        <pre className="bg-bg-primary p-4 rounded-md text-xs font-mono overflow-auto border border-border text-text-secondary h-[60vh]">
          {rawSentinel && JSON.stringify(rawSentinel, null, 2)}
        </pre>
      </Modal>

      {/* Permit Modal (read-only — editing lives in BOT ACCOUNTS) */}
      {permitView && <SentinelPermitModal sentinel={permitView} onClose={() => setPermitView(null)} />}

      {/* Deliveries Modal (inbox audit incl. autorun verdicts / escalations) */}
      {deliveriesView && <SentinelDeliveriesModal sentinel={deliveriesView} onClose={() => setDeliveriesView(null)} />}
    </div>
  );
}
