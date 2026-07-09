import { useState, useEffect } from 'react';
import { callRpc } from '../../../../utils/rpc';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button } from '../../../../components/ui';
import { STATE_COLOR, SYSTEM_STATES } from '../transitions/types';
import type { MetaField, Profile } from '../transitions/types';
import { watchersFor, formatDate } from './utils';
import type { WatcherSentinel } from './utils';
import { RawModal } from './RawModal';
import { SentinelCard } from '../SentinelCard';
import { StatesModal } from './StatesModal';
import { BasicInfoModal } from './BasicInfoModal';
import { MetaFieldsModal } from './MetaFieldsModal';
import { useUI } from '../../../../providers/UIProvider';

interface Props {
  profiles: Profile[];
  onEdit: (p: Profile) => void;
  onStatesUpdated: () => void;
}

// ─── ProfileCard ──────────────────────────────────────────────────────────────

function ProfileCard({
  profile,
  onEdit,
  onStatesUpdated,
  watchers,
  togglingId,
  onToggleSentinel
}: {
  profile: Profile;
  onEdit: () => void;
  onStatesUpdated: () => void;
  watchers: WatcherSentinel[] | null;
  togglingId: string | null;
  onToggleSentinel: (id: string, status: string) => void;
}) {
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', marginTop: '6px' }}>
              {watchers.map(w => (
                <SentinelCard
                  key={w.id}
                  id={w.id}
                  name={w.name}
                  status={w.status || 'DISABLED'}
                  targetState={w.targetState}
                  pinned={w.pinned}
                  togglingId={togglingId}
                  onToggleStatus={onToggleSentinel}
                />
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
  const { toast } = useUI();

  // One sentinel fetch for the whole list (not per card). null = unreadable
  // (operator lacks nexus permission / nexus down) → the section hides entirely.
  const [sentinels, setSentinels] = useState<any[] | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadSentinels = () => {
    callRpc<{ items: any[] }>('nexus.sentinel.list', { page: 1, pageSize: 100 })
      .then(r => setSentinels(r?.items ?? []))
      .catch(() => setSentinels(null));
  };

  useEffect(() => {
    loadSentinels();
  }, []);

  const handleToggleSentinel = async (id: string, currentStatus: string) => {
    setTogglingId(id);
    try {
      if (currentStatus === 'ACTIVE') {
        await callRpc('nexus.sentinel.disable', { id });
      } else {
        await callRpc('nexus.sentinel.enable', { id });
      }
      loadSentinels();
    } catch (err: any) {
      toast.error(err.message || 'Failed to toggle sentinel status');
    } finally {
      setTogglingId(null);
    }
  };

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
          togglingId={togglingId}
          onToggleSentinel={handleToggleSentinel}
        />
      ))}
    </div>
  );
}
