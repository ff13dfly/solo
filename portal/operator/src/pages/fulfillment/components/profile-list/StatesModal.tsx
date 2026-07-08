import { useState, useEffect } from 'react';
import { callRpc } from '../../../../utils/rpc';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../components/ui';
import { STATE_COLOR } from '../transitions/types';
import type { Profile, StateMeta, Lang, ErpView } from '../transitions/types';

function StateRow({ s, label, selected, onSelect, onRemove, pinned = false }: {
  s: string; label?: string; selected: string; onSelect: (s: string) => void; onRemove: (s: string) => void; pinned?: boolean;
}) {
  const { t } = useLang();
  const isSel = selected === s;
  return (
    <div
      onClick={() => onSelect(s)}
      style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 10px', borderRadius: '6px', cursor: 'pointer', background: isSel ? 'var(--accent-surface)' : 'transparent', border: `1px solid ${isSel ? '#dbeafe' : 'transparent'}` }}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: STATE_COLOR[s] || '#94a3b8', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <div style={{ fontSize: '11px', fontWeight: isSel ? 700 : 400, color: isSel ? 'var(--accent-color)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label || s}
        </div>
        {label && <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</div>}
      </div>
      {pinned
        ? <span style={{ fontSize: '9px', color: '#cbd5e1', flexShrink: 0 }}>{t('fulfillment.system_state_badge')}</span>
        : <button
            onClick={e => { e.stopPropagation(); onRemove(s); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: 0, color: isSel ? '#94a3b8' : '#cbd5e1', opacity: isSel ? 1 : 0, transition: 'opacity 0.1s, color 0.1s' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.color = isSel ? '#94a3b8' : '#cbd5e1'; e.currentTarget.style.opacity = isSel ? '1' : '0'; }}
          >✕</button>
      }
    </div>
  );
}

export function StatesModal({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [states, setStates] = useState<string[]>(profile.states ?? ['DRAFT', 'CANCELLED']);
  const [meta, setMeta] = useState<Record<string, StateMeta>>(profile.state_meta ?? {});
  const [stateConfig, setStateConfig] = useState<Record<string, { erp_views?: ErpView[] }>>(profile.state_config ?? {});
  const [selected, setSelected] = useState<string>(profile.states?.[0] ?? 'DRAFT');
  const [lang, setLang] = useState<Lang>('zh');
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [erpForms, setErpForms] = useState<{ method: string; label: string | { zh: string; en: string } }[]>([]);
  useEffect(() => {
    callRpc<{ items: { method: string; label: string }[] }>('erp.form.list')
      .then(r => setErpForms(r.items ?? []))
      .catch(() => {});
  }, []);

  const getViews = (s: string) => stateConfig[s]?.erp_views ?? [];
  const setViews = (s: string, views: ErpView[]) =>
    setStateConfig(prev => ({ ...prev, [s]: { ...prev[s], erp_views: views } }));

  // Server-side state_meta may be partial or legacy-shaped (a state with `label` but no
  // `description`, or a plain-string label). Normalize each field to a {zh,en} object so
  // cur.label[lang] / cur.description[lang] can never read a property off undefined.
  const normLoc = (v: any): { zh: string; en: string } =>
    v && typeof v === 'object' ? { zh: v.zh ?? '', en: v.en ?? '' }
      : typeof v === 'string' ? { zh: v, en: v }
        : { zh: '', en: '' };
  const getMeta = (s: string): StateMeta => {
    const m = (meta[s] ?? {}) as any;
    return { label: normLoc(m.label), description: normLoc(m.description) };
  };

  const setMetaField = (s: string, field: 'label' | 'description', l: Lang, val: string) => {
    setMeta(prev => ({
      ...prev,
      [s]: { ...getMeta(s), [field]: { ...getMeta(s)[field], [l]: val } }
    }));
  };

  const PINNED_TOP = 'DRAFT';
  const PINNED_BOTTOM = 'CANCELLED';
  const middleStates = states.filter(s => s !== PINNED_TOP && s !== PINNED_BOTTOM);
  const orderedStates = [
    ...(states.includes(PINNED_TOP) ? [PINNED_TOP] : []),
    ...middleStates,
    ...(states.includes(PINNED_BOTTOM) ? [PINNED_BOTTOM] : []),
  ];

  const addState = () => {
    const s = input.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!s || states.includes(s)) return;
    setStates(prev => {
      const without = prev.filter(x => x !== PINNED_TOP && x !== PINNED_BOTTOM);
      return [
        ...(prev.includes(PINNED_TOP) ? [PINNED_TOP] : []),
        ...without, s,
        ...(prev.includes(PINNED_BOTTOM) ? [PINNED_BOTTOM] : []),
      ];
    });
    setSelected(s);
    setInput('');
  };

  const removeState = (s: string) => {
    if (s === PINNED_TOP || s === PINNED_BOTTOM) return;
    setStates(prev => prev.filter(x => x !== s));
    if (selected === s) setSelected(middleStates.find(x => x !== s) ?? PINNED_TOP);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Drop transitions referencing a state no longer in the list
      const validSet = new Set(orderedStates);
      const cleanedTransitions = (profile.transitions ?? []).filter(
        t => validSet.has(t.from) && validSet.has(t.to)
      );
      const payload: any = { id: profile.id, states: orderedStates, state_meta: meta, state_config: stateConfig };
      if (cleanedTransitions.length !== (profile.transitions ?? []).length) {
        payload.transitions = cleanedTransitions;
      }
      await callRpc('fulfillment.profile.update', payload);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || t('common.save_fail'));
    } finally {
      setSaving(false);
    }
  };

  const cur = getMeta(selected);

  return (
    <div className="modal-overlay" style={{ background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: '720px', display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>

        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700 }}>{t('fulfillment.edit_states')}</span>
            <code style={{ fontSize: '11px', background: '#f1f5f9', padding: '2px 8px', borderRadius: '4px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{profile.id}</code>
          </div>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* Left: state list */}
          <div style={{ width: '210px', flexShrink: 0, borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
            <div style={{ padding: '8px 8px 4px' }}>
              {states.includes(PINNED_TOP) && <StateRow s={PINNED_TOP} label={getMeta(PINNED_TOP).label.zh || undefined} selected={selected} onSelect={setSelected} onRemove={removeState} pinned />}
            </div>
            <div style={{ height: '1px', background: 'var(--border-color)', margin: '0 8px' }} />
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {middleStates.map(s => <StateRow key={s} s={s} label={getMeta(s).label.zh || undefined} selected={selected} onSelect={setSelected} onRemove={removeState} />)}
              <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                  onKeyDown={e => { if (e.key === 'Enter') addState(); }}
                  placeholder={t('fulfillment.ph_new_state')}
                  style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '11px', minWidth: 0 }}
                />
                <Button variant="secondary" size="sm" onClick={addState} style={{ flexShrink: 0 }}>+</Button>
              </div>
            </div>
            <div style={{ height: '1px', background: 'var(--border-color)', margin: '0 8px' }} />
            <div style={{ padding: '4px 8px 8px' }}>
              {states.includes(PINNED_BOTTOM) && <StateRow s={PINNED_BOTTOM} label={getMeta(PINNED_BOTTOM).label.zh || undefined} selected={selected} onSelect={setSelected} onRemove={removeState} pinned />}
            </div>
          </div>

          {/* Right: meta editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selected ? (
              <>
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', gap: '16px', padding: '0 16px' }}>
                  {(['zh', 'en'] as Lang[]).map(l => (
                    <button key={l} onClick={() => setLang(l)} className={`tab-btn${lang === l ? ' active' : ''}`}>
                      {l === 'zh' ? '中文' : 'English'}
                    </button>
                  ))}
                </div>
                <div style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', background: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 10px' }}>
                    {selected}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>LABEL</label>
                    <input value={cur.label[lang]} onChange={e => setMetaField(selected, 'label', lang, e.target.value)} placeholder={t('fulfillment.profile.stateLabelPlaceholder')} style={{ fontSize: '13px' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>DESCRIPTION</label>
                    <textarea value={cur.description[lang]} onChange={e => setMetaField(selected, 'description', lang, e.target.value)} placeholder={t('fulfillment.profile.stateDescPlaceholder')} rows={3} style={{ resize: 'vertical', lineHeight: '1.6' }} />
                  </div>

                  {/* ERP Views — language-independent, shown regardless of tab */}
                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>{t('fulfillment.erp_views')}</label>
                      <Button variant="secondary" size="sm" onClick={() => setViews(selected, [...getViews(selected), { label: '', method: '' }])}>+ {t('common.add')}</Button>
                    </div>
                    {getViews(selected).length === 0 ? (
                      <div style={{ fontSize: '11px', color: '#cbd5e1', fontStyle: 'italic' }}>{t('fulfillment.profile.noErpDoc')}</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {getViews(selected).map((v, i) => (
                          <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input value={v.label} onChange={e => setViews(selected, getViews(selected).map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))}
                              placeholder={t('fulfillment.profile.displayName')} style={{ width: '80px', fontSize: '12px' }} />
                            <select value={v.method} onChange={e => setViews(selected, getViews(selected).map((x, idx) => idx === i ? { ...x, method: e.target.value } : x))}
                              style={{ flex: 1, fontSize: '12px' }}>
                              <option value="">{t('fulfillment.profile.erpMethodOption')}</option>
                              {erpForms.map(m => <option key={m.method} value={m.method}>{typeof m.label === 'object' ? m.label.zh : m.label}</option>)}
                            </select>
                            <IconButton variant="danger" size="sm" onClick={() => setViews(selected, getViews(selected).filter((_, idx) => idx !== i))} style={{ flexShrink: 0 }}>✕</IconButton>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                {t('fulfillment.profile.selectStateHint')}
              </div>
            )}
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
