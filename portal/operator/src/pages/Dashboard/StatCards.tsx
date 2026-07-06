import { useLang } from '../../providers/LanguageProvider';
import type { DailyStats } from './types';

const CNY_RATE = 7.25;
const toCny = (usd: number) => (usd * CNY_RATE).toFixed(4);

interface Props {
    today: DailyStats | null;
    loading: boolean;
}

export default function StatCards({ today, loading }: Props) {
    const { t } = useLang();
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 20 }}>
            {/* 今日估算费用 */}
            <div className="stat-card">
                <div className="stat-label">{t('dashboard.today_cost')}</div>
                <div className="stat-value">
                    {loading ? '…' : `¥${toCny(today?.costUsd ?? 0)}`}
                </div>
                <div className="stat-bar">
                    <div className="bar-fill" style={{ width: `${Math.min(100, (today?.costUsd ?? 0) * 10)}%`, background: 'var(--primary-color)' }} />
                </div>
            </div>

            {/* 今日 AI 调用 */}
            <div className="stat-card">
                <div className="stat-label">{t('dashboard.today_calls')}</div>
                <div className="stat-value">
                    {loading ? '…' : (today?.calls ?? 0)}
                </div>
                <div className="stat-bar">
                    <div className="bar-fill" style={{ width: `${Math.min(100, (today?.calls ?? 0) / 2)}%`, background: '#8b5cf6' }} />
                </div>
            </div>

            {/* 系统状态 */}
            <div className="stat-card online">
                <div className="stat-label">{t('dashboard.system_status')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                        background: 'var(--success-color)',
                        boxShadow: '0 0 0 3px rgba(16,185,129,0.2)',
                    }} />
                    <span className="stat-value" style={{ fontSize: 24, marginBottom: 0 }}>ONLINE</span>
                </div>
                <div className="stat-bar"><div className="bar-fill" style={{ width: '100%' }} /></div>
            </div>
        </div>
    );
}
