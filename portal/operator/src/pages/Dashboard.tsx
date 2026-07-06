import { useEffect, useState } from 'react';
import { useLang } from '../providers/LanguageProvider';
import { callRpc } from '../utils/rpc';


import type { DailyStats, RecentEntry, WalDailyStats } from './Dashboard/types';
import StatCards from './Dashboard/StatCards';
import AiUsagePanel from './Dashboard/AiUsagePanel';
import WalStatsPanel from './Dashboard/WalStatsPanel';

export default function Dashboard() {
    const { lang } = useLang();
    const [daily, setDaily] = useState<DailyStats[]>([]);
    const [recent, setRecent] = useState<RecentEntry[]>([]);
    const [walDaily, setWalDaily] = useState<WalDailyStats[]>([]);
    const [loading, setLoading] = useState(true);
    const [walLoading, setWalLoading] = useState(true);

    useEffect(() => {
        // AI Stats
        callRpc<{ daily: DailyStats[], recent: RecentEntry[] }>('agent.stats.token')
            .then(({ daily: d, recent: r }) => {
                setDaily((d || []).map(item => ({
                    ...item,
                    ts: new Date(item.date + 'T00:00:00').getTime()
                })));
                setRecent(r || []);
            }).catch(() => {}).finally(() => setLoading(false));

        // WAL Stats
        callRpc<WalDailyStats[]>('system.wal.stats.daily', { days: 30 })
            .then(d => setWalDaily(d || []))
            .catch(() => {})
            .finally(() => setWalLoading(false));
    }, [lang]);

    return (
        <div className="dashboard-container" style={{ flexDirection: 'column', overflowY: 'auto' }}>
            <StatCards today={daily[0] ?? null} loading={loading} />

            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
                {/* 左侧：AI 用量统计（含最近调用） */}
                <AiUsagePanel daily={daily} recent={recent} loading={loading} />

                {/* 右侧：QR 绑定与 WAL 纵向堆叠 */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <WalStatsPanel walDaily={walDaily} loading={walLoading} />
                </div>
            </div>


        </div>
    );
}
