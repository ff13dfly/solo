import { useNavigate } from 'react-router-dom';

interface StatsProps {
  stats: {
    total: number;
    online: number;
    offline: number;
    configured: number;
    errorCount: number;
    workflowCount: number;
  };
  userStats: {
    active: number;
    total: number;
  };
  loading: boolean;
  t: (key: string) => string;
}

export const StatsCards: React.FC<StatsProps> = ({ stats, userStats, loading, t }) => {
  const navigate = useNavigate();

  const StatItem = ({ label, value, type = 'default', onClick, percent: overridePercent }: { label: string, value: number | string, type?: 'default' | 'online' | 'offline' | 'pending', onClick?: () => void, percent?: number }) => {
    let valueColor = 'text-white';
    let barColor = 'bg-accent';
    let barShadow = '';

    if (type === 'online') {
      valueColor = 'text-green-500';
      barColor = 'bg-green-500';
      barShadow = 'shadow-[0_0_8px_rgba(46,204,113,0.3)]';
    } else if (type === 'offline') {
      valueColor = 'text-red-500';
      barColor = 'bg-red-500';
      barShadow = 'shadow-[0_0_8px_rgba(231,76,60,0.3)]';
    } else if (type === 'pending') {
      valueColor = 'text-yellow-500';
      barColor = 'bg-yellow-500';
      barShadow = 'shadow-[0_0_8px_rgba(243,156,18,0.3)]';
    }

    const calculatedPercent = typeof value === 'number' && stats.total > 0 ? (value / stats.total) * 100 : 0;
    const percent = overridePercent !== undefined ? overridePercent : calculatedPercent;
    const width = type === 'default' && overridePercent === undefined ? '100%' : `${percent}%`;

    // Process mixed content: split "10 ACTIVE / 12 TOTAL" into primary and secondary
    let primary = value;
    let secondary = '';

    if (typeof value === 'string' && value.includes(' ')) {
      const parts = value.split(' ');
      primary = parts[0];
      secondary = value.substring(parts[0].length).trim();
    }

    return (
      <div
        onClick={onClick}
        className={`bg-bg-primary border border-border rounded-xl p-5 relative overflow-hidden transition-all hover:-translate-y-0.5 hover:border-white/20 ${onClick ? 'cursor-pointer' : ''}`}
      >
        <div className="text-[11px] font-bold text-text-secondary tracking-widest mb-2 uppercase flex items-center justify-between">
          <span>{label}</span>
          {onClick && <span className="text-[9px] opacity-40">GO →</span>}
        </div>
        <div className={`mb-3 flex items-baseline gap-2 font-mono ${valueColor}`}>
          <span className="text-3xl font-bold tracking-tight">{loading ? '...' : primary}</span>
          {secondary && !loading && (
            <span className="text-[10px] font-black uppercase opacity-60 tracking-tight leading-none">
              {secondary}
            </span>
          )}
        </div>
        <div className="h-1 bg-white/5 rounded-sm overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${barColor} ${barShadow}`}
            style={{ width }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <StatItem
        label={t('overview.total_users')}
        value={`${userStats.active} ACTIVE / ${userStats.total} TOTAL`}
        percent={userStats.total > 0 ? (userStats.active / userStats.total) * 100 : 0}
        onClick={() => navigate('/users')}
      />

      <StatItem
        label={t('nav.services') || 'SERVICE REGISTRY'}
        value={`${stats.online} ONLINE / ${stats.total} TOTAL`}
        type={stats.online > 0 ? 'online' : 'offline'}
        percent={stats.total > 0 ? (stats.online / stats.total) * 100 : 0}
        onClick={() => navigate('/services')}
      />

      <StatItem
        label={t('nav.workflows') || 'TOTAL WORKFLOWS'}
        value={`${stats.workflowCount} ITEMS`}
        onClick={() => navigate('/workflows')}
      />

      <StatItem
        label={t('nav.errors') || 'ERROR LOGS'}
        value={`${stats.errorCount} LOGS`}
        type="offline"
        onClick={() => navigate('/errors')}
      />
    </div>
  );
};
