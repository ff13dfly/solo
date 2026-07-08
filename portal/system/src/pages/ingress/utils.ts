import type { Delivery } from './types';

export const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const OUTCOMES = ['', 'accepted', 'duplicate', 'unauthorized', 'disabled', 'invalid'] as const;

export function freshnessColor(ts: number | null): string {
  if (!ts) return 'bg-text-secondary/30';
  const age = Date.now() - ts;
  if (age < 60_000)  return 'bg-success';
  if (age < 300_000) return 'bg-warning';
  return 'bg-text-secondary/30';
}

export function ttlHuman(s: number): string {
  if (!s) return '—';
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

export function outcomeBadge(o: Delivery['outcome']): string {
  const map: Record<Delivery['outcome'], string> = {
    accepted:     'text-success border-success/40 bg-success/10',
    duplicate:    'text-warning border-warning/40 bg-warning/10',
    unauthorized: 'text-error border-error/40 bg-error/10',
    invalid:      'text-error/80 border-error/30 bg-error/5',
    disabled:     'text-text-secondary border-border bg-white/5',
  };
  return `text-[10px] px-1.5 py-0.5 border rounded font-mono ${map[o] || ''}`;
}
