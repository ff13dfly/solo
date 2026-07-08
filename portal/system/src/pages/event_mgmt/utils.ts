import type { RunStatus } from './types';

export function runStatusBadge(status: RunStatus) {
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

export function msToHuman(ms: number | null): string {
  if (!ms) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
