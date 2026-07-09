import { useLang } from '../../../providers/LanguageProvider';

interface SentinelCardProps {
  id: string;
  name: string;
  status: string;
  targetState?: string | null;
  pinned?: boolean;
  togglingId?: string | null;
  onToggleStatus?: (id: string, currentStatus: string) => void;
}

export function SentinelCard({
  id,
  name,
  status,
  targetState,
  pinned,
  togglingId,
  onToggleStatus
}: SentinelCardProps) {
  const { t } = useLang();
  const isToggling = togglingId === id;

  return (
    <div style={{
      position: 'relative',
      border: '1px solid var(--border-color)',
      borderRadius: '8px',
      padding: '12px 10px 8px 10px',
      background: '#fff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: '110px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
    }}>
      {/* AI Badge in top-left */}
      <span style={{
        position: 'absolute',
        top: '6px',
        left: '6px',
        fontSize: '7.5px',
        fontWeight: 900,
        background: '#eff6ff',
        color: '#2563eb',
        border: '1px solid #dbeafe',
        borderRadius: '3px',
        padding: '1px 3px',
        lineHeight: 1,
        letterSpacing: '0.05em'
      }}>
        AI
      </span>

      {/* Status dot in top-right */}
      <span style={{
        position: 'absolute',
        top: '8px',
        right: '8px',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: status === 'ACTIVE' ? '#10b981' : '#94a3b8'
      }} title={status} />

      {/* Middle text (Name, Target State, Pinned status) */}
      <div style={{ width: '100%', marginTop: '14px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, justifyContent: 'center' }}>
        <span style={{
          fontSize: '11px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: '1.3',
          wordBreak: 'break-word',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }} title={name}>
          {name}
        </span>

        {targetState && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <span style={{
              fontSize: '8.5px',
              color: '#059669',
              background: '#ecfdf5',
              border: '1px solid #a7f3d0',
              padding: '0.5px 5px',
              borderRadius: '3px',
              fontWeight: 500,
              fontFamily: 'var(--font-mono)',
              lineHeight: '1.2'
            }}>
              → {targetState}
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
          {pinned !== undefined && (
            <span style={{
              fontSize: '8px',
              color: pinned ? '#3b82f6' : '#94a3b8',
              background: pinned ? '#eff6ff' : '#f8fafc',
              border: `1px solid ${pinned ? '#bfdbfe' : 'var(--border-color)'}`,
              padding: '0px 4px',
              borderRadius: '3px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}>
              {pinned ? t('fulfillment.profile.watcherPinned') : t('fulfillment.profile.watcherStream')}
            </span>
          )}
          <span style={{
            fontSize: '8.5px',
            color: '#94a3b8',
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }} title={id}>
            {id}
          </span>
        </div>
      </div>

      {/* Bottom action button (Rendered only if onToggleStatus is provided) */}
      {onToggleStatus && (
        <button
          type="button"
          onClick={() => onToggleStatus(id, status)}
          disabled={isToggling}
          style={{
            width: '100%',
            marginTop: '8px',
            fontSize: '9px',
            color: status === 'ACTIVE' ? '#dc2626' : '#10b981',
            background: status === 'ACTIVE' ? '#fef2f2' : '#f0fdf4',
            border: `1px solid ${status === 'ACTIVE' ? '#fecaca' : '#bbf7d0'}`,
            padding: '3px 0',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
            textAlign: 'center',
            flexShrink: 0
          }}
        >
          {isToggling ? '...' : (status === 'ACTIVE' ? t('common.disable') || 'Disable' : t('common.enable') || 'Enable')}
        </button>
      )}
    </div>
  );
}
