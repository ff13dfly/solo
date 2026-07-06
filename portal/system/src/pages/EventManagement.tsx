import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import { fetchKnownStreams } from '../utils/streamCatalog';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { formatDate } from '../utils/format';

type Tab = 'schedules' | 'runs' | 'stream' | 'format';

interface ScheduleAction {
  kind: 'run_command' | 'emit_event';
  workflow_id?: string;
  stream?: string;
  type?: string;
}

interface Schedule {
  schedule_id: string;
  fire_at: number;
  recurrence_ms: number | null;
  action: ScheduleAction;
  enabled: boolean;
  owner: string | null;
  created_at: number;
  last_fired_at: number | null;
}

type RunStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'STALLED' | 'PAUSED_AWAITING_HUMAN' | 'RESUMING' | 'ABORTED' | 'DEADLETTER';

interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: number;
  enqueuedAt: number;
  attempts: number;
  triggerSource?: string;
  missingMethods?: string[];
  failedStep?: string;
  lastError?: string;
  abortReason?: string;
  doneAt?: number;
  pausedAt?: number;
}

const defaultForm = {
  schedule_id: '',
  fire_at: '',
  recurrence_ms: '',
  action_kind: 'run_command' as 'run_command' | 'emit_event',
  workflow_id: '',
  stream: '',
  event_type: '',
  enabled: true,
};

function runStatusBadge(status: RunStatus) {
  const map: Record<RunStatus, string> = {
    RUNNING:                'border-accent/40 text-accent bg-accent/10',
    DONE:                   'border-success/40 text-success bg-success/10',
    FAILED:                 'border-error/40 text-error bg-error/10',
    STALLED:                'border-warning/40 text-warning bg-warning/10',
    PAUSED_AWAITING_HUMAN:  'border-warning/40 text-warning bg-warning/10',
    RESUMING:               'border-accent/30 text-accent/70 bg-accent/5',
    ABORTED:                'border-border text-text-secondary bg-white/5',
    DEADLETTER:             'border-error/40 text-error bg-error/10',
  };
  return `text-[10px] px-1.5 py-0.5 border rounded font-mono ${map[status] || ''}`;
}

function msToHuman(ms: number | null): string {
  if (!ms) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// ─── Schedules Tab ────────────────────────────────────────────────────────────

function SchedulesTab() {
  const { toast, confirm } = useUI();
  const { t } = useLang();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(defaultForm);
  const [creating, setCreating] = useState(false);
  const [knownStreams, setKnownStreams] = useState<string[]>([]);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callRpc<Schedule[]>('nexus.schedule.list', {});
      setSchedules(result || []);
    } catch (err: any) {
      setError(err.message || t('event_mgmt.schedules_load_failed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSchedules(); }, [fetchSchedules]);
  useEffect(() => { fetchKnownStreams().then(setKnownStreams).catch(() => {}); }, []);

  const handleCreate = async () => {
    if (!form.schedule_id.trim()) return toast.error(t('event_mgmt.err_schedule_id_required'));
    if (!form.fire_at) return toast.error(t('event_mgmt.err_fire_at_required'));
    if (form.action_kind === 'run_command' && !form.workflow_id.trim()) return toast.error(t('event_mgmt.err_workflow_id_required'));
    if (form.action_kind === 'emit_event' && !form.stream.trim()) return toast.error(t('event_mgmt.err_stream_key_required'));

    const action: ScheduleAction = form.action_kind === 'run_command'
      ? { kind: 'run_command', workflow_id: form.workflow_id.trim() }
      : { kind: 'emit_event', stream: form.stream.trim(), type: form.event_type.trim() || undefined };

    setCreating(true);
    try {
      await callRpc('nexus.schedule.create', {
        schedule_id: form.schedule_id.trim(),
        fire_at: new Date(form.fire_at).getTime(),
        recurrence_ms: form.recurrence_ms ? Number(form.recurrence_ms) : null,
        action,
        enabled: form.enabled,
      });
      toast.success(t('event_mgmt.schedule_created', { id: form.schedule_id }));
      setShowCreate(false);
      setForm(defaultForm);
      fetchSchedules();
    } catch (err: any) {
      toast.error(err.message || t('event_mgmt.create_failed'));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (schedule_id: string) => {
    const ok = await confirm({ message: t('event_mgmt.confirm_delete_schedule', { id: schedule_id }), confirmLabel: t('event_mgmt.delete'), isDangerous: true });
    if (!ok) return;
    try {
      await callRpc('nexus.schedule.delete', { schedule_id });
      toast.success(t('event_mgmt.schedule_deleted', { id: schedule_id }));
      fetchSchedules();
    } catch (err: any) {
      toast.error(err.message || t('event_mgmt.delete_failed'));
    }
  };

  return (
    <>
      {/* Toolbar */}
      <div className="flex justify-end px-4 py-2 border-b border-border bg-white/[0.01] shrink-0">
        <button
          onClick={() => setShowCreate(true)}
          className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
        >
          {t('event_mgmt.new_schedule')}
        </button>
      </div>

      {error && <div className="p-4 text-error text-[13px]">{t('event_mgmt.error_prefix')}: {error}</div>}

      {/* Column headers */}
      <div className="grid px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10"
        style={{ gridTemplateColumns: '2fr 2fr 1.2fr 2fr 0.8fr 1fr' }}>
        <div>{t('event_mgmt.col_schedule_id')}</div>
        <div>{t('event_mgmt.col_fire_at')}</div>
        <div>{t('event_mgmt.col_recurrence')}</div>
        <div>{t('event_mgmt.col_action')}</div>
        <div>{t('event_mgmt.col_enabled')}</div>
        <div>{t('event_mgmt.col_actions')}</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('event_mgmt.loading')}</div>}

        {schedules.map(s => (
          <div
            key={s.schedule_id}
            className="grid px-5 border-b border-border hover:bg-white/[0.02] items-center transition-colors min-h-[52px] py-2"
            style={{ gridTemplateColumns: '2fr 2fr 1.2fr 2fr 0.8fr 1fr' }}
          >
            <div className="font-mono text-[11px] text-accent truncate" title={s.schedule_id}>
              {s.schedule_id}
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="text-[12px]">{formatDate(s.fire_at)}</div>
              {s.last_fired_at && (
                <div className="text-[10px] text-text-secondary">{t('event_mgmt.last_fired_prefix')}: {formatDate(s.last_fired_at)}</div>
              )}
            </div>
            <div className="text-[11px] text-text-secondary">{msToHuman(s.recurrence_ms)}</div>
            <div className="flex flex-col gap-0.5">
              <span className={`text-[10px] px-1.5 py-0.5 border rounded self-start font-mono
                ${s.action.kind === 'run_command' ? 'border-accent/30 text-accent/70 bg-accent/5' : 'border-warning/30 text-warning bg-warning/5'}`}>
                {s.action.kind}
              </span>
              <span className="font-mono text-[10px] text-text-secondary truncate" title={s.action.workflow_id || s.action.stream}>
                {s.action.workflow_id || s.action.stream || '—'}
              </span>
            </div>
            <div>
              <span className={`inline-block w-2 h-2 rounded-full ${s.enabled ? 'bg-success' : 'bg-border'}`} />
            </div>
            <div>
              <button
                className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-error hover:text-white transition-all"
                onClick={() => handleDelete(s.schedule_id)}
              >
                {t('event_mgmt.delete')}
              </button>
            </div>
          </div>
        ))}

        {!loading && schedules.length === 0 && (
          <div className="p-6 text-center opacity-50 text-[13px]">
            {t('event_mgmt.empty_schedules_prefix')} <strong>{t('event_mgmt.new_schedule')}</strong> {t('event_mgmt.empty_schedules_suffix')}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex items-center shrink-0">
        <span className="text-xs text-text-secondary">{t('event_mgmt.total')}: {schedules.length}</span>
      </div>

      {/* Create Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => !creating && setShowCreate(false)}
        title={t('event_mgmt.modal_new_schedule_title')}
        size="md"
        footer={
          <>
            <Button onClick={() => setShowCreate(false)} variant="secondary" disabled={creating}>{t('event_mgmt.cancel')}</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? t('event_mgmt.creating') : t('event_mgmt.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_schedule_id')}</label>
            <input
              value={form.schedule_id}
              onChange={e => setForm(f => ({ ...f, schedule_id: e.target.value }))}
              placeholder="e.g. daily-report"
              className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_fire_at')}</label>
              <input
                type="datetime-local"
                value={form.fire_at}
                onChange={e => setForm(f => ({ ...f, fire_at: e.target.value }))}
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_recurrence_ms')}</label>
              <input
                type="number"
                value={form.recurrence_ms}
                onChange={e => setForm(f => ({ ...f, recurrence_ms: e.target.value }))}
                placeholder={t('event_mgmt.placeholder_recurrence')}
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_action_kind')}</label>
            <select
              value={form.action_kind}
              onChange={e => setForm(f => ({ ...f, action_kind: e.target.value as typeof f.action_kind }))}
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
            >
              <option value="run_command">{t('event_mgmt.option_run_command')}</option>
              <option value="emit_event">{t('event_mgmt.option_emit_event')}</option>
            </select>
          </div>

          {form.action_kind === 'run_command' && (
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_workflow_id')}</label>
              <input
                value={form.workflow_id}
                onChange={e => setForm(f => ({ ...f, workflow_id: e.target.value }))}
                placeholder="e.g. wf-daily-report"
                className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
              />
            </div>
          )}

          {form.action_kind === 'emit_event' && (
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_stream_key')}</label>
                <input
                  value={form.stream}
                  onChange={e => setForm(f => ({ ...f, stream: e.target.value }))}
                  placeholder="e.g. EVENT:DAILY:TICK"
                  list="sched-known-streams"
                  className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                />
                <datalist id="sched-known-streams">
                  {knownStreams.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
              <div className="flex-1">
                <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('event_mgmt.label_event_type')}</label>
                <input
                  value={form.event_type}
                  onChange={e => setForm(f => ({ ...f, event_type: e.target.value }))}
                  placeholder={t('event_mgmt.placeholder_optional')}
                  className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enabled"
              checked={form.enabled}
              onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              className="accent-[var(--color-accent)]"
            />
            <label htmlFor="enabled" className="text-[12px] text-text-primary cursor-pointer">{t('event_mgmt.enabled')}</label>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─── Runs Tab ─────────────────────────────────────────────────────────────────

function RunsTab() {
  const { toast } = useUI();
  const { t } = useLang();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [rawRun, setRawRun] = useState<Run | null>(null);

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
  }, [statusFilter]);

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

  // Crash recovery: re-drive a STALLED run (orchestrator.run.retry, STALLED-only). Re-runs
  // from the top; committed steps dedup via their idempotency key.
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

  // Mirrors the full run-status set the orchestrator actually writes (FAILED and the
  // at-most-once rescue status STALLED were missing — FAILED rows were unfilterable).
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

      {/* Column headers */}
      <div className="grid px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10"
        style={{ gridTemplateColumns: '2fr 2fr 1.5fr 1.2fr 0.8fr 2.5fr' }}>
        <div>{t('event_mgmt.col_run_id')}</div>
        <div>{t('event_mgmt.col_workflow')}</div>
        <div>{t('event_mgmt.col_started')}</div>
        <div>{t('event_mgmt.col_status')}</div>
        <div>{t('event_mgmt.col_attempts')}</div>
        <div>{t('event_mgmt.col_actions')}</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('event_mgmt.loading')}</div>}

        {runs.map(run => (
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
        ))}

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

// ─── Stream Log Tab ───────────────────────────────────────────────────────────

interface BusStream { key: string; length: number; lastId: string | null; lastAt: number | null }
interface BusEntry {
  id: string;
  at: number | null;
  type?: string;
  source?: string;
  actor?: string;
  trace_id?: string;
  [k: string]: unknown;
}

function StreamLogTab() {
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
  }, []);

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
  }, []);

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

// ─── Format Tab ───────────────────────────────────────────────────────────────

function Row({ cols, widths, header, dim }: {
  cols: React.ReactNode[];
  widths: string;
  header?: boolean;
  dim?: boolean;
}) {
  return (
    <div className={`grid px-4 items-start ${header ? 'py-2 bg-bg-secondary border-b-2 border-border' : `py-2.5 border-b border-border last:border-b-0 ${dim ? 'bg-white/[0.01]' : ''}`}`}
      style={{ gridTemplateColumns: widths }}>
      {cols.map((c, i) => (
        <div key={i} className={header ? 'text-[10px] font-bold text-accent uppercase tracking-wider' : 'text-[12px]'}>{c}</div>
      ))}
    </div>
  );
}

function Table({ headers, widths, rows }: {
  headers: string[];
  widths: string;
  rows: React.ReactNode[][];
}) {
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <Row cols={headers} widths={widths} header />
      {rows.map((r, i) => <Row key={i} cols={r} widths={widths} dim={i % 2 !== 0} />)}
    </div>
  );
}

const M  = ({ c }: { c: string }) => <span className="font-mono text-[11px] text-accent">{c}</span>;
const MG = ({ c }: { c: string }) => <span className="font-mono text-[11px] text-text-secondary">{c}</span>;
const T  = ({ c }: { c: string }) => <span className="font-mono text-[11px] text-warning/70">{c}</span>;

function FormatTab() {

  const ENVELOPE_EXAMPLE =
`// EVENT:WORKFLOW:RESULT 里的一条消息 —— 所有字段值均为字符串（Redis Stream 约束）
{
  "type":       "workflow.run.completed",   // 发生了什么。点分层级，生产者定义
  "source":     "orchestrator",             // 哪个服务发的。Router 认证，不可伪造
  "actor":      "cron:daily-report",        // 谁/什么导致的（provenance），见下方取值
  "trace_id":   "a3f9c1d2b4e50f61",         // 8字节 hex，贯穿调用链
  "event_id":   "b7e20f11d3c49a82",         // 8字节 hex，每条唯一，消费侧幂等 key
  "emitted_at": "1748880005432",            // String(Date.now())，⚠ 字符串非数字
  "payload":    "{\\"workflow_id\\":\\"wf-daily-report\\",\\"status\\":\\"completed\\"}"
  //            ↑ 业务数据，JSON.stringify 后的字符串，消费侧自动 parse。
  //              只装"这件事的数据"，不装触发来源、不装调度信息（那些在 actor / Schedule）。
}`;

  const SCHEDULE_EXAMPLE =
`// NEXUS:SCHEDULE:DEF:daily-report —— Redis JSON 文档（与上面的事件是两回事）
{
  "schedule_id":   "daily-report",
  "fire_at":       1748880000000,   // 下次触发绝对时刻 ms（= ZSet score）
  "recurrence_ms": 86400000,        // ★ 重复性只存在这里。null = 单次，> 0 = 每隔 N ms
  "action": { "kind": "run_command", "workflow_id": "wf-daily-report" },
  "enabled":       true,
  "last_fired_at": 1748793600000
}
// 触发后 scheduler：执行 action + （recurrence_ms != null）更新 fire_at 重新入 ZSet。
// "会不会再跑"是 Schedule 的属性，事件永远不携带、也无从携带。`;

  const CONSUMER_NOTE =
`// 消费侧（Matcher + Nexus Consumer）对 { / [ 开头的字段自动 JSON.parse
const event = parseEntry(message);
// event.payload → { workflow_id, status }

// 谁触发的？看 event.actor，不要去翻 payload：
const fromCron = event.actor.startsWith("cron:");   // 定时触发
// 要知道这个 cron 会不会再跑？拿 schedule_id 反查 Schedule 实体：
const id = event.actor.slice(5);                     // "daily-report"
// → nexus.schedule.get(id) → recurrence_ms != null ? 循环 : 单次`;

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-10">

      {/* ── 0. 三个正交概念（先立心智模型）── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">事件 = 一个已发生的事实</div>
        <div className="text-[11px] text-text-secondary mb-3">
          三件事各有归属，绝不混在一起。看不懂格式，多半是把下面三列搅成了一团。
        </div>
        <Table
          headers={['想知道什么', '答案在哪', '为什么不在事件里']}
          widths="1.6fr 2fr 3fr"
          rows={[
            ['发生了什么',      <>事件 <M c="type" /> + <M c="payload" /></>,                  '这就是事件本身'],
            ['谁/什么导致的',   <>事件 <M c="actor" /> 字段（信封层）</>,                       'provenance 是一等信封字段，不需翻 payload'],
            ['以后还跑不跑',    <>Schedule 实体 <M c="recurrence_ms" /></>,                     '事件是"过去式事实"，没有"未来会不会再发生"的概念'],
          ]}
        />
        <div className="mt-2 text-[10px] text-text-secondary leading-relaxed">
          ⚠ 单次任务和循环任务写出的事件信封<strong className="text-text-primary">完全一样</strong>。
          "是否定时触发"看 <span className="font-mono text-accent">actor</span> 前缀；
          "是否会再次触发"必须拿 schedule_id 反查 Schedule —— 事件层查不到，这是设计如此，不是缺陷。
        </div>
      </section>

      {/* ── 1. 标准信封 ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-3">1 · 标准信封（Event Envelope）</div>
        <pre className="bg-bg-primary border border-border rounded-md p-4 text-[12px] font-mono text-text-secondary leading-relaxed overflow-x-auto mb-4">
          {ENVELOPE_EXAMPLE}
        </pre>
        <div className="text-[11px] font-semibold text-text-primary mb-2">actor 取值规则（= provenance，由生产者声明，Router 盖戳）</div>
        <Table
          headers={['actor 值', '触发来源', '何时']}
          widths="1.6fr 1.8fr 3fr"
          rows={[
            [<MG c="uid-abc123" />,           '用户直接调用',    <>同步 <M c="workflow.run" />，actor = 登录 UID</>],
            [<MG c="cron:{schedule_id}" />,   'Nexus Scheduler', '定时任务触发，scheduler 经 event.emit 声明'],
            [<MG c="event:{stream}" />,       '事件链触发',      '被另一条事件匹配触发的 workflow'],
            [<MG c="{bot-name}" />,           'bot 主动发',      'relay bot 主动 event.emit 且未声明更具体来源'],
            [<MG c="system" />,               '兜底',            '无任何触发上下文'],
          ]}
        />
        <div className="mt-2 text-[10px] text-text-secondary">
          实现：<span className="font-mono">event.emit</span> 允许调用方声明 <span className="font-mono">actor</span>（Router 经 <span className="font-mono">trustEventActor</span> 采信），
          <span className="font-mono">source</span> 始终由 Router 认证不可伪造。Runner 写结果事件时 <span className="font-mono">actor = triggerSource</span>（cron/event）或 <span className="font-mono">callerUid</span>（sync）。
        </div>
      </section>

      {/* ── 2. Schedule 实体（重复性的唯一归属）── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">2 · 定时任务实体（Schedule）</div>
        <div className="text-[11px] text-text-secondary mb-3">
          与事件是两个独立对象。重复性只存在这里。存于 <span className="font-mono">NEXUS:SCHEDULE:DEF:{'{id}'}</span>，触发时间索引在 ZSet <span className="font-mono">NEXUS:SCHEDULE</span>（score = fire_at）。
        </div>
        <pre className="bg-bg-primary border border-border rounded-md p-4 text-[12px] font-mono text-text-secondary leading-relaxed overflow-x-auto mb-4">
          {SCHEDULE_EXAMPLE}
        </pre>
        <Table
          headers={['action.kind', '必填字段', '触发结果']}
          widths="1.2fr 2fr 3fr"
          rows={[
            [<T c="run_command" />, <M c="workflow_id" />,                  '推 run-command 进 orchestrator run-queue（点对点，不产生事件）'],
            [<T c="emit_event" />,  <><M c="stream" /> + <M c="type" /></>, '经 relay → Router → xAdd 写入目标流（actor = cron:{id}，广播）'],
          ]}
        />
        <div className="mt-2 text-[10px] text-text-secondary">
          注意：<span className="font-mono">run_command</span>（最常见）触发 workflow 时<strong className="text-text-primary">不发事件</strong>——直接进 run-queue。
          事件只在 workflow 跑完由 runner 产生，或显式 <span className="font-mono">emit_event</span> 才有。
        </div>
      </section>

      {/* ── 3. 内置 Streams ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">3 · 系统内置 Streams</div>
        <div className="text-[11px] text-text-secondary mb-3">由 Orchestrator Runner 自动写入。自定义命名建议：<span className="font-mono">EVENT:{'<DOMAIN>'}:{'<VERB>'}</span></div>
        <Table
          headers={['STREAM KEY', 'type', 'payload 字段（业务数据）']}
          widths="2.5fr 2fr 3fr"
          rows={[
            [<M c="EVENT:WORKFLOW:STATUS" />, <MG c="workflow.run.failed" />,    <MG c="workflow_id, status, failed_step, error" />],
            [<M c="EVENT:WORKFLOW:RESULT" />, <MG c="workflow.run.completed" />, <MG c="workflow_id, status" />],
          ]}
        />
      </section>

      {/* ── 4. 消费侧与路由 ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-3">4 · 消费侧行为与路由</div>
        <pre className="bg-bg-primary border border-border rounded-md p-4 text-[12px] font-mono text-text-secondary leading-relaxed overflow-x-auto mb-4">
          {CONSUMER_NOTE}
        </pre>
        <div className="flex flex-col gap-2">
          {([
            { from: 'Orchestrator Runner',   arrow: 'workflow 跑完 → xAdd(stream, envelope)', to: 'Redis Stream',               cls: 'border-accent/30' },
            { from: 'Nexus Scheduler',       arrow: 'emit_event → relay → Router → xAdd',     to: 'Redis Stream',               cls: 'border-accent/20' },
            { from: 'Nexus Stream Consumer', arrow: '匹配 Agent eventSubscriptions',          to: 'notification.send(agentId)', cls: 'border-success/30' },
            { from: 'Orchestrator Matcher',  arrow: '匹配 Workflow event_subscriptions',      to: 'run.enqueue(workflowId)',    cls: 'border-warning/30' },
          ] as const).map(r => (
            <div key={r.from} className={`grid items-center border ${r.cls} rounded-md px-4 py-2.5 bg-white/[0.01] text-[11px]`}
              style={{ gridTemplateColumns: '12rem 1fr 13rem' }}>
              <span className="font-mono text-accent">{r.from}</span>
              <span className="text-text-secondary">→ {r.arrow}</span>
              <span className="font-mono text-text-secondary text-right">{r.to}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 5. 已知偏差 ── */}
      <section>
        <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-1">5 · 已知偏差 / 遗留问题</div>
        <div className="text-[11px] text-text-secondary mb-3">实现与协议设计（event.md）尚存以下差异，开发时需知晓。</div>
        <Table
          headers={['问题', '影响', '建议处理']}
          widths="2fr 2fr 3fr"
          rows={[
            [
              <><span className="font-mono text-warning text-[11px]">recurrence_ms</span><span className="text-text-secondary text-[11px]"> vs cron 表达式</span></>,
              '只能固定步长，不能精确到"每天 02:00"',
              '如需绝对时刻，改 cron 表达式 + 解析器',
            ],
            [
              <span className="text-text-secondary text-[11px]">runner 直写 xAdd（绕过 Router）</span>,
              '不经 Router 认证/白名单，格式已标准化',
              '长期改为响应挂 _event；当前可接受',
            ],
            [
              <span className="text-text-secondary text-[11px]">流 trim（D10）未实现</span>,
              'Redis Stream 长期不裁剪无限增长',
              <span className="font-mono text-[11px]">xAdd MAXLEN ~ 10000</span>,
            ],
          ]}
        />
      </section>

    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function EventManagement() {
  const { t } = useLang();
  // Land on RUNS: it always has data and is what operators check first; SCHEDULES
  // is empty on a fresh dev boot and made the whole page read as "no content".
  const [tab, setTab] = useState<Tab>('runs');

  const TABS: { id: Tab; label: string }[] = [
    { id: 'schedules', label: t('event_mgmt.tab_schedules') },
    { id: 'runs',      label: t('event_mgmt.tab_runs') },
    { id: 'stream',    label: t('event_mgmt.tab_stream') },
    { id: 'format',    label: t('event_mgmt.tab_format') },
  ];

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex items-center shrink-0">
        <span>{t('event_mgmt.header')}</span>
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
        {tab === 'schedules' && <SchedulesTab />}
        {tab === 'runs'      && <RunsTab />}
        {tab === 'stream'    && <StreamLogTab />}
        {tab === 'format'    && <FormatTab />}
      </div>
    </div>
  );
}
