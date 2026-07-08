export interface ServicePause {
  paused: boolean;
}

export interface AutomationStatus {
  services: Record<string, ServicePause>;
  allPaused: boolean;
  anyPaused: boolean;
}

export interface Glance {
  sentinels: number;
  online: number;
  schedules: number;
  dlq: number;
  pausedRuns: number;
}

export interface CleanupStep {
  id: string;
  method: string;
  result_summary?: string | null;
  compensate?: any;
}

export interface CompEntry {
  forStep: string;
  compensate?: string;
  method?: string | null;
  status?: string;
  error?: string;
}

export interface Compensation {
  ran?: boolean;
  failed?: boolean;
  entries?: CompEntry[];
}

export interface RunRow {
  id: string;
  workflowId: string;
  status: string;
  workflowVersion?: number | null;
  missingMethods?: string[];
  failedStep?: string | null;
  lastError?: string | null;
  cleanupManifest?: CleanupStep[] | null;
  compensation?: Compensation | null;
  startedAt?: number;
  pausedAt?: number;
  failedAt?: number;
  stalledAt?: number;
}

export interface OpsAlert {
  id: string;
  type: string;
  payload?: any;
  createdAt?: number;
}
