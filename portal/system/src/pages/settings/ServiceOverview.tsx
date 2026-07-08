import { useEffect, useState } from 'react';
import { callRpc } from '../../utils/rpc';
import type { ServiceListItem, ErpConnectionStatus } from './types';

interface ServiceOverviewProps {
  svc: ServiceListItem;
}

export const ServiceOverview: React.FC<ServiceOverviewProps> = ({ svc }) => {
  const [erpStatus, setErpStatus] = useState<ErpConnectionStatus | null>(null);
  const [erpLoading, setErpLoading] = useState(false);

  useEffect(() => {
    if (svc.id !== 'erp') { setErpStatus(null); return; }
    setErpLoading(true);
    callRpc<ErpConnectionStatus>('erp.connection.status')
      .then(s => setErpStatus(s))
      .catch(() => setErpStatus(null))
      .finally(() => setErpLoading(false));
  }, [svc.id]);

  const aiMethods = svc.methods?.filter(m => m.ai) ?? [];
  const publicMethods = svc.methods?.filter(m => m.public) ?? [];
  const totalMethods = svc.methods?.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span className="font-mono font-bold" style={{ fontSize: '16px' }}>{svc.id}</span>
          <span style={{
            fontSize: '10px', padding: '2px 7px', borderRadius: '4px',
            background: svc.status === 'online' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            color: svc.status === 'online' ? '#22c55e' : '#ef4444',
            border: `1px solid ${svc.status === 'online' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}>
            {svc.status.toUpperCase()}
          </span>
          <span className="text-text-secondary font-mono" style={{ fontSize: '12px' }}>v{svc.version}</span>
        </div>
        <div className="font-mono text-text-secondary" style={{ fontSize: '11px' }}>{svc.url}</div>
        {svc.lastSeen && (
          <div className="text-text-secondary" style={{ fontSize: '11px', marginTop: '3px' }}>
            Last seen: {new Date(svc.lastSeen).toLocaleString()}
          </div>
        )}
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: '12px' }}>
        {[
          { label: 'Methods', value: totalMethods },
          { label: 'AI-exposed', value: aiMethods.length },
          { label: 'Public', value: publicMethods.length },
        ].map(stat => (
          <div key={stat.label} style={{
            padding: '10px 16px', border: '1px solid var(--border-color)', borderRadius: '6px',
            minWidth: '80px', textAlign: 'center',
          }}>
            <div className="font-bold" style={{ fontSize: '20px' }}>{stat.value}</div>
            <div className="text-text-secondary" style={{ fontSize: '11px', marginTop: '2px' }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* ERP Bridge */}
      {svc.id === 'erp' && (
        <div>
          <div className="text-text-secondary font-bold" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            T+ Cloud Bridge
          </div>
          {erpLoading ? (
            <div className="text-text-secondary" style={{ fontSize: '12px' }}>Loading...</div>
          ) : erpStatus ? (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <div style={{
                padding: '10px 14px',
                border: `1px solid ${erpStatus.hasToken ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                borderRadius: '6px',
                background: erpStatus.hasToken ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)',
                minWidth: '130px',
              }}>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Token</div>
                <div style={{ fontSize: '13px', color: erpStatus.hasToken ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                  {erpStatus.hasToken ? 'Connected' : 'No Token'}
                </div>
                {erpStatus.hasToken && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {erpStatus.remainingHours}h remaining
                  </div>
                )}
              </div>
              <div style={{ padding: '10px 14px', border: '1px solid var(--border-color)', borderRadius: '6px', minWidth: '160px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>App Key</div>
                <div className="font-mono" style={{ fontSize: '12px' }}>{erpStatus.appKey}</div>
                {erpStatus.expiresAt && (
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Expires: {new Date(erpStatus.expiresAt).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-text-secondary" style={{ fontSize: '12px' }}>Unable to fetch connection status</div>
          )}
        </div>
      )}

      {/* Methods */}
      {totalMethods > 0 && (
        <div>
          <div className="text-text-secondary font-bold" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            Methods
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
            {svc.methods!.map(m => (
              <span key={m.name} title={m.description || m.name} style={{
                fontFamily: 'monospace', fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
                border: '1px solid var(--border-color)',
                background: m.ai ? 'rgba(139,92,246,0.07)' : 'transparent',
                color: m.ai ? '#a78bfa' : 'var(--text-secondary)',
              }}>
                {m.name}
              </span>
            ))}
          </div>
          <div className="text-text-secondary" style={{ fontSize: '10px', marginTop: '6px' }}>
            <span style={{ color: '#a78bfa' }}>■</span> AI-exposed
          </div>
        </div>
      )}
    </div>
  );
};
