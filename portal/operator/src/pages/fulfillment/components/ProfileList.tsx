import { useState, useEffect } from 'react';
import { callRpc } from '../../../utils/rpc';
import { useLang } from '../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../components/ui';
import { STATE_COLOR, SYSTEM_STATES } from './transitions/types';
import type { MetaField, MetaFieldSource, Profile, StateMeta, Lang, ErpView } from './transitions/types';

interface Props {
  profiles: Profile[];
  onEdit: (p: Profile) => void;
  onStatesUpdated: () => void;
}

// ─── Sentinel watchers (nexus ↔ fulfillment linkage) ─────────────────────────
// A sentinel watches a profile indirectly: it subscribes to EVENT:FULFILLMENT:*
// and (optionally) pins ONE profile via a JsonLogic guard on event.payload.profileId.
// Surface that linkage here so the profile view answers "who reacts to my transitions?"
// without hopping to the system portal.

interface WatcherSentinel { id: string; name: string; status?: string; pinned: boolean }

// Conservative JsonLogic walk: find { '==': [ {var:'event.payload.profileId'}, '<id>' ] }
// anywhere in the guard (either operand order). Anything fancier than an equality pin
// is treated as stream-wide (shown, not hidden — over-reporting beats invisibility).
function extractProfilePin(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) { const f = extractProfilePin(item); if (f) return f; }
    return null;
  }
  for (const [op, args] of Object.entries(node as Record<string, unknown>)) {
    if (op === '==' && Array.isArray(args) && args.length === 2) {
      const [a, b] = args as any[];
      const isPinVar = (x: any) => x && typeof x === 'object' && x.var === 'event.payload.profileId';
      if (isPinVar(a) && typeof b === 'string') return b;
      if (isPinVar(b) && typeof a === 'string') return a;
    }
    const found = extractProfilePin(args);
    if (found) return found;
  }
  return null;
}

function watchersFor(profileId: string, sentinels: any[]): WatcherSentinel[] {
  return sentinels
    .filter(s => (s.eventSubscriptions || []).some((k: unknown) => String(k).startsWith('EVENT:FULFILLMENT')))
    .map(s => ({ s, pin: extractProfilePin(s.context?.guard) }))
    .filter(({ pin }) => pin === null || pin === profileId)
    .map(({ s, pin }) => ({ id: s.id, name: s.name, status: s.status, pinned: pin === profileId }));
}

function formatDate(ts?: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Raw Modal ────────────────────────────────────────────────────────────────

function RawModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
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

// ─── States Edit Modal ────────────────────────────────────────────────────────

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

function StatesModal({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
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

// ─── BasicInfoModal ───────────────────────────────────────────────────────────

function BasicInfoModal({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
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

// ─── MetaFieldsModal ──────────────────────────────────────────────────────────

function MetaFieldsModal({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
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

// ─── ProfileCard ──────────────────────────────────────────────────────────────

function ProfileCard({ profile, onEdit, onStatesUpdated, watchers }: { profile: Profile; onEdit: () => void; onStatesUpdated: () => void; watchers: WatcherSentinel[] | null }) {
  const { t } = useLang();
  const tr = t; // alias: the transitions .map() below shadows `t` with the transition object
  const [showRaw, setShowRaw] = useState(false);
  const [showStates, setShowStates] = useState(false);
  const [showBasic, setShowBasic] = useState(false);
  const [showMetaFields, setShowMetaFields] = useState(false);
  const states = profile.states ?? [];
  const metaFields: MetaField[] = profile.meta_fields ?? [];
  const isActive = profile.status !== 'DELETED';

  return (
    <div
      style={{ background: '#fff', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px', transition: 'border-color 0.15s' }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent-color)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-color)')}
    >
      {/* ── Name + status + description ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', marginBottom: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.name || '—'}</div>
          <code style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{profile.id}</code>
          {profile.description && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5', marginTop: '6px' }}>{profile.description}</div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
          <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '20px', background: isActive ? '#dcfce7' : '#f1f5f9', color: isActive ? '#16a34a' : 'var(--text-secondary)', letterSpacing: '0.04em' }}>
            {profile.status || 'ACTIVE'}
          </span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <Button variant="secondary" size="sm" onClick={() => setShowBasic(true)}>Edit</Button>
            <Button variant="secondary" size="sm" onClick={() => setShowRaw(true)}>{t('common.view_raw')}</Button>
          </div>
        </div>
      </div>

      {/* ── States ── */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>
            STATES <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: '4px' }}>{states.filter(s => !SYSTEM_STATES.includes(s)).length}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowStates(true)}>Edit</Button>
        </div>
        {states.filter(s => !SYSTEM_STATES.includes(s)).length === 0 ? (
          <div style={{ fontSize: '11px', color: '#cbd5e1', fontStyle: 'italic' }}>{t('fulfillment.profile.notConfigured')}</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {states.filter(s => !SYSTEM_STATES.includes(s)).map(s => {
              const label = profile.state_meta?.[s]?.label?.zh;
              return (
                <span key={s} title={s} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', background: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '2px 7px' }}>
                  <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: STATE_COLOR[s] || '#94a3b8', display: 'inline-block', flexShrink: 0 }} />
                  {label || s}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Meta Fields ── */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>
            META FIELDS <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: '4px' }}>{metaFields.length}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowMetaFields(true)}>Edit</Button>
        </div>
        {metaFields.length === 0 ? (
          <div style={{ fontSize: '11px', color: '#cbd5e1', fontStyle: 'italic' }}>{t('fulfillment.profile.notConfigured')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {metaFields.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', flexShrink: 0 }}>{f.key}</code>
                <span style={{ color: '#cbd5e1', flexShrink: 0 }}>·</span>
                <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
                {f.source ? (
                  <span style={{ color: '#3b82f6', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>→ {f.source.service}.{f.source.method}</span>
                ) : (
                  <span style={{ color: '#cbd5e1', flexShrink: 0 }}>{t('fulfillment.profile.manual')}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Transitions ── */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>
            TRANSITIONS <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: '4px' }}>{(profile.transitions || []).length}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={onEdit}>Edit</Button>
        </div>
        {(profile.transitions || []).length === 0 ? (
          <div style={{ fontSize: '11px', color: '#cbd5e1', fontStyle: 'italic' }}>{t('fulfillment.profile.notConfigured')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {(profile.transitions || []).slice(0, 4).map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.event || '—'}</span>
                <span style={{ color: '#cbd5e1', flexShrink: 0 }}>{t.from} → {t.to}</span>
                {t.condition && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f59e0b', flexShrink: 0, display: 'inline-block' }} title={tr('fulfillment.profile.hasCondition')} />}
              </div>
            ))}
            {(profile.transitions || []).length > 4 && (
              <div style={{ fontSize: '10px', color: '#94a3b8' }}>{t('fulfillment.profile.moreTransitions', { count: (profile.transitions || []).length - 4 })}</div>
            )}
          </div>
        )}
      </div>

      {/* ── Sentinels (nexus watchers) — hidden when the list isn't readable ── */}
      {watchers !== null && (
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }} data-test="profile-watchers">
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.08em', marginBottom: '8px' }}>
            SENTINELS <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: '4px' }}>{watchers.length}</span>
          </div>
          {watchers.length === 0 ? (
            <div style={{ fontSize: '11px', color: '#cbd5e1', fontStyle: 'italic' }}>{t('fulfillment.profile.noWatchers')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {watchers.map(w => (
                <div key={w.id} data-test="watcher-row" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: w.status === 'ACTIVE' ? '#10b981' : '#94a3b8', flexShrink: 0, display: 'inline-block' }} title={w.status} />
                  <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.id}>{w.name}</span>
                  <span style={{ fontSize: '9px', color: w.pinned ? '#3b82f6' : '#94a3b8', background: w.pinned ? '#eff6ff' : '#f8fafc', border: `1px solid ${w.pinned ? '#bfdbfe' : 'var(--border-color)'}`, padding: '1px 6px', borderRadius: '4px', flexShrink: 0 }}>
                    {w.pinned ? t('fulfillment.profile.watcherPinned') : t('fulfillment.profile.watcherStream')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Footer ── */}
      <div style={{ paddingTop: '4px' }}>
        <span style={{ fontSize: '11px', color: '#94a3b8' }}>{formatDate(profile.updatedAt || profile.createdAt)}</span>
      </div>

      {showRaw && <RawModal profile={profile} onClose={() => setShowRaw(false)} />}
      {showStates && <StatesModal profile={profile} onClose={() => setShowStates(false)} onSaved={onStatesUpdated} />}
      {showBasic && <BasicInfoModal profile={profile} onClose={() => setShowBasic(false)} onSaved={onStatesUpdated} />}
      {showMetaFields && <MetaFieldsModal profile={profile} onClose={() => setShowMetaFields(false)} onSaved={onStatesUpdated} />}
    </div>
  );
}

// ─── ProfileList ──────────────────────────────────────────────────────────────

export function ProfileList({ profiles, onEdit, onStatesUpdated }: Props) {
  const { t } = useLang();

  // One sentinel fetch for the whole list (not per card). null = unreadable
  // (operator lacks nexus permission / nexus down) → the section hides entirely.
  const [sentinels, setSentinels] = useState<any[] | null>(null);
  useEffect(() => {
    callRpc<{ items: any[] }>('nexus.sentinel.list', { page: 1, pageSize: 100 })
      .then(r => setSentinels(r?.items ?? []))
      .catch(() => setSentinels(null));
  }, []);

  if (profiles.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
        {t('fulfillment.profile.emptyState')}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', padding: '16px', alignItems: 'start' }}>
      {profiles.map(p => (
        <ProfileCard
          key={p.id}
          profile={p}
          onEdit={() => onEdit(p)}
          onStatesUpdated={onStatesUpdated}
          watchers={sentinels === null ? null : watchersFor(p.id, sentinels)}
        />
      ))}
    </div>
  );
}
