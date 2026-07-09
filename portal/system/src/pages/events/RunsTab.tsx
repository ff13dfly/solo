import { useState, useEffect, useCallback, useMemo } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../utils/format';
import type { Run, RunStatus } from './types';
import { runStatusBadge } from './utils';

export default function RunsTab() {
  const { toast } = useUI();
  const { t } = useLang();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [rawRun, setRawRun] = useState<Run | null>(null);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callRpc<Run[]>('orchestrator.run.list', statusFilter ? { status: statusFilter } : {});
      setRuns(result || []);
    } catch (err: any) {
      setError(err.message || t('event_mgmt.runs_load_failed'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const handleGrant = async (run: Run) => {
    setActionInProgress(run.id);
    try {
      await callRpc('orchestrator.run.grant', { id: run.id, methods: run.missingMethods || [] });
      toast.success(t('event_mgmt.run_granted', { id: run.id }));
      fetchRuns();
    } catch (err: any) {
      toast.error(err.message || t('event_mgmt.grant_failed'));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleAbort = async (run: Run) => {
    setActionInProgress(run.id);
    try {
      await callRpc('orchestrator.run.abort', { id: run.id });
      toast.success(t('event_mgmt.run_aborted', { id: run.id }));
      fetchRuns();
    } catch (err: any) {
      toast.error(err.message || t('event_mgmt.abort_failed'));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRetry = async (run: Run) => {
    setActionInProgress(run.id);
    try {
      await callRpc('orchestrator.run.retry', { id: run.id });
      toast.success(t('event_mgmt.run_retried', { id: run.id }));
      fetchRuns();
    } catch (err: any) {
      toast.error(err.message || t('event_mgmt.retry_failed'));
    } finally {
      setActionInProgress(null);
    }
  };

  const toggleTrace = (trace: string) => {
    setExpandedTraces(prev => {
      const next = new Set(prev);
      if (next.has(trace)) {
        next.delete(trace);
      } else {
        next.add(trace);
      }
      return next;
    });
  };

  // Group runs by trace ID
  const groupedRuns = useMemo(() => {
    const traceMap: Record<string, Run[]> = {};
    runs.forEach(run => {
      const tId = run.trace;
      if (tId) {
        if (!traceMap[tId]) traceMap[tId] = [];
        traceMap[tId].push(run);
      }
    });

    const chains: { trace: string; runs: Run[]; startedAt: number; status: string }[] = [];
    const singles: Run[] = [];
    const chainRunIds = new Set<string>();

    Object.entries(traceMap).forEach(([trace, groupRuns]) => {
      if (groupRuns.length > 1) {
        groupRuns.sort((a, b) => a.startedAt - b.startedAt);
        
        let chainStatus = 'DONE';
        if (groupRuns.some(r => r.status === 'FAILED' || r.status === 'DEADLETTER')) {
          chainStatus = 'FAILED';
        } else if (groupRuns.some(r => r.status === 'RUNNING' || r.status === 'RESUMING')) {
          chainStatus = 'RUNNING';
        } else if (groupRuns.some(r => r.status === 'STALLED')) {
          chainStatus = 'STALLED';
        } else if (groupRuns.some(r => r.status === 'PAUSED_AWAITING_HUMAN')) {
          chainStatus = 'PAUSED_AWAITING_HUMAN';
        } else if (groupRuns.some(r => r.status === 'ABORTED')) {
          chainStatus = 'ABORTED';
        }

        chains.push({
          trace,
          runs: groupRuns,
          startedAt: groupRuns[0].startedAt,
          status: chainStatus
        });

        groupRuns.forEach(r => chainRunIds.add(r.id));
      }
    });

    runs.forEach(run => {
      if (!chainRunIds.has(run.id)) {
        singles.push(run);
      }
    });

    const items: (
      | { type: 'chain'; id: string; trace: string; runs: Run[]; startedAt: number; status: string }
      | { type: 'single'; id: string; run: Run; startedAt: number }
    )[] = [];

    chains.forEach(c => {
      items.push({ type: 'chain', id: c.trace, ...c });
    });
    singles.forEach(r => {
      items.push({ type: 'single', id: r.id, run: r, startedAt: r.startedAt });
    });

    items.sort((a, b) => b.startedAt - a.startedAt);
    return items;
  }, [runs]);

  const STATUS_OPTIONS = ['', 'RUNNING', 'DONE', 'FAILED', 'STALLED', 'PAUSED_AWAITING_HUMAN', 'RESUMING', 'ABORTED', 'DEADLETTER'];

  return (
    <>
      {/* Toolbar */}
      <div className="flex justify-between px-4 py-2 border-b border-border bg-white/[0.01] shrink-0">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-bg-primary border border-border rounded-md px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
        >
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s || t('event_mgmt.all_statuses')}</option>
          ))}
        </select>
        <button
          onClick={fetchRuns}
          disabled={loading}
          className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
        >
          {t('event_mgmt.refresh')}
        </button>
      </div>

      {error && <div className="p-4 text-error text-[13px]">{t('event_mgmt.error_prefix')}: {error}</div>}

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('event_mgmt.loading')}</div>}

        {groupedRuns.map(item => {
          if (item.type === 'single') {
            const run = item.run;
            return (
              <div
                key={run.id}
                className="grid px-5 border-b border-border hover:bg-white/[0.02] items-center transition-colors min-h-[52px] py-2"
                style={{ gridTemplateColumns: '2fr 2fr 1.5fr 1.2fr 0.8fr 2.5fr' }}
              >
                <div className="font-mono text-[11px] text-accent truncate" title={run.id}>
                  {run.id}
                </div>
                <div className="font-mono text-[11px] text-text-secondary truncate" title={run.workflowId}>
                  {run.workflowId || '—'}
                </div>
                <div className="text-[11px] text-text-secondary">
                  {formatDate(run.startedAt)}
                </div>
                <div>
                  <span className={runStatusBadge(run.status)}>{run.status}</span>
                </div>
                <div className="text-[11px] text-text-secondary">{run.attempts ?? 0}</div>
                <div className="flex gap-2 items-center flex-wrap">
                  <button
                    className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                    onClick={() => setRawRun(run)}
                  >
                    {t('event_mgmt.raw')}
                  </button>
                  {run.status === 'PAUSED_AWAITING_HUMAN' && (
                    <>
                      <button
                        className="bg-success/10 border border-success/40 text-success rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-success hover:text-white transition-all disabled:opacity-50"
                        onClick={() => handleGrant(run)}
                        disabled={actionInProgress === run.id}
                        title={t('event_mgmt.grant_methods_title', { methods: (run.missingMethods || []).join(', ') })}
                      >
                        {actionInProgress === run.id ? '...' : t('event_mgmt.grant')}
                      </button>
                      <button
                        className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-error hover:text-white transition-all disabled:opacity-50"
                        onClick={() => handleAbort(run)}
                        disabled={actionInProgress === run.id}
                      >
                        {actionInProgress === run.id ? '...' : t('event_mgmt.abort')}
                      </button>
                    </>
                  )}
                  {run.status === 'STALLED' && (
                    <button
                      className="bg-accent/10 border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-accent hover:text-white transition-all disabled:opacity-50"
                      onClick={() => handleRetry(run)}
                      disabled={actionInProgress === run.id}
                      title={t('event_mgmt.retry_title')}
                    >
                      {actionInProgress === run.id ? '...' : t('event_mgmt.retry')}
                    </button>
                  )}
                  {run.status === 'PAUSED_AWAITING_HUMAN' && run.missingMethods && run.missingMethods.length > 0 && (
                    <span className="text-[10px] text-warning font-mono truncate" title={run.missingMethods.join(', ')}>
                      {t('event_mgmt.needs_prefix')}: {run.missingMethods.slice(0, 2).join(', ')}{run.missingMethods.length > 2 ? '…' : ''}
                    </span>
                  )}
                  {(run.status === 'FAILED' || run.status === 'STALLED' || run.status === 'DEADLETTER') && run.lastError && (
                    <span
                      className="text-[10px] text-error/70 font-mono truncate"
                      data-test="run-error"
                      title={`${run.failedStep ? t('event_mgmt.step_prefix', { step: run.failedStep }) : ''}${run.lastError}`}
                    >
                      {run.failedStep ? `[${run.failedStep}] ` : ''}{run.lastError.slice(0, 60)}
                    </span>
                  )}
                </div>
              </div>
            );
          } else {
            const isExpanded = expandedTraces.has(item.trace);
            return (
              <div key={item.trace} className="border-b border-border bg-white/[0.005]">
                {/* Chain Header */}
                <div
                  onClick={() => toggleTrace(item.trace)}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.015] cursor-pointer transition-colors select-none"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-text-secondary text-[9px] w-3">
                      {isExpanded ? '▼' : '▶'}
                    </span>
                    <span className="font-mono text-[11px] text-accent font-bold" title={item.trace}>
                      TRACE: {item.trace}
                    </span>
                    <span className="text-[9px] bg-accent/10 border border-accent/20 text-accent px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider">
                      {item.runs.length} Tasks
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[11px] text-text-secondary">
                      {formatDate(item.startedAt)}
                    </span>
                    <span className={runStatusBadge(item.status as RunStatus)}>{item.status}</span>
                  </div>
                </div>

                {/* Chain Expanded Runs */}
                {isExpanded && (
                  <div className="bg-black/10 pl-8 pr-5 py-2.5 border-t border-dashed border-border flex flex-col gap-1.5 relative">
                    {/* Vertical timeline line */}
                    <div className="absolute left-[26px] top-0 bottom-0 w-[1px] border-l border-dashed border-accent/20" />
                    
                    {item.runs.map((run) => {
                      const offsetMs = run.startedAt - item.startedAt;
                      const offsetStr = offsetMs > 0 ? `+${(offsetMs / 1000).toFixed(2)}s` : 'trigger';
                      return (
                        <div key={run.id} className="relative flex items-center justify-between py-1 min-h-[38px] group">
                          {/* Timeline dot */}
                          <div className="absolute left-[-21px] top-[15px] w-2 h-2 rounded-full bg-accent border border-bg-primary z-10" />
                          
                          <div className="flex items-center gap-3 flex-1 min-w-0 pr-4">
                            <span className="font-mono text-[10px] text-text-secondary w-14 shrink-0 font-medium">{offsetStr}</span>
                            <span className="font-mono text-[10px] text-accent truncate max-w-[100px]" title={run.id}>{run.id}</span>
                            <span className="text-text-primary text-[11px] font-medium truncate max-w-[180px]" title={run.workflowId}>{run.workflowId || '—'}</span>
                            <span className="text-[10px] text-text-secondary font-mono">{formatDate(run.startedAt)}</span>
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <span className={runStatusBadge(run.status)}>{run.status}</span>
                            <div className="flex gap-1.5 items-center">
                              <button
                                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                                onClick={(e) => { e.stopPropagation(); setRawRun(run); }}
                              >
                                {t('event_mgmt.raw')}
                              </button>
                              {run.status === 'PAUSED_AWAITING_HUMAN' && (
                                <>
                                  <button
                                    className="bg-success/10 border border-success/40 text-success rounded-md px-2 py-1 text-[10px] font-medium hover:bg-success hover:text-white transition-all disabled:opacity-50"
                                    onClick={(e) => { e.stopPropagation(); handleGrant(run); }}
                                    disabled={actionInProgress === run.id}
                                    title={t('event_mgmt.grant_methods_title', { methods: (run.missingMethods || []).join(', ') })}
                                  >
                                    {actionInProgress === run.id ? '...' : t('event_mgmt.grant')}
                                  </button>
                                  <button
                                    className="bg-error/10 border border-error/40 text-error rounded-md px-2 py-1 text-[10px] font-medium hover:bg-error hover:text-white transition-all disabled:opacity-50"
                                    onClick={(e) => { e.stopPropagation(); handleAbort(run); }}
                                    disabled={actionInProgress === run.id}
                                  >
                                    {actionInProgress === run.id ? '...' : t('event_mgmt.abort')}
                                  </button>
                                </>
                              )}
                              {run.status === 'STALLED' && (
                                <button
                                  className="bg-accent/10 border border-accent/40 text-accent rounded-md px-2 py-1 text-[10px] font-medium hover:bg-accent hover:text-white transition-all disabled:opacity-50"
                                  onClick={(e) => { e.stopPropagation(); handleRetry(run); }}
                                  disabled={actionInProgress === run.id}
                                  title={t('event_mgmt.retry_title')}
                                >
                                  {actionInProgress === run.id ? '...' : t('event_mgmt.retry')}
                                </button>
                              )}
                              {(run.status === 'FAILED' || run.status === 'STALLED' || run.status === 'DEADLETTER') && run.lastError && (
                                <span
                                  className="text-[9px] text-error/70 font-mono truncate max-w-[200px]"
                                  data-test="run-error"
                                  title={`${run.failedStep ? t('event_mgmt.step_prefix', { step: run.failedStep }) : ''}${run.lastError}`}
                                >
                                  {run.failedStep ? `[${run.failedStep}] ` : ''}{run.lastError}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
        })}

        {!loading && runs.length === 0 && (
          <div className="p-6 text-center opacity-50 text-[13px]">
            {statusFilter ? t('event_mgmt.empty_runs_filtered', { status: statusFilter }) : t('event_mgmt.empty_runs')}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex items-center shrink-0">
        <span className="text-xs text-text-secondary">{t('event_mgmt.total')}: {runs.length}{statusFilter ? ` · ${t('event_mgmt.filter_label')}: ${statusFilter}` : ''}</span>
      </div>

      {/* RAW Modal */}
      <Modal
        isOpen={!!rawRun}
        onClose={() => setRawRun(null)}
        title={t('event_mgmt.modal_raw_run_title', { id: rawRun?.id || '' })}
        size="lg"
        footer={<Button onClick={() => setRawRun(null)}>{t('event_mgmt.close')}</Button>}
      >
        <pre className="bg-bg-primary p-4 rounded-md text-xs font-mono overflow-auto border border-border text-text-secondary h-[60vh]">
          {rawRun && JSON.stringify(rawRun, null, 2)}
        </pre>
      </Modal>
    </>
  );
}
