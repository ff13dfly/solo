import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Button } from '../../components/ui/Button';
import type { AutomationStatus, RunRow, Glance, OpsAlert } from './types';
const ATTENTION_STATUSES = ['PAUSED_AWAITING_HUMAN', 'FAILED', 'STALLED'] as const;
const STATUS_BADGE: Record<string, string> = {
  PAUSED_AWAITING_HUMAN: 'text-warning border-warning',
  FAILED: 'text-danger border-danger',
  STALLED: 'text-danger border-danger',
};
const ts = (n?: number) => (n ? new Date(n).toLocaleString() : '—');

const SERVICE_LABEL_KEYS: Record<string, string> = {
  nexus: 'automation.service.nexus',
  orchestrator: 'automation.service.orchestrator',
};

function Stat({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className={`border rounded px-3 py-3 bg-bg-secondary ${warn ? 'border-warning' : 'border-border'}`}>
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`font-mono text-lg font-bold ${warn ? 'text-warning' : 'text-text-primary'}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-secondary">{sub}</div>}
    </div>
  );
}

export default function AutomationControl() {
  const { toast, confirm } = useUI();
  const { t } = useLang();
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [glance, setGlance] = useState<Glance>({ sentinels: 0, online: 0, schedules: 0, dlq: 0, pausedRuns: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // toFix §6.7 — drill-down state
  const [attentionRuns, setAttentionRuns] = useState<RunRow[]>([]);
  const [nexusDlq, setNexusDlq] = useState<any[]>([]);
  const [notifDlq, setNotifDlq] = useState<any[]>([]);
  const [opsAlerts, setOpsAlerts] = useState<OpsAlert[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [st, sl, sc, dq, ...rns] = await Promise.allSettled([
      callRpc<AutomationStatus>('setting.automation.status'),
      callRpc<{ items: any[]; total: number }>('nexus.sentinel.list', { pageSize: 200 }),
      callRpc<{ items: any[] }>('nexus.schedule.list'),
      callRpc<{ items: any[]; total: number }>('nexus.dlq.list', { pageSize: 20 }),
      ...ATTENTION_STATUSES.map(s => callRpc<any>('orchestrator.run.list', { status: s })),
    ]);
    if (st.status === 'fulfilled') setStatus(st.value);
    else toast.error(t('automation.toast.status_unavailable'));

    const g: Glance = { sentinels: 0, online: 0, schedules: 0, dlq: 0, pausedRuns: 0 };
    if (sl.status === 'fulfilled') {
      g.sentinels = sl.value.total ?? (sl.value.items?.length || 0);
      g.online = (sl.value.items || []).filter((s: any) => s.online).length;
    }
    if (sc.status === 'fulfilled') g.schedules = (sc.value.items || []).length;
    if (dq.status === 'fulfilled') {
      g.dlq = dq.value.total ?? (dq.value.items?.length || 0);
      setNexusDlq(dq.value.items || []);
    }

    const runs: RunRow[] = [];
    rns.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const v: any = r.value;
      runs.push(...(Array.isArray(v) ? v : v?.items || []));
    });
    g.pausedRuns = runs.filter(r => r.status === 'PAUSED_AWAITING_HUMAN').length;
    setAttentionRuns(runs);

    // notification deadletter (separate settle — its failure must not blank the rest)
    try {
      const nd = await callRpc<{ items: any[]; total: number }>('notification.deadletter.list', { pageSize: 20 });
      setNotifDlq(nd.items || []);
    } catch { setNotifDlq([]); }

    // ops alert inbox — the stall scanner + grant-needed paths post here (targetId 'ops')
    try {
      const oa = await callRpc<{ items: OpsAlert[]; total: number }>('notification.inbox.list', { targetId: 'ops', unreadOnly: false, pageSize: 20 });
      setOpsAlerts(oa.items || []);
    } catch { setOpsAlerts([]); }

    setGlance(g);
    setLoading(false);
  }, [toast, t]);

  useEffect(() => { refresh(); }, [refresh]);

  const pauseAll = async () => {
    const ok = await confirm({
      title: t('automation.confirm.pause_all_title'),
      message: t('automation.confirm.pause_all_message'),
      confirmLabel: t('automation.confirm.pause_all_label'),
      isDangerous: true,
    });
    if (!ok) return;
    setBusy(true);
    try { await callRpc('setting.automation.pause'); toast.success(t('automation.toast.all_paused')); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const resumeAll = async () => {
    setBusy(true);
    try { await callRpc('setting.automation.resume'); toast.success(t('automation.toast.all_resumed')); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const toggleService = async (service: string, paused: boolean) => {
    const action = paused ? 'resume' : 'pause';
    setBusy(true);
    try {
      await callRpc(`${service}.control.${action}`);
      toast.success(paused ? t('automation.toast.service_resumed', { service }) : t('automation.toast.service_paused', { service }));
      await refresh();
    }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  // toFix §6.7 — run + DLQ actions (all in-UI confirms, never window.confirm)
  const grantRun = async (run: RunRow) => {
    const methods = run.missingMethods || [];
    const ok = await confirm({
      title: t('automation.confirm.grant_title', { id: run.id }),
      message: t('automation.confirm.grant_message', { workflowId: run.workflowId, methods: methods.join(', ') }),
      confirmLabel: t('automation.confirm.grant_label'),
      isDangerous: true,
    });
    if (!ok) return;
    setBusy(true);
    try { await callRpc('orchestrator.run.grant', { id: run.id, methods }); toast.success(t('automation.toast.run_granted', { id: run.id })); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const abortRun = async (run: RunRow) => {
    const ok = await confirm({
      title: t('automation.confirm.abort_title', { id: run.id }),
      message: t('automation.confirm.abort_message'),
      confirmLabel: t('automation.confirm.abort_label'),
      isDangerous: true,
    });
    if (!ok) return;
    setBusy(true);
    try { await callRpc('orchestrator.run.abort', { id: run.id, reason: t('automation.abort_reason') }); toast.success(t('automation.toast.run_aborted', { id: run.id })); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  // Crash recovery: re-drive a STALLED run (orchestrator.run.retry, STALLED-only). Re-runs
  // from the top; committed steps dedup via their idempotency key. Confirm (not dangerous —
  // a recovery action — but the message states the at-least-once caveat).
  const retryRun = async (runId: string) => {
    const ok = await confirm({
      title: t('automation.confirm.retry_title', { id: runId }),
      message: t('automation.confirm.retry_message'),
      confirmLabel: t('automation.confirm.retry_label'),
    });
    if (!ok) return;
    setBusy(true);
    try { await callRpc('orchestrator.run.retry', { id: runId }); toast.success(t('automation.toast.run_retried', { id: runId })); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const ackAlert = async (id: string) => {
    setBusy(true);
    try { await callRpc('notification.inbox.ack', { ids: [id] }); toast.success(t('automation.toast.alert_dismissed')); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const retryDlqEntry = async (id: string) => {
    setBusy(true);
    try { await callRpc('nexus.dlq.retry', { id }); toast.success(t('automation.toast.dlq_reemitted')); await refresh(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const requeueNotif = async (messageId: string) => {
    setBusy(true);
    try {
      const r = await callRpc<{ requeued: number; exhausted?: number }>('notification.deadletter.requeue', { messageId });
      if (r.requeued > 0) toast.success(t('automation.toast.requeued', { n: r.requeued }));
      else toast.error(t('automation.toast.requeue_exhausted'));
      await refresh();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const anyPaused = status?.anyPaused ?? false;
  const allPaused = status?.allPaused ?? false;

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center px-5 py-3 border-b border-border bg-white/[0.01] shrink-0">
        <div className="font-mono text-[13px] uppercase tracking-wider text-accent">{t('automation.title')}</div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading || busy}>↻ {t('automation.refresh')}</Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
        {/* Master status */}
        <div className={`border rounded-lg p-5 flex items-center justify-between ${anyPaused ? 'border-warning bg-warning/5' : 'border-success bg-success/5'}`}>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">{t('automation.system_automation')}</div>
            <div className={`font-mono text-xl font-bold ${anyPaused ? 'text-warning' : 'text-success'}`}>
              {allPaused ? `⏸  ${t('automation.state.paused_manual')}` : anyPaused ? `◐  ${t('automation.state.partially_paused')}` : `▶  ${t('automation.state.running_auto')}`}
            </div>
            <div className="text-[11px] text-text-secondary mt-1">{t('automation.master_hint')}</div>
          </div>
          <div className="flex gap-2">
            <Button variant="danger" onClick={pauseAll} disabled={busy || allPaused}>{t('automation.btn.pause_all')}</Button>
            <Button variant="success" onClick={resumeAll} disabled={busy || !anyPaused}>{t('automation.btn.resume_all')}</Button>
          </div>
        </div>

        {/* Per-service */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('automation.per_service')}</div>
          <div className="flex flex-col gap-2">
            {status && Object.entries(status.services).map(([svc, s]) => (
              <div key={svc} className="flex items-center justify-between border border-border rounded px-4 py-3 bg-bg-secondary">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${s.paused ? 'bg-warning' : 'bg-success'}`} />
                  <span className="font-mono text-[13px]">{SERVICE_LABEL_KEYS[svc] ? t(SERVICE_LABEL_KEYS[svc]) : svc}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 border rounded font-mono ${s.paused ? 'text-warning border-warning' : 'text-success border-success'}`}>
                    {s.paused ? t('automation.badge.paused') : t('automation.badge.running')}
                  </span>
                </div>
                <Button variant={s.paused ? 'success' : 'danger'} size="sm" onClick={() => toggleService(svc, s.paused)} disabled={busy}>
                  {s.paused ? t('automation.btn.resume') : t('automation.btn.pause')}
                </Button>
              </div>
            ))}
            {!status && !loading && <div className="text-text-secondary text-sm">{t('automation.no_status')}</div>}
          </div>
        </div>

        {/* At a glance */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('automation.glance_title')}</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label={t('automation.glance.sentinels')} value={`${glance.online}/${glance.sentinels}`} sub={t('automation.glance.sentinels_sub')} />
            <Stat label={t('automation.glance.schedules')} value={glance.schedules} />
            <Stat label={t('automation.glance.nexus_dlq')} value={glance.dlq} warn={glance.dlq > 0} sub={t('automation.glance.nexus_dlq_sub')} />
            <Stat label={t('automation.glance.paused_runs')} value={glance.pausedRuns} warn={glance.pausedRuns > 0} sub={t('automation.glance.paused_runs_sub')} />
            <Stat label={t('automation.glance.mode')} value={anyPaused ? t('automation.mode.manual') : t('automation.mode.auto')} warn={anyPaused} />
          </div>
        </div>

        {/* Runs needing a human (toFix §6.7) */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">
            {t('automation.runs_title')} {attentionRuns.length > 0 && <span className="text-warning">({attentionRuns.length})</span>}
          </div>
          <div className="flex flex-col gap-2">
            {attentionRuns.length === 0 && <div className="text-text-secondary text-sm">{t('automation.runs_empty')}</div>}
            {attentionRuns.map((run) => (
              <div key={run.id} className="border border-border rounded bg-bg-secondary">
                <div className="flex items-center justify-between px-4 py-3 cursor-pointer"
                     onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 border rounded font-mono shrink-0 ${STATUS_BADGE[run.status] || 'text-text-secondary border-border'}`}>
                      {run.status}
                    </span>
                    <span className="font-mono text-[13px] truncate">{run.workflowId}{run.workflowVersion ? ` · v${run.workflowVersion}` : ''}</span>
                    <span className="text-[11px] text-text-secondary font-mono truncate">{run.id}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {run.status === 'PAUSED_AWAITING_HUMAN' && (
                      <>
                        <Button variant="success" size="sm" disabled={busy} onClick={(e: any) => { e.stopPropagation(); grantRun(run); }}>{t('automation.btn.grant')}</Button>
                        <Button variant="danger" size="sm" disabled={busy} onClick={(e: any) => { e.stopPropagation(); abortRun(run); }}>{t('automation.btn.abort')}</Button>
                      </>
                    )}
                    {run.status === 'STALLED' && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={(e: any) => { e.stopPropagation(); retryRun(run.id); }}>{t('automation.btn.retry_run')}</Button>
                    )}
                    <span className="text-text-secondary text-xs">{expandedRun === run.id ? '▾' : '▸'}</span>
                  </div>
                </div>
                {expandedRun === run.id && (
                  <div className="border-t border-border px-4 py-3 text-[12px] flex flex-col gap-2">
                    {run.status === 'PAUSED_AWAITING_HUMAN' && (
                      <div>
                        <span className="text-text-secondary">{t('automation.detail.missing_methods')} </span>
                        <span className="font-mono text-warning">{(run.missingMethods || []).join(', ') || '—'}</span>
                        <span className="text-text-secondary"> · {t('automation.detail.paused_at', { time: ts(run.pausedAt) })}</span>
                      </div>
                    )}
                    {run.status === 'FAILED' && (
                      <>
                        <div>
                          <span className="text-text-secondary">{t('automation.detail.failed_step')} </span>
                          <span className="font-mono text-danger">{run.failedStep || '—'}</span>
                          <span className="text-text-secondary"> · {ts(run.failedAt)} · </span>
                          <span className="font-mono">{run.lastError || ''}</span>
                        </div>
                        <div>
                          <div className="text-text-secondary mb-1">{t('automation.detail.committed_steps', { n: (run.cleanupManifest || []).length })}</div>
                          {(run.cleanupManifest || []).length === 0
                            ? <div className="text-text-secondary">{t('automation.detail.no_committed_steps')}</div>
                            : (
                              <table className="w-full text-left text-[11px] font-mono">
                                <thead><tr className="text-text-secondary">
                                  <th className="pr-3 font-normal">{t('automation.table.step')}</th><th className="pr-3 font-normal">{t('automation.table.method')}</th>
                                  <th className="pr-3 font-normal">{t('automation.table.result')}</th><th className="font-normal">{t('automation.table.compensate_hint')}</th>
                                </tr></thead>
                                <tbody>
                                  {(run.cleanupManifest || []).map((c) => (
                                    <tr key={c.id} className="align-top">
                                      <td className="pr-3">{c.id}</td>
                                      <td className="pr-3">{c.method}</td>
                                      <td className="pr-3 max-w-[260px] truncate" title={c.result_summary || ''}>{c.result_summary || '—'}</td>
                                      <td className="max-w-[260px] truncate" title={c.compensate ? JSON.stringify(c.compensate) : ''}>
                                        {c.compensate ? JSON.stringify(c.compensate) : t('automation.table.none_declared')}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                        </div>
                        {/* Saga rollback outcome — what was undone (reverse order) + what failed */}
                        {run.compensation && (
                          <div>
                            <div className="text-text-secondary mb-1">{t('automation.detail.compensation_title')}</div>
                            <div className="text-[11px] mb-1">
                              {!run.compensation.ran
                                ? <span className="text-text-secondary">{t('automation.detail.compensation_none')}</span>
                                : run.compensation.failed
                                  ? <span className="text-danger">{t('automation.detail.compensation_failed')}</span>
                                  : <span className="text-success">{t('automation.detail.compensation_clean', { n: (run.compensation.entries || []).length })}</span>}
                            </div>
                            {(run.compensation.entries || []).length > 0 && (
                              <table className="w-full text-left text-[11px] font-mono">
                                <thead><tr className="text-text-secondary">
                                  <th className="pr-3 font-normal">{t('automation.table.comp_for')}</th>
                                  <th className="pr-3 font-normal">{t('automation.table.comp_via')}</th>
                                  <th className="font-normal">{t('automation.table.comp_status')}</th>
                                </tr></thead>
                                <tbody>
                                  {(run.compensation.entries || []).map((c, i) => (
                                    <tr key={`${c.forStep}-${i}`} className="align-top">
                                      <td className="pr-3">{c.forStep}</td>
                                      <td className="pr-3 max-w-[260px] truncate" title={c.method || ''}>{c.method || c.compensate || '—'}</td>
                                      <td className={c.status === 'failed' ? 'text-danger' : 'text-success'} title={c.error || ''}>
                                        {c.status === 'failed' ? t('automation.table.comp_err') : t('automation.table.comp_ok')}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {run.status === 'STALLED' && (
                      <div className="text-text-secondary">
                        {t('automation.detail.stalled', { started: ts(run.startedAt), flagged: ts(run.stalledAt) })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Ops alert inbox — the stall scanner + grant-needed paths post here (targetId 'ops') */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">
            {t('automation.ops_title')} {opsAlerts.length > 0 && <span className="text-warning">({opsAlerts.length})</span>}
          </div>
          <div className="flex flex-col gap-2">
            {opsAlerts.length === 0 && <div className="text-text-secondary text-sm">{t('automation.ops_empty')}</div>}
            {opsAlerts.map((a) => {
              const runId = a.payload?.runId;
              const committed: any[] = a.payload?.committedSteps || [];
              const isStalled = a.type === 'ops.run_stalled';
              return (
                <div key={a.id} className="flex items-center justify-between border border-border rounded px-3 py-2 bg-bg-secondary">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] truncate">
                      <span className="text-warning">{isStalled ? t('automation.ops_run_stalled') : a.type}</span>
                      {runId ? <span className="text-text-secondary"> · {runId}</span> : null}
                      {a.payload?.workflowId ? <span className="text-text-secondary"> · {a.payload.workflowId}</span> : null}
                    </div>
                    <div className="text-[10px] text-text-secondary truncate" title={a.payload?.hint || ''}>
                      {committed.length > 0 ? `${committed.length} ${t('automation.ops_committed')}` : ''}{a.payload?.hint ? ` · ${a.payload.hint}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isStalled && runId && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => retryRun(runId)}>{t('automation.btn.retry_run')}</Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => ackAlert(a.id)}>{t('automation.btn.ack')}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Dead-letter drill-downs (toFix §6.7) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('automation.nexus_dlq_title')}</div>
            <div className="flex flex-col gap-1">
              {nexusDlq.length === 0 && <div className="text-text-secondary text-sm">{t('automation.empty')}</div>}
              {nexusDlq.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between border border-border rounded px-3 py-2 bg-bg-secondary">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] truncate">{d.sourceStream || d.stream || '—'} · {d.agentId || d.sentinelId || ''}</div>
                    <div className="text-[10px] text-text-secondary font-mono truncate" title={d.reason || ''}>{d.id} {d.reason ? `· ${d.reason}` : ''}</div>
                  </div>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => retryDlqEntry(d.id)}>{t('automation.btn.retry')}</Button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('automation.notif_dlq_title')}</div>
            <div className="flex flex-col gap-1">
              {notifDlq.length === 0 && <div className="text-text-secondary text-sm">{t('automation.empty')}</div>}
              {notifDlq.map((d: any, i: number) => (
                <div key={`${d.messageId || 'msg'}-${i}`} className="flex items-center justify-between border border-border rounded px-3 py-2 bg-bg-secondary">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] truncate">{d.channel || '—'} · {d.messageId || '—'}</div>
                    <div className="text-[10px] text-text-secondary font-mono truncate" title={d.lastError || ''}>
                      {d.permanent ? `${t('automation.notif.permanent')} · ` : ''}{d.lastError || ''} {d.requeues ? `· ${t('automation.notif.requeued_count', { n: d.requeues })}` : ''}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" disabled={busy || !d.messageId} onClick={() => requeueNotif(d.messageId)}>{t('automation.btn.requeue')}</Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
