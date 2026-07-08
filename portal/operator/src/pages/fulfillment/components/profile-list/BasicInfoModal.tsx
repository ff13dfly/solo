import { useState } from 'react';
import { callRpc } from '../../../../utils/rpc';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../components/ui';
import type { Profile } from '../transitions/types';

export function BasicInfoModal({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [name, setName] = useState(profile.name ?? '');
  const [description, setDesc] = useState(profile.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) { setError(t('fulfillment.profile.nameRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      await callRpc('fulfillment.profile.update', { id: profile.id, name: name.trim(), description: description.trim() });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || t('common.save_fail'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" style={{ background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: '480px' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700 }}>{t('fulfillment.basic_info')}</span>
            <code style={{ fontSize: '11px', background: '#f1f5f9', padding: '2px 8px', borderRadius: '4px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{profile.id}</code>
          </div>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>NAME</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('fulfillment.profile.namePlaceholder')} style={{ fontSize: '13px' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>DESCRIPTION</label>
            <textarea value={description} onChange={e => setDesc(e.target.value)} placeholder={t('fulfillment.profile.descPlaceholder')} rows={3} style={{ resize: 'vertical', lineHeight: '1.6' }} />
          </div>
        </div>
        <div className="modal-footer">
          {error && <span style={{ fontSize: '12px', color: '#ef4444', marginRight: 'auto' }}>{error}</span>}
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="tonal" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
