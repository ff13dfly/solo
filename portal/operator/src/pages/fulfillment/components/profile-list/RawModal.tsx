import { useLang } from '../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../components/ui';
import type { Profile } from '../transitions/types';

export function RawModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useLang();
  return (
    <div className="modal-overlay" style={{ background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700 }}>{t('common.view_raw')}</span>
            <code style={{ fontSize: '11px', background: '#f1f5f9', padding: '2px 8px', borderRadius: '4px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{profile.id}</code>
          </div>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          <pre style={{ margin: 0, fontSize: '12px', lineHeight: '1.6', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', background: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '14px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(profile, null, 2)}
          </pre>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    </div>
  );
}
