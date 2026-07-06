import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServices } from '../../providers/ServicesProvider';
import { EntityTabs } from '../default/EntityTabs';
import { EntityEditModal } from '../default/EntityEditModal';
import { GenericList } from '../default/GenericList';
import { prepareEntityForEditing } from '../default/EntityUtils';
import { FulfillmentCard } from './components/FulfillmentCard';
import { ProfileEditModal } from './components/transitions';
import { ProfileList } from './components/ProfileList';
import { InstanceDetailModal } from './components/InstanceDetailModal';
import { InstanceTraceModal } from './components/InstanceTraceModal';
import { callRpc } from '../../utils/rpc';
import { useEntityQuery } from '../default/hooks/useEntityQuery';
import { useLang } from '../../providers/LanguageProvider';
import { Button, IconButton } from '../../components/ui';

function NewProfileModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [description, setDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) { setError(t('fulfillment.profile.nameRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      // clientId:true — derive a slug id from name; server rejects if already taken.
      const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || `p_${Date.now()}`;
      await callRpc('fulfillment.profile.create', { id, name: name.trim(), description: description.trim() });
      onSaved();
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
          <span style={{ fontWeight: 700 }}>{t('fulfillment.new_profile')}</span>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>{t('fulfillment.label_name')}</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('fulfillment.profile.namePlaceholder')}
              style={{ fontSize: '13px' }}
              autoFocus
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>{t('fulfillment.label_description')}</label>
            <textarea
              value={description}
              onChange={e => setDesc(e.target.value)}
              placeholder={t('fulfillment.profile.descPlaceholder')}
              rows={3}
              style={{ resize: 'vertical', lineHeight: '1.6' }}
            />
          </div>
        </div>
        <div className="modal-footer">
          {error && <span style={{ fontSize: '12px', color: '#ef4444', marginRight: 'auto' }}>{error}</span>}
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="tonal"
            size="sm"
            onClick={handleCreate}
            disabled={saving || !name.trim()}
          >
            {saving ? t('common.saving') : t('common.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Describe → generate: NL requirement → fulfillment.profile.generate (LLM + lint + repair)
// → review the lint-gated candidate → create. The candidate is created EXACTLY as the
// server validated it (no client-side edits that would bypass the lint gate; tweak after
// create via the transitions editor).
function GenerateProfileModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const tt = (k: string, d: string) => t(`fulfillment.generate.${k}`, { defaultValue: d });
  const [requirement, setRequirement] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null); // { profile, lintReport:{errors,warnings}, attempts, ok }

  const handleGenerate = async () => {
    if (!requirement.trim()) { setError(tt('need_requirement', 'Describe the fulfillment flow first.')); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await callRpc<any>('fulfillment.profile.generate', { requirement: requirement.trim() });
      setResult(r);
    } catch (err: any) {
      setError(err.message || tt('gen_fail', 'Generation failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!result?.profile) return;
    setCreating(true); setError(null);
    try {
      const profile = { ...result.profile };
      if (!profile.id) {
        profile.id = String(profile.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || `p_${Date.now()}`;
      }
      await callRpc('fulfillment.profile.create', profile);
      onSaved();
    } catch (err: any) {
      setError(err.message || t('common.save_fail'));
    } finally {
      setCreating(false);
    }
  };

  const errors: string[] = result?.lintReport?.errors || [];
  const warnings: string[] = result?.lintReport?.warnings || [];

  return (
    <div className="modal-overlay" style={{ background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: '640px', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <span style={{ fontWeight: 700 }}>✨ {tt('title', 'Generate profile from a description')}</span>
          <IconButton variant="ghost" onClick={onClose}>✕</IconButton>
        </div>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>{tt('requirement', 'Requirement (natural language)')}</label>
            <textarea
              value={requirement}
              onChange={e => setRequirement(e.target.value)}
              placeholder={tt('placeholder', 'e.g. Orders collect payment, then need review before release; approve & amount ≤ 50000 → confirm, otherwise hold.')}
              rows={4}
              style={{ resize: 'vertical', lineHeight: '1.6', fontSize: '13px' }}
              autoFocus
            />
            <div style={{ alignSelf: 'flex-end' }}>
              <Button variant="tonal" size="sm" onClick={handleGenerate} disabled={loading || !requirement.trim()}>
                {loading ? tt('generating', 'Generating…') : tt('generate', 'Generate')}
              </Button>
            </div>
          </div>

          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* verdict */}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px',
                  color: result.ok ? '#16a34a' : '#dc2626', background: result.ok ? '#f0fdf4' : '#fef2f2', border: `1px solid ${result.ok ? '#bbf7d0' : '#fecaca'}` }}>
                  {result.ok ? tt('ok', '✓ Lint clean — activatable') : tt('rejected', `✗ ${errors.length} error(s)`)}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{tt('attempts', 'attempts')}: {result.attempts}</span>
              </div>
              {/* lint errors */}
              {errors.length > 0 && (
                <div style={{ fontSize: '12px', color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', padding: '8px 10px' }}>
                  {errors.map((e, i) => <div key={i}>✗ {e}</div>)}
                </div>
              )}
              {/* lint warnings (advisory) */}
              {warnings.length > 0 && (
                <details style={{ fontSize: '11px', color: '#b45309' }}>
                  <summary style={{ cursor: 'pointer' }}>{tt('warnings', 'warnings')} ({warnings.length})</summary>
                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '8px 10px', marginTop: '4px' }}>
                    {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                  </div>
                </details>
              )}
              {/* candidate */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>{tt('candidate', 'Candidate profile')}</label>
                <pre style={{ margin: 0, fontSize: '11px', lineHeight: 1.5, padding: '10px 12px', borderRadius: '6px', background: 'var(--bg-color, #f9fafb)', border: '1px solid var(--border-color, #e5e7eb)', overflowX: 'auto', maxHeight: '260px' }}>
                  {JSON.stringify(result.profile, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {error && <span style={{ fontSize: '12px', color: '#ef4444', marginRight: 'auto' }}>{error}</span>}
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="tonal"
            size="sm"
            onClick={handleCreate}
            disabled={creating || !result?.ok}
            title={result && !result.ok ? tt('fix_first', 'Resolve lint errors before creating') : ''}
          >
            {creating ? t('common.saving') : t('common.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function FulfillmentPage() {
  const { t } = useLang();
  const serviceId = 'fulfillment';
  const queryClient = useQueryClient();
  const { services } = useServices();
  const service = services.find(s => s.id === serviceId);

  const entities = service?.entities || {};
  const entityNames = Object.keys(entities);
  const [activeEntity, setActiveEntity] = useState<string>('');

  useEffect(() => {
    if (entityNames.length > 0 && !activeEntity) {
      setActiveEntity(entityNames.includes('profile') ? 'profile' : entityNames[0]);
    }
  }, [entityNames, activeEntity]);

  // ── Profiles (for cascading filter) ──────────────────────────────────────
  const { data: profilesData } = useQuery({
    queryKey: ['fulfillment-profiles'],
    queryFn: () => callRpc<{ items: any[] }>('fulfillment.profile.list'),
    enabled: activeEntity === 'instance'
  });
  const profiles = profilesData?.items || [];

  // ── Instance cascading filter ─────────────────────────────────────────────
  const [profileFilter, setProfileFilter] = useState<string>('');
  const [stateFilter, setStateFilter] = useState<string>('');

  const selectedProfile = profiles.find((p: any) => p.id === profileFilter);
  const availableStates: string[] = selectedProfile?.states ?? [];

  // ── Instance detail modal ────────────────────────────────────────────────
  const [instanceTarget, setInstanceTarget] = useState<any | null>(null);
  // ── Instance execution-trace modal (the full chain behind an instance) ────
  const [traceTarget, setTraceTarget] = useState<any | null>(null);

  // ── Generic edit modal (used for other entities) ─────────────────────────
  const [editingData, setEditingData] = useState<any | null>(null);
  const [editContent, setEditContent] = useState<string>('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Profile modals ───────────────────────────────────────────────────────
  const [profileTarget, setProfileTarget] = useState<any | null>(null); // null = closed, object = edit transitions
  const profileModalOpen = profileTarget !== null;
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);

  const currentEntityDef = entities[activeEntity];

  const { data: queryData, isLoading: dataLoading } = useEntityQuery({
    serviceId,
    activeEntity,
    page: 1,
    pageSize: 100,
    keyword: ''
  });

  const allItems = queryData?.items || [];
  const profileItems = profileFilter
    ? allItems.filter((i: any) => i.profileId === profileFilter)
    : allItems;
  const items = stateFilter
    ? profileItems.filter((i: any) => i.state === stateFilter)
    : profileItems;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const startEditing = (item: any) => {
    if (activeEntity === 'profile') {
      setProfileTarget(item);
      return;
    }
    if (activeEntity === 'instance') {
      setInstanceTarget(item);
      return;
    }
    setEditingData(item);
    setEditContent(JSON.stringify(prepareEntityForEditing(item, currentEntityDef), null, 2));
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!serviceId || !activeEntity || !editingData) return;
    try {
      const parsed = JSON.parse(editContent);
      setSaveLoading(true);
      setSaveError(null);
      await callRpc(`${serviceId}.${activeEntity}.update`, { id: editingData.id, ...parsed });
      setEditingData(null);
      queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });
    } catch (err: any) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaveLoading(false);
    }
  };

  const handleProfileSaved = () => {
    setProfileTarget(null);
    queryClient.invalidateQueries({ queryKey: ['entities', serviceId, 'profile'] });
  };

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });

  return (
    <div className="service-mgr-container">
      <EntityTabs
        entityNames={entityNames}
        activeEntity={activeEntity}
        setActiveEntity={setActiveEntity}
        serviceId={serviceId}
      />

      <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('fulfillment.title', { entity: activeEntity.toUpperCase() })}</span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {activeEntity === 'instance' && (<>
              <select
                value={profileFilter}
                onChange={e => { setProfileFilter(e.target.value); setStateFilter(''); }}
                className="service-btn"
                style={{ cursor: 'pointer' }}
              >
                <option value=''>{t('fulfillment.filter_all_profiles')}</option>
                {profiles.map((p: any) => {
                  const count = allItems.filter((i: any) => i.profileId === p.id).length;
                  return <option key={p.id} value={p.id}>{p.name || p.id} ({count})</option>;
                })}
              </select>
              <select
                value={stateFilter}
                onChange={e => setStateFilter(e.target.value)}
                className="service-btn"
                style={{ cursor: 'pointer' }}
                disabled={!profileFilter}
              >
                <option value=''>{t('fulfillment.filter_all_states', { n: profileItems.length })}</option>
                {availableStates.map(s => {
                  const count = allItems.filter((i: any) => i.profileId === profileFilter && i.state === s).length;
                  return <option key={s} value={s}>{s} ({count})</option>;
                })}
              </select>
            </>)}
            {activeEntity === 'profile' && (<>
              <Button
                variant="tonal"
                size="sm"
                onClick={() => setShowGenerate(true)}
                title={t('fulfillment.generate.title', { defaultValue: 'Generate profile from a description' })}
              >
                ✨ {t('fulfillment.generate.button', { defaultValue: 'Describe → Generate' })}
              </Button>
              <Button
                variant="tonal"
                size="sm"
                onClick={() => setShowNewProfile(true)}
              >
                {t('common.new')}
              </Button>
            </>)}
            <Button variant="secondary" size="sm" onClick={invalidate}>{t('common.refresh')}</Button>
          </div>
        </div>

        <div className="panel-content" style={{ flex: 1, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activeEntity === 'instance' ? (
            <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
              {dataLoading ? (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('fulfillment.page.requestingData')}</div>
              ) : items.length === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('common.no_data')}</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', alignItems: 'start' }}>
                  {items.map((inst: any) => (
                    <FulfillmentCard key={inst.id} instance={inst} onClick={() => startEditing(inst)} onTrace={() => setTraceTarget(inst)} />
                  ))}
                </div>
              )}
            </div>
          ) : activeEntity === 'profile' ? (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <ProfileList profiles={items} onEdit={startEditing} onStatesUpdated={() => queryClient.invalidateQueries({ queryKey: ['entities', serviceId, 'profile'] })} />
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <GenericList
                items={items}
                entityDef={currentEntityDef}
                onViewRaw={startEditing}
                serviceId={serviceId}
                activeEntity={activeEntity}
              />
            </div>
          )}
        </div>
      </div>

      {/* Describe → generate profile modal */}
      {showGenerate && (
        <GenerateProfileModal
          onClose={() => setShowGenerate(false)}
          onSaved={() => { setShowGenerate(false); handleProfileSaved(); }}
        />
      )}

      {/* New profile create modal */}
      {showNewProfile && (
        <NewProfileModal
          onClose={() => setShowNewProfile(false)}
          onSaved={() => { setShowNewProfile(false); handleProfileSaved(); }}
        />
      )}

      {/* Profile transitions editor modal */}
      {profileModalOpen && (
        <ProfileEditModal
          profile={profileTarget}
          onClose={() => setProfileTarget(null)}
          onSaved={handleProfileSaved}
        />
      )}

      {/* Instance detail modal */}
      {instanceTarget && (
        <InstanceDetailModal
          instance={instanceTarget}
          onClose={() => setInstanceTarget(null)}
          onUpdated={invalidate}
        />
      )}

      {/* Instance execution-trace modal */}
      {traceTarget && (
        <InstanceTraceModal
          instance={traceTarget}
          onClose={() => setTraceTarget(null)}
        />
      )}

      {/* Generic modal for other entities */}
      {activeEntity !== 'profile' && activeEntity !== 'instance' && (
        <EntityEditModal
          activeEntity={activeEntity}
          entityDef={currentEntityDef}
          editingData={editingData}
          editContent={editContent}
          setEditContent={setEditContent}
          saveLoading={saveLoading}
          saveError={saveError}
          onClose={() => setEditingData(null)}
          onSave={handleSave}
          mode="edit"
        />
      )}
    </div>
  );
}
