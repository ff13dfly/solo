import React, { useState, useEffect, useCallback } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import type { AutomationStatus, Glance } from '../../pages/automation/types';

const ATTENTION_STATUSES = ['PAUSED_AWAITING_HUMAN', 'FAILED', 'STALLED'] as const;
const SERVICE_LABEL_KEYS: Record<string, string> = {
  nexus: 'automation.service.nexus',
  orchestrator: 'automation.service.orchestrator',
};

function Stat({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className={`border rounded px-3 py-2 bg-bg-secondary ${warn ? 'border-warning' : 'border-border'}`}>
      <div className="text-[9px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`font-mono text-base font-bold ${warn ? 'text-warning' : 'text-text-primary'}`}>{value}</div>
      {sub && <div className="text-[9px] text-text-secondary">{sub}</div>}
    </div>
  );
}

export const AutomationPanel: React.FC = () => {
  const { toast, confirm } = useUI();
  const { t } = useLang();
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [glance, setGlance] = useState<Glance>({ sentinels: 0, online: 0, schedules: 0, dlq: 0, pausedRuns: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

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
    else toast.error(t('automation.toast.status_unavailable') || 'Automation status unavailable');

    const g: Glance = { sentinels: 0, online: 0, schedules: 0, dlq: 0, pausedRuns: 0 };
    if (sl.status === 'fulfilled') {
      g.sentinels = sl.value.total ?? (sl.value.items?.length || 0);
      g.online = (sl.value.items || []).filter((s: any) => s.online).length;
    }
    if (sc.status === 'fulfilled') g.schedules = (sc.value.items || []).length;
    if (dq.status === 'fulfilled') {
      g.dlq = dq.value.total ?? (dq.value.items?.length || 0);
    }

    let pausedCount = 0;
    rns.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const v: any = r.value;
      const items = Array.isArray(v) ? v : v?.items || [];
      pausedCount += items.filter((x: any) => x.status === 'PAUSED_AWAITING_HUMAN').length;
    });
    g.pausedRuns = pausedCount;

    setGlance(g);
    setLoading(false);
  }, [toast, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const pauseAll = async () => {
    const ok = await confirm({
      title: t('automation.confirm.pause_all_title'),
      message: t('automation.confirm.pause_all_message'),
      confirmLabel: t('automation.confirm.pause_all_label'),
      isDangerous: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await callRpc('setting.automation.pause');
      toast.success(t('automation.toast.paused_all'));
      await refresh();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const resumeAll = async () => {
    setBusy(true);
    try {
      await callRpc('setting.automation.resume');
      toast.success(t('automation.toast.resumed_all'));
      await refresh();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const toggleService = async (serviceId: string, currentlyPaused: boolean) => {
    setBusy(true);
    try {
      if (currentlyPaused) {
        await callRpc('setting.automation.resume', { serviceId });
        toast.success(t('automation.toast.resumed_svc', { name: serviceId }));
      } else {
        await callRpc('setting.automation.pause', { serviceId });
        toast.success(t('automation.toast.paused_svc', { name: serviceId }));
      }
      await refresh();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const anyPaused = status?.anyPaused ?? false;
  const allPaused = status?.allPaused ?? false;

  return (
    <Card
      title={
        <div className="flex items-center gap-3">
          <span>⚙️ AUTOMATION CONTROL</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
            status === null
              ? 'bg-text-secondary/15 text-text-secondary border-border'
              : anyPaused 
              ? 'bg-warning/15 text-warning border-warning/30' 
              : 'bg-success/15 text-success border-success/30'
          }`}>
            {status === null
              ? 'LOADING...'
              : allPaused 
              ? t('automation.badge.paused')?.toUpperCase() || 'PAUSED' 
              : anyPaused 
              ? t('automation.state.partially_paused')?.toUpperCase() || 'PARTIAL' 
              : t('automation.badge.running')?.toUpperCase() || 'RUNNING'
            }
          </span>
        </div>
      }
      headerAction={
        <div className="flex items-center gap-2">
          {!isCollapsed && (
            <button
              onClick={refresh}
              disabled={loading || busy}
              className="p-1 hover:bg-white/10 rounded transition-all text-text-secondary hover:text-text-primary disabled:opacity-50 cursor-pointer outline-none border-none bg-transparent"
              title={t('automation.refresh') || 'Refresh'}
            >
              <span className={`inline-block text-xs font-bold ${loading ? 'animate-spin' : ''}`}>↻</span>
            </button>
          )}
          <button
            onClick={() => {
              if (isCollapsed) {
                refresh();
              }
              setIsCollapsed(!isCollapsed);
            }}
            className="p-1 hover:bg-white/10 rounded transition-all cursor-pointer outline-none border-none text-text-secondary hover:text-text-primary bg-transparent"
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <svg
              className={`w-5 h-5 transition-transform duration-300 ${isCollapsed ? '-rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      }
    >
      {!isCollapsed && (
        <div className="p-4 flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
          {/* Master status */}
          <div className={`border rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${anyPaused ? 'border-warning bg-warning/5' : 'border-success bg-success/5'}`}>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-0.5">{t('automation.system_automation')}</div>
              <div className={`font-mono text-sm font-bold ${anyPaused ? 'text-warning' : 'text-success'}`}>
                {allPaused ? `⏸  ${t('automation.state.paused_manual')}` : anyPaused ? `◐  ${t('automation.state.partially_paused')}` : `▶  ${t('automation.state.running_auto')}`}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="danger" size="sm" onClick={pauseAll} disabled={busy || allPaused}>{t('automation.btn.pause_all')}</Button>
              <Button variant="success" size="sm" onClick={resumeAll} disabled={busy || !anyPaused}>{t('automation.btn.resume_all')}</Button>
            </div>
          </div>

          {/* Per-service */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5">{t('automation.per_service')}</div>
            <div className="flex flex-col gap-1.5">
              {status && Object.entries(status.services).map(([svc, s]) => (
                <div key={svc} className="flex items-center justify-between border border-border rounded px-3 py-2 bg-bg-secondary/40">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${s.paused ? 'bg-warning' : 'bg-success'}`} />
                    <span className="font-mono text-[11px]">{SERVICE_LABEL_KEYS[svc] ? t(SERVICE_LABEL_KEYS[svc]) : svc}</span>
                    <span className={`text-[9px] px-1 py-0.2 border rounded font-mono ${s.paused ? 'text-warning border-warning/30 bg-warning/5' : 'text-success border-success/30 bg-success/5'}`}>
                      {s.paused ? t('automation.badge.paused') : t('automation.badge.running')}
                    </span>
                  </div>
                  <Button variant={s.paused ? 'success' : 'danger'} size="sm" onClick={() => toggleService(svc, s.paused)} disabled={busy} className="!h-6 !px-2 !text-[10px]">
                    {s.paused ? t('automation.btn.resume') : t('automation.btn.pause')}
                  </Button>
                </div>
              ))}
              {!status && !loading && <div className="text-text-secondary text-xs italic">{t('automation.no_status')}</div>}
            </div>
          </div>

          {/* At a glance */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5">{t('automation.glance_title')}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label={t('automation.glance.sentinels')} value={`${glance.online}/${glance.sentinels}`} />
              <Stat label={t('automation.glance.schedules')} value={glance.schedules} />
              <Stat label={t('automation.glance.nexus_dlq')} value={glance.dlq} warn={glance.dlq > 0} />
              <Stat label={t('automation.glance.paused_runs')} value={glance.pausedRuns} warn={glance.pausedRuns > 0} />
              <Stat label={t('automation.glance.mode')} value={anyPaused ? t('automation.mode.manual') : t('automation.mode.auto')} warn={anyPaused} />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
