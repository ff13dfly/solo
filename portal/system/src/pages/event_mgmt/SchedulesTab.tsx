import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { fetchKnownStreams } from '../../utils/streamCatalog';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../utils/format';
import type { Schedule, ScheduleAction } from './types';
import { msToHuman } from './utils';

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

export default function SchedulesTab() {
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
  }, [t]);

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
