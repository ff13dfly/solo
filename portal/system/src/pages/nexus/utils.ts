import type { Sentinel, FetcherRow } from './types';

export const TRACK_OPTIONS = ['internal', 'external'] as const;
export const REACHABILITY_OPTIONS = ['', 'built-in', 'polling', 'sse', 'webhook'] as const;
export const ON_ERROR_OPTIONS = ['abort', 'skip', 'fallback'] as const;
export const READ_SUFFIXES = ['get', 'list', 'query', 'search', 'count', 'resolve', 'info'];

export const emptyFetcher = (): FetcherRow => ({
  key: '', method: '', params: '', result_path: '', depends_on: '', on_error: 'abort', fallback: '', guard: '',
});

export const fetcherToRow = (f: any): FetcherRow => ({
  key: f.key || '',
  method: f.method || '',
  params: f.params && Object.keys(f.params).length ? JSON.stringify(f.params) : '',
  result_path: f.result_path || '',
  depends_on: Array.isArray(f.depends_on) ? f.depends_on.join(', ') : '',
  on_error: (ON_ERROR_OPTIONS as readonly string[]).includes(f.on_error) ? f.on_error : 'abort',
  fallback: f.fallback ? JSON.stringify(f.fallback) : '',
  guard: f.guard ? JSON.stringify(f.guard) : '',
});

export function declaredNeeds(s: Sentinel): string[] {
  const needs: string[] = [];
  for (const f of s.context?.data_fetchers ?? []) {
    const m = (f as { method?: unknown }).method;
    if (typeof m === 'string') needs.push(m);
  }
  if (s.context?.autorun) needs.push('agent.decide');
  return [...new Set(needs)];
}
