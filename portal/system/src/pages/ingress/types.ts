export type Tab = 'sources' | 'deliveries';

export interface Source {
  id: string;
  name: string;
  stream: string;
  enabled: boolean;
  dedupTtlSec: number;
  lastFiredAt: number | null;
  hitCount: number;
  dupCount: number;
  createdAt: number;
  healthUrl?: string | null;
}

export interface Delivery {
  ts: number;
  source: string;
  request_id: string | null;
  outcome: 'accepted' | 'duplicate' | 'unauthorized' | 'disabled' | 'invalid';
  status: number;
  bytes: number;
}
