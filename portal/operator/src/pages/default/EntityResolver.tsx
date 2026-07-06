import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';
import { useServices } from '../../providers/ServicesProvider';
import { useLang } from '../../providers/LanguageProvider';

interface EntityResolverProps {
  currentServiceId: string;
  entityName: string;
  id: string;
  onClose: () => void;
}

export function EntityResolver({ currentServiceId, entityName, id, onClose }: EntityResolverProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { services } = useServices();
  const { t } = useLang();

  useEffect(() => {
    const fetchRelated = async () => {
      setLoading(true);
      try {
        // 1. Prioritize current service
        const currentService = services.find(s => s.id === currentServiceId);
        let targetServiceId = currentServiceId;
        
        // 2. If entity not in current service, search globally
        if (!currentService?.entities?.[entityName]) {
          const globalOwner = services.find(s => s.entities && s.entities[entityName]);
          if (globalOwner) {
            targetServiceId = globalOwner.id;
          }
        }

        let rpcMethod = `${targetServiceId}.${entityName}.get`;
        let rpcParams: any = { id };

        // Special handling for user entity which doesn't follow standard [entity].get pattern
        if (entityName === 'user') {
          rpcMethod = 'user.profile';
          rpcParams = { uid: id };
        }

        const res = await callRpc<any>(rpcMethod, rpcParams);
        setData(res);
      } catch (err) {
        console.error("Failed to resolve entity:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchRelated();
  }, [currentServiceId, entityName, id, services]);

  return (
    <>
      {/* Click-away overlay */}
      <div 
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 'var(--sidebar-width, 0px)',
          right: 0,
          bottom: 0,
          zIndex: 99,
          background: 'transparent',
          cursor: 'default'
        }}
      />
      
      {/* Popover content */}
      <div 
        onClick={(e) => e.stopPropagation()} // Prevent clicking inside from closing
        style={{
          position: 'absolute',
          top: '100%',
          left: '0',
          zIndex: 100,
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: '12px',
          padding: 0, // Reset for internal structure
          boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)',
          width: '280px',
          marginTop: '8px',
          overflow: 'hidden', // Contain the deleted banner
           // If near bottom of parent, flip up? 
           // For now, let's just make it look better and increase container padding
        }}
      >
        {/* Deleted Warning Banner */}
        {!loading && data?.status === 'DELETED' && (
          <div style={{
            background: '#ef4444',
            color: 'white',
            padding: '6px 12px',
            fontSize: '11px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}>
            <span>🚫</span>
            <span>{t('entity.in_recycle_bin')}</span>
          </div>
        )}

        <div style={{ padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.05em' }}>
              {entityName.toUpperCase()} DETAILS
            </span>
            {/* Close button removed as clicking outside closes it */}
          </div>

          {loading ? (
            <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="spinning" style={{ width: '12px', height: '12px', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', borderRadius: '50%' }} />
              {t('entity.resolving')}
            </div>
          ) : data ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px', color: '#1e293b', marginBottom: '2px' }}>
                  {data.name || data.title || id}
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>ID: {id}</div>
              </div>
              
              <div style={{ borderTop: '1px solid #f1f5f9', marginTop: '8px', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: '#64748b' }}>{t('common.status')}</span>
                  <span style={{ 
                    fontWeight: 600, 
                    color: data.status === 'DELETED' ? '#ef4444' : '#10b981',
                    background: data.status === 'DELETED' ? '#fef2f2' : '#f0fdf4',
                    padding: '2px 8px',
                    borderRadius: '99px',
                    fontSize: '10px'
                  }}>
                    {data.status}
                  </span>
                </div>
                {data.createdAt && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                    <span style={{ color: '#94a3b8' }}>{t('entity.label_created_on')}</span>
                    <span style={{ color: '#475569' }}>{new Date(data.createdAt).toLocaleDateString()}</span>
                  </div>
                )}
                {data.updatedAt && (
                   <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                    <span style={{ color: '#94a3b8' }}>{t('entity.label_last_updated')}</span>
                    <span style={{ color: '#475569' }}>{new Date(data.updatedAt).toLocaleDateString()}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: '#ef4444', background: '#fef2f2', padding: '8px', borderRadius: '6px' }}>
              {t('entity.err_unresolvable', { id })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
