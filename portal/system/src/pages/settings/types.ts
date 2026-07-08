// Shared types for Settings components

export interface ServiceListItem {
  id: string;
  url: string;
  available: boolean;
  status: 'online' | 'offline';
  lastSeen: string | null;
  version: string;
  methods: MethodInfo[];
  // Entity introspection (from system.service.list) — drives the Display config tab.
  entities?: Record<string, { description?: string; fields?: Record<string, any> }>;
}

export interface MethodInfo {
  name: string;
  description?: string;
  ai?: boolean;
  public?: boolean;
}

export interface ServiceInfo {
  id: string;
  methods?: MethodInfo[];
}

export interface ErpConnectionStatus {
  hasToken: boolean;
  expiresAt: string | null;
  remainingHours: number;
  cloudHost: string;
  appKey: string;
}
