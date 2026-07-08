import { useState } from 'react';
import { callRpc } from '../../../../utils/rpc';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../components/ui';
import type { MetaField, MetaFieldSource, Profile } from '../transitions/types';

export function MetaFieldsModal({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [fields, setFields] = useState<MetaField[]>(
    (profile as any).meta_fields ?? []
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const addField = () => {
    const next = [...fields, { key: '', label: '' }];
    setFields(next);
    setExpanded(next.length - 1);
  };

  const updField = (i: number, patch: Partial<MetaField>) =>
    setFields(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f));

  const updSource = (i: number, patch: Partial<MetaFieldSource>) => {
    const cur = fields[i].source ?? { service: '', method: '', pick: '' };
    updField(i, { source: { ...cur, ...patch } });
  };

  const clearSource = (i: number) => updField(i, { source: undefined });

  const delField = (i: number) => {
    setFields(prev => prev.filter((_, idx) => idx !== i));
    if (expanded === i) setExpanded(null);
  };

  const handleSave = async () => {
    for (const f of fields) {
      if (!f.key.trim()) { setError(t('fulfillment.profile.allFieldsNeedKey')); return; }
    }
    setSaving(true);
    setError(null);
    try {
      await callRpc('fulfillment.profile.update', { id: profile.id, meta_fields: fields });
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
      <div className="modal" style={{ width: '560px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700 }}>{t('fulfillment.meta_fields')}</span>
            <code style={{ fontSize: '11px', background: '#f1f5f9', padding: '2px 8px', borderRadius: '4px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{profile.id}</code>
          </div>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {fields.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: '7px', color: '#94a3b8', fontSize: '12px' }}>
              {t('fulfillment.profile.noFields')}
            </div>
          )}

          {fields.map((f, i) => {
            const isExp = expanded === i;
            const hasSource = !!f.source;
            return (
              <div key={i} style={{ border: `1px solid ${isExp ? '#dbeafe' : 'var(--border-color)'}`, borderRadius: '8px', background: isExp ? '#f8fbff' : '#fafafa', overflow: 'hidden' }}>
                {/* Row header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', cursor: 'pointer' }}
                  onClick={() => setExpanded(isExp ? null : i)}>
                  <span style={{ fontSize: '11px', color: '#94a3b8', width: '12px', textAlign: 'center', flexShrink: 0 }}>{isExp ? '▾' : '▸'}</span>
                  <input
                    value={f.key}
                    onClick={e => e.stopPropagation()}
                    onChange={e => updField(i, { key: e.target.value.replace(/[^a-z0-9_]/gi, '_').toLowerCase() })}
                    placeholder="field_key"
                    style={{ width: '140px', fontFamily: 'var(--font-mono)', fontSize: '12px', flexShrink: 0 }}
                  />
                  <input
                    value={f.label}
                    onClick={e => e.stopPropagation()}
                    onChange={e => updField(i, { label: e.target.value })}
                    placeholder={t('fulfillment.profile.displayName')}
                    style={{ flex: 1, fontSize: '12px' }}
                  />
                  {hasSource && (
                    <span style={{ fontSize: '10px', color: '#3b82f6', background: '#eff6ff', padding: '2px 7px', borderRadius: '4px', border: '1px solid #bfdbfe', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                      {f.source!.service}.{f.source!.method}
                    </span>
                  )}
                  <IconButton variant="danger" size="sm" onClick={e => { e.stopPropagation(); delField(i); }} style={{ flexShrink: 0 }}>✕</IconButton>
                </div>

                {/* Expanded source config */}
                {isExp && (
                  <div style={{ padding: '12px 16px 14px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>{t('fulfillment.data_source')}</span>
                      {hasSource
                        ? <Button variant="danger" size="sm" onClick={() => clearSource(i)}>{t('common.remove')}</Button>
                        : <Button variant="secondary" size="sm" onClick={() => updSource(i, { service: '', method: '', pick: '' })}>+ {t('fulfillment.profile.configSource')}</Button>
                      }
                    </div>

                    {hasSource && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '56px', flexShrink: 0 }}>{t('fulfillment.profile.sourceService')}</span>
                          <input
                            value={f.source!.service}
                            onChange={e => updSource(i, { service: e.target.value })}
                            placeholder="sale"
                            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '56px', flexShrink: 0 }}>{t('fulfillment.profile.sourceMethod')}</span>
                          <input
                            value={f.source!.method}
                            onChange={e => updSource(i, { method: e.target.value })}
                            placeholder="order.get"
                            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '56px', flexShrink: 0 }}>{t('fulfillment.profile.sourcePick')}</span>
                          <input
                            value={f.source!.pick}
                            onChange={e => updSource(i, { pick: e.target.value })}
                            placeholder="paid_amount"
                            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '56px', flexShrink: 0, paddingTop: '6px' }}>{t('fulfillment.profile.sourceParams')}</span>
                          <textarea
                            value={f.source!.params ? JSON.stringify(f.source!.params, null, 2) : ''}
                            onChange={e => {
                              try {
                                const p = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
                                updSource(i, { params: p });
                              } catch { /* ignore parse errors while typing */ }
                            }}
                            placeholder={'{\n  "id": "{instance.sourceId}"\n}'}
                            rows={3}
                            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '11px', resize: 'vertical', lineHeight: '1.5' }}
                          />
                        </div>
                        <div style={{ fontSize: '10px', color: '#94a3b8', background: '#f8fafc', borderRadius: '5px', padding: '6px 10px', lineHeight: '1.6' }}>
                          {t('fulfillment.profile.runtimeLabel')} <code style={{ fontFamily: 'var(--font-mono)' }}>{f.source!.service}.{f.source!.method || '?'}(params)</code> → {t('fulfillment.profile.runtimePick')} <code style={{ fontFamily: 'var(--font-mono)' }}>{f.source!.pick || '?'}</code> → {t('fulfillment.profile.runtimeWrite')} <code style={{ fontFamily: 'var(--font-mono)' }}>instance.meta.{f.key || '?'}</code>
                        </div>
                      </div>
                    )}

                    {!hasSource && (
                      <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>
                        {t('fulfillment.profile.noSourceHint')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <Button variant="secondary" size="sm" onClick={addField} style={{ alignSelf: 'flex-start', marginTop: '4px' }}>+ {t('fulfillment.profile.addField')}</Button>
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
