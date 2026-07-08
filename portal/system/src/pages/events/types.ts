export type Tab = 'schedules' | 'runs' | 'stream' | 'format';

export interface ScheduleAction {
  kind: 'run_command' | 'emit_event';
  workflow_id?: string;
  stream?: string;
  type?: string;
}

export interface Schedule {
  schedule_id: string;
  fire_at: number;
  recurrence_ms: number | null;
  action: ScheduleAction;
  enabled: boolean;
  owner: string | null;
  created_at: number;
  last_fired_at: number | null;
}

export type RunStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'STALLED' | 'PAUSED_AWAITING_HUMAN' | 'RESUMING' | 'ABORTED' | 'DEADLETTER';

export interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: number;
  enqueuedAt: number;
  attempts: number;
  trace?: string;
  parentEventId?: string;
  missingMethods?: string[];
  failedStep?: string;
  lastError?: string;
  abortReason?: string;
  doneAt?: number;
  pausedAt?: number;
}

export interface BusStream {
  key: string;
  length: number;
  lastId: string | null;
  lastAt: number | null;
}

export interface BusEntry {
  id: string;
  at: number | null;
  type?: string;
  source?: string;
  actor?: string;
  actorSource?: string;
  trace_id?: string;
  payload?: string;
}
