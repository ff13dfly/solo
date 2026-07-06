import { useLang } from '../../../providers/LanguageProvider';
import { Button } from '../../../components/ui';

interface Props {
  instance: any;
  onClick: () => void;
  onTrace?: () => void;
}

export function FulfillmentCard({ instance, onClick, onTrace }: Props) {
  const { t } = useLang();
  const { id, sourceId, state, meta = {} } = instance;
  // Each transition stamps the trace of the chain that drove it; only offer the trace
  // affordance when at least one history entry is actually traced.
  const hasTrace = Array.isArray(instance.history) && instance.history.some((h: any) => h?.trace);

  const formatValue = (amount: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  };

  return (
    <div 
      className="card" 
      onClick={onClick}
      style={{ 
        padding: '12px', 
        background: '#fff', 
        border: '1px solid #e2e8f0', 
        borderRadius: '8px', 
        cursor: 'pointer', 
        transition: 'all 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-color)';
        e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0,0,0,0.1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#e2e8f0';
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{id}</span>
        {meta.incoterms && (
          <span style={{ fontSize: '10px', background: '#fef3c7', color: '#92400e', padding: '1px 4px', borderRadius: '4px', border: '1px solid #fde68a' }}>
            {meta.incoterms}
          </span>
        )}
      </div>

      <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>{meta.customer || t('fulfillment.card_unknown_customer')}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>{t('fulfillment.card_order')}{sourceId}</div>

      {state === 'SHIPPED' && meta.vessel && (
        <div style={{ background: 'var(--accent-surface)', padding: '6px', borderRadius: '6px', fontSize: '11px', marginBottom: '8px', border: '1px solid #dbeafe' }}>
          <div style={{ fontWeight: 600, color: 'var(--accent-color)' }}>🚢 {meta.vessel}</div>
          <div style={{ color: '#64748b' }}>{t('fulfillment.card_container')}{meta.containerNo}</div>
          <div style={{ color: '#64748b' }}>{t('fulfillment.card_eta')}{meta.eta}</div>
        </div>
      )}

      {state === 'PRODUCTION' && meta.factory && (
        <div style={{ background: '#fdf2f8', padding: '6px', borderRadius: '6px', fontSize: '11px', marginBottom: '8px', border: '1px solid #fbcfe8' }}>
          <div style={{ fontWeight: 600, color: '#be185d' }}>🏭 {meta.factory}</div>
          <div style={{ color: '#db2777' }}>{t('fulfillment.card_ready')}{meta.estimatedFinishDate}</div>
        </div>
      )}

      {(meta.totalAmount || (onTrace && hasTrace)) && (
        <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          {onTrace && hasTrace ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="18" r="2"/><path d="M7 6h8a2 2 0 0 1 2 2v2M17 14v0a2 2 0 0 1-2 2H7"/></svg>}
              onClick={(e) => { e.stopPropagation(); onTrace(); }}
              title={t('fulfillment.card_trace_title', { defaultValue: 'Show this instance’s full execution chain (runs + events)' })}
            >
              {t('fulfillment.card_trace', { defaultValue: 'Trace' })}
            </Button>
          ) : <span />}
          {meta.totalAmount && (
            <span style={{ fontSize: '12px', fontWeight: 700 }}>{formatValue(meta.totalAmount, meta.currency)}</span>
          )}
        </div>
      )}
    </div>
  );
}
