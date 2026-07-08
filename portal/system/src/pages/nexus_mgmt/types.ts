export interface SentinelContext {
  guard?: Record<string, unknown>;
  data_fetchers?: Array<Record<string, unknown>>;
  system_prompt_template?: string;
  autorun?: boolean | { choices?: string[]; schema?: Record<string, unknown>; confidence_threshold?: number };
  emit?: Record<string, unknown>;
}

export interface Sentinel {
  id: string;
  name: string;
  description: string | null;
  authorityRole: string;
  track: 'internal' | 'external';
  eventSubscriptions: string[];
  reachability: string | null;
  webhookUrl: string | null;
  context: SentinelContext | null;
  status: 'ACTIVE' | 'DISABLED';
  lastSeenAt: number | null;
  createdAt: number;
  online: boolean;
  identity?: { mode: 'bot' | 'shared'; uid?: string; hasToken?: boolean | null; expired?: boolean; expiresAt?: number | null };
  activity?: { fired: number; skipped: number; failed: number; lastFiredAt: number | null; lastFailedAt: number | null } | null;
}

export interface FetcherRow {
  key: string;
  method: string;
  params: string;       // JSON
  result_path: string;
  depends_on: string;   // comma-separated
  on_error: 'abort' | 'skip' | 'fallback';
  fallback: string;     // JSON (only when on_error === 'fallback')
  guard: string;        // JSON (optional per-fetcher guard)
}

export interface DeliveryItem {
  id: string;
  type?: string;           // source stream key
  ref?: string;            // stream entry id
  createdAt?: number;
  payload?: {
    event?: { type?: string; payload?: Record<string, unknown> };
    context?: {
      system_prompt?: string;
      data?: Record<string, unknown>;
      output?: { decision?: string; confidence?: number; escalate?: boolean; reason?: string } | null;
      autorun_error?: string;
    };
  };
}
