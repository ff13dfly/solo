import { useState, useEffect } from 'react';
import { callRpc } from '../../../../utils/rpc';
import { useUI } from '../../../../providers/UIProvider';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../components/ui';
import type { Transition, Profile } from './types';
import { SYSTEM_STATES, STATE_COLOR } from './types';
import { TransitionEditor } from './TransitionEditor';

interface Props {
  profile: Profile | null;
  onClose: () => void;
  onSaved: () => void;
}

function NavGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: '10px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.08em', padding: '4px 8px', marginBottom: '2px', display: 'flex', gap: '6px' }}>
        {label} <span style={{ fontWeight: 400, color: '#94a3b8' }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

export function ProfileEditModal({ profile, onClose, onSaved }: Props) {
  const { toast } = useUI();
  const { t } = useLang();
  const [saving, setSaving] = useState(false);
  const [sentinels, setSentinels] = useState<any[]>([]);

  useEffect(() => {
    callRpc<{ items: any[] }>('nexus.sentinel.list', { page: 1, pageSize: 100 })
      .then(r => setSentinels(r?.items ?? []))
      .catch(() => {});
  }, []);

  const states = profile?.states ?? [...SYSTEM_STATES];
  const stateMeta = profile?.state_meta ?? {};
  const metaFields = profile?.meta_fields ?? [];
  const [transitions, setTrans] = useState<Transition[]>(profile?.transitions ?? []);
  const bizStates = states.filter(s => !SYSTEM_STATES.includes(s));
  const [selected, setSelected] = useState<number>(() => transitions.length > 0 ? 0 : -1);
  const [hoveredTr, setHoveredTr] = useState<number | null>(null);

  const addTransition = () => {
    const next = [...transitions, { event: '', from: bizStates[0] ?? '', to: bizStates[1] ?? bizStates[0] ?? '', condition: null, actions: [] }];
    setTrans(next);
    setSelected(next.length - 1);
  };

  const generateScaffold = () => {
    const existing = new Set(transitions.map(t => `${t.from}|${t.to}`));
    const toAdd: Transition[] = [];
    for (let i = 0; i < bizStates.length - 1; i++) {
      const from = bizStates[i], to = bizStates[i + 1];
      if (!existing.has(`${from}|${to}`)) {
        toAdd.push({ event: '', from, to, condition: null, actions: [] });
      }
    }
    if (toAdd.length === 0) return;
    const next = [...transitions, ...toAdd];
    setTrans(next);
    setSelected(transitions.length);
  };

  const updTransition = (i: number, t: Transition) => setTrans(prev => prev.map((x, idx) => idx === i ? t : x));
  const delTransition = (i: number) => {
    setTrans(prev => prev.filter((_, idx) => idx !== i));
    setSelected(transitions.length > 1 ? Math.max(0, i - 1) : -1);
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      await callRpc('fulfillment.profile.update', { id: profile.id, transitions });
      toast.success(t('common.save_success'));
      onSaved();
    } catch (err: any) {
      toast.error(err.message || t('common.save_fail'));
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" style={{ background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: '960px', height: '80vh', background: '#fff', borderRadius: '12px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.18)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: 700, fontSize: '15px' }}>{t('fulfillment.transitions_title')}</span>
            <code style={{ fontSize: '12px', background: '#f1f5f9', padding: '3px 10px', borderRadius: '5px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{profile?.id}</code>
          </div>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* Left nav */}
          <div style={{ width: '220px', flexShrink: 0, borderRight: '1px solid var(--border-color)', overflowY: 'auto', background: '#fafafa', padding: '10px 10px' }}>
            <NavGroup label="TRANSITIONS" count={transitions.length}>
              {transitions.map((tr, i) => {
                const isSel = selected === i;
                const isHov = hoveredTr === i;
                return (
                  <div key={i}
                    onClick={() => setSelected(i)}
                    onMouseEnter={() => setHoveredTr(i)}
                    onMouseLeave={() => setHoveredTr(null)}
                    style={{ padding: '5px 8px', borderRadius: '5px', cursor: 'pointer', marginBottom: '1px', position: 'relative',
                      background: isSel ? 'var(--accent-surface)' : isHov ? '#f0f4f8' : 'transparent',
                      border: `1px solid ${isSel ? '#dbeafe' : 'transparent'}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingRight: isHov ? '20px' : '4px' }}>
                      {tr.condition && <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#f59e0b', flexShrink: 0, display: 'inline-block' }} />}
                      <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: isSel ? 600 : 400, color: isSel ? 'var(--accent-color)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tr.event || <span style={{ color: '#94a3b8', fontStyle: 'italic', fontWeight: 400 }}>{t('fulfillment.transition.unnamed')}</span>}
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '2px', overflow: 'hidden' }}>
                      <span style={{ color: STATE_COLOR[tr.from] || '#94a3b8', flexShrink: 0 }}>●</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '62px' }}>{stateMeta[tr.from]?.label?.zh || tr.from}</span>
                      <span style={{ flexShrink: 0 }}>→</span>
                      <span style={{ color: STATE_COLOR[tr.to] || '#94a3b8', flexShrink: 0 }}>●</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '62px' }}>{stateMeta[tr.to]?.label?.zh || tr.to}</span>
                    </div>
                    {isHov && (
                      <button onClick={e => { e.stopPropagation(); delTransition(i); }}
                        style={{ position: 'absolute', top: '6px', right: '6px', background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', fontSize: '11px', padding: 0, lineHeight: 1 }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#cbd5e1')}>✕</button>
                    )}
                  </div>
                );
              })}
              <button onClick={addTransition} style={{ marginTop: '4px', width: '100%', background: 'none', border: '1px dashed #cbd5e1', borderRadius: '4px', padding: '4px', fontSize: '10px', color: '#94a3b8', cursor: 'pointer' }}>+ {t('common.add')}</button>
              {bizStates.length >= 2 && (
                <button onClick={generateScaffold} style={{ marginTop: '4px', width: '100%', background: 'none', border: '1px dashed #bfdbfe', borderRadius: '4px', padding: '4px', fontSize: '10px', color: '#93c5fd', cursor: 'pointer' }}>⚡ {t('fulfillment.transition.generateFromStates')}</button>
              )}
            </NavGroup>
          </div>

          {/* Right panel */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selected >= 0 && transitions[selected] ? (
              <TransitionEditor key={selected} transition={transitions[selected]} onChange={t => updTransition(selected, t)} metaFields={metaFields} states={states} stateMeta={stateMeta} sentinels={sentinels} profileId={profile?.id ?? ''} />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>{t('fulfillment.transition.emptyHint')}</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: '8px', flexShrink: 0, background: '#fafafa' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="tonal" size="sm" onClick={handleSave} disabled={saving} style={{ minWidth: '80px' }}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
