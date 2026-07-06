import { callRpc } from './rpc';

interface KSentinel { eventSubscriptions?: string[]; context?: { emit?: { stream?: string } | null } | null }
interface KSchedule { action?: { kind: 'run_command' | 'emit_event'; stream?: string } }

/**
 * Aggregate every EVENT:* stream key currently known to the nexus bus — live
 * streams plus those already wired into sentinel subscriptions/emits and schedule
 * emit actions. Powers the "pick a stream" assistants on the sentinel + schedule
 * forms so a stream key is chosen from the catalog rather than re-typed (and
 * mistyped). Resilient: a failed source contributes nothing rather than throwing.
 */
export async function fetchKnownStreams(): Promise<string[]> {
  const [streamsR, sentinelR, scheduleR] = await Promise.allSettled([
    callRpc<{ items: { key: string }[] }>('nexus.event.streams', {}),
    callRpc<{ items: KSentinel[] }>('nexus.sentinel.list', { page: 1, pageSize: 200 }),
    callRpc<KSchedule[]>('nexus.schedule.list', {}),
  ]);
  const set = new Set<string>();
  if (streamsR.status === 'fulfilled') {
    for (const s of streamsR.value?.items || []) if (s.key) set.add(s.key);
  }
  if (sentinelR.status === 'fulfilled') {
    for (const sen of sentinelR.value?.items || []) {
      for (const sub of sen.eventSubscriptions || []) if (sub) set.add(sub);
      const em = sen.context?.emit?.stream;
      if (em) set.add(em);
    }
  }
  if (scheduleR.status === 'fulfilled') {
    for (const sc of scheduleR.value || []) {
      if (sc.action?.kind === 'emit_event' && sc.action.stream) set.add(sc.action.stream);
    }
  }
  return [...set].sort();
}
