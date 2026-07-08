// ─── Sentinel watchers (nexus ↔ fulfillment linkage) ─────────────────────────
// A sentinel watches a profile indirectly: it subscribes to EVENT:FULFILLMENT:*
// and (optionally) pins ONE profile via a JsonLogic guard on event.payload.profileId.
// Surface that linkage here so the profile view answers "who reacts to my transitions?"
// without hopping to the system portal.

export interface WatcherSentinel { id: string; name: string; status?: string; pinned: boolean }

// Conservative JsonLogic walk: find { '==': [ {var:'event.payload.profileId'}, '<id>' ] }
// anywhere in the guard (either operand order). Anything fancier than an equality pin
// is treated as stream-wide (shown, not hidden — over-reporting beats invisibility).
function extractProfilePin(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) { const f = extractProfilePin(item); if (f) return f; }
    return null;
  }
  for (const [op, args] of Object.entries(node as Record<string, unknown>)) {
    if (op === '==' && Array.isArray(args) && args.length === 2) {
      const [a, b] = args as any[];
      const isPinVar = (x: any) => x && typeof x === 'object' && x.var === 'event.payload.profileId';
      if (isPinVar(a) && typeof b === 'string') return b;
      if (isPinVar(b) && typeof a === 'string') return a;
    }
    const found = extractProfilePin(args);
    if (found) return found;
  }
  return null;
}

export function watchersFor(profileId: string, sentinels: any[]): WatcherSentinel[] {
  return sentinels
    .filter(s => (s.eventSubscriptions || []).some((k: unknown) => String(k).startsWith('EVENT:FULFILLMENT')))
    .map(s => ({ s, pin: extractProfilePin(s.context?.guard) }))
    .filter(({ pin }) => pin === null || pin === profileId)
    .map(({ s, pin }) => ({ id: s.id, name: s.name, status: s.status, pinned: pin === profileId }));
}

export function formatDate(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
