export interface DailyStats {
    date: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface RecentEntry {
    ts: number;
    method: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    hasImageOutput: boolean;
    costUsd: number;
}


export interface WalDailyStats {
    date: string;
    ts: number;
    create: number;
    update: number;
    destroy: number;
    total: number;
}
