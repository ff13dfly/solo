import { useState, useEffect } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { callRpc } from '../../utils/rpc';
import { useServices } from '../../providers/ServicesProvider';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { GenericList } from './GenericList';
import { EntityTabs } from './EntityTabs';
import { EntityHeader } from './EntityHeader';
import { EntityPagination } from './EntityPagination';
import { EntityEditModal } from './EntityEditModal';
import { prepareEntityForEditing, prepareEntityForCreation } from './EntityUtils';
import { RecycleBinModal } from './RecycleBinModal';
import { useEntityQuery } from './hooks/useEntityQuery';
import { Button } from '../../components/ui';
import './DefaultPage.css';

interface GenericEntityPageProps {
  serviceId?: string;
}

export default function GenericEntityPage({ serviceId: propServiceId }: GenericEntityPageProps) {
  const { serviceId: paramServiceId } = useParams<{ serviceId: string }>();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { t } = useLang();

  // Robust serviceId detection: prop > param > path
  const pathServiceId = location.pathname.split('/')[1];
  const serviceId = propServiceId || paramServiceId || pathServiceId;

  const { services, loading: servicesLoading } = useServices();
  const { toast } = useUI();
  const service = services.find(s => s.id === serviceId);

  const [activeEntity, setActiveEntity] = useState<string>('');
  const [keywords, setKeywords] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const pageSize = 12;
  const currentKeyword = keywords[activeEntity] || '';

  const { data: queryData, isLoading: dataLoading, error: dataError } = useEntityQuery({
    serviceId: serviceId || '',
    activeEntity,
    page,
    pageSize,
    keyword: currentKeyword
  });

  const data = queryData?.items || [];
  const total = queryData?.total || 0;

  const [editingData, setEditingData] = useState<any | null>(null);
  // What the edit modal OPENED with. Save diffs against this and submits only the
  // fields the operator actually changed (the entity factory's update is a merge,
  // so unsent fields are untouched server-side).
  const [editBaseline, setEditBaseline] = useState<any | null>(null);
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [editContent, setEditContent] = useState<string>('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);

  const entities = service?.entities || {};
  const entityNames = Object.keys(entities);
  const currentEntityDef = entities[activeEntity];

  // Reset paging + recycle bin whenever the target service or entity changes.
  useEffect(() => {
    setPage(1);
    setIsRecycleBinOpen(false);
  }, [serviceId, activeEntity]);

  // Default to the first entity, AND correct a stale selection after switching services.
  // This route reuses one GenericEntityPage instance across services, so a previous service's
  // entity can linger and render a non-existent one (e.g. "PLANNER / SHIPMENT" with no matching
  // tab). Re-seed whenever the current selection isn't a valid entity of this service.
  const entityKey = entityNames.join('|');
  useEffect(() => {
    if (entityNames.length > 0 && !entityNames.includes(activeEntity)) {
      setActiveEntity(entityNames[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, entityKey]);

  // Edit against the FULL record, not the list row. Services legitimately strip
  // heavy fields from `list` (payload budget); the row is a projection, not the
  // record. If the entity declares `.get`, fetch it before opening the modal — that
  // is what makes the content authoritative (and lets EntityUtils add placeholders
  // safely). Fallback: open with the row, but then absent fields stay absent instead
  // of being fabricated as empty.
  // See docs/feedback/done/operator-generic-page-fabricates-empty-fields.md.
  const startEditing = async (item: any) => {
    setIsCreateMode(false);
    setSaveError(null);
    const getMethod = `${serviceId}.${activeEntity}.get`;
    const hasGet = !!service?.methods?.some((m: any) => m?.name === getMethod);
    let record = item;
    let authoritative = false;
    if (hasGet && item?.id) {
      try {
        const full = await callRpc<any>(getMethod, { id: item.id });
        if (full && full.id === item.id) {
          record = full;
          authoritative = true;
        }
      } catch (err) {
        console.warn(`Edit: ${getMethod} failed, falling back to the list row`, err);
        toast.info(t('entity.editPartialRow', { defaultValue: 'Could not load the full record — editing the list row; fields not shown will be left untouched.' }));
      }
    }
    const editableData = prepareEntityForEditing(record, currentEntityDef, authoritative);
    setEditingData(record);
    setEditBaseline(editableData);
    setEditContent(JSON.stringify(editableData, null, 2));
  };

  const startCreating = () => {
    setIsCreateMode(true);
    const template = prepareEntityForCreation(currentEntityDef);
    setEditingData({}); // Truthy to open modal
    setEditBaseline(null);
    setEditContent(JSON.stringify(template, null, 2));
    setSaveError(null);
  };

  // Lock body scroll when any modal is open
  useEffect(() => {
    const isModalOpen = !!editingData || isRecycleBinOpen;
    if (isModalOpen) {
      document.body.style.overflow = 'hidden';
      document.body.style.paddingRight = '15px';
    } else {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [editingData, isRecycleBinOpen]);

  const handleSave = async () => {
    if (!serviceId || !activeEntity || !editingData) return;

    try {
      const parsed = JSON.parse(editContent);
      setSaveLoading(true);
      setSaveError(null);

      const method = isCreateMode ? 'create' : 'update';
      let payload = parsed;
      if (!isCreateMode) {
        // PATCH semantics: submit only what the operator changed. This is the last
        // line of defense against writing back values the operator never typed —
        // e.g. RJSF materializing defaults for fields the server never returned.
        const deepEmpty = (v: any) =>
          v === '' ||
          (Array.isArray(v) && v.length === 0) ||
          (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
        const changed: any = {};
        Object.keys(parsed).forEach((k) => {
          const hadKey = editBaseline ? Object.prototype.hasOwnProperty.call(editBaseline, k) : false;
          if (hadKey && JSON.stringify(parsed[k]) === JSON.stringify(editBaseline[k])) return; // untouched
          // A field the modal never showed (absent from the baseline) arriving as an
          // empty value is fabricated, not an edit — do not submit it.
          if (!hadKey && deepEmpty(parsed[k])) return;
          changed[k] = parsed[k];
        });
        if (Object.keys(changed).length === 0) {
          // Nothing actually changed — close without issuing a write.
          setEditingData(null);
          setEditBaseline(null);
          setSaveLoading(false);
          return;
        }
        changed.id = editingData.id;
        payload = changed;
      }

      await callRpc(`${serviceId}.${activeEntity}.${method}`, payload);

      setEditingData(null);
      setEditBaseline(null);
      queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });
    } catch (err: any) {
      console.error("Save failed:", err);
      setSaveError(err.message || "Invalid JSON or Server Error");
    } finally {
      setSaveLoading(false);
    }
  };

  const handleRemove = async (item: any) => {
    if (!serviceId || !activeEntity || !item.id) return;

    try {
      await callRpc(`${serviceId}.${activeEntity}.delete`, { id: item.id });
      queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });
    } catch (err: any) {
      console.error("Delete failed:", err);
      toast.error(err.message || "Delete failed");
    }
  };

  if (servicesLoading) {
    return <div style={{ padding: '24px', color: '#64748b' }}>{t('default.loading_metadata')}</div>;
  }

  if (!serviceId) {
    return <div style={{ padding: '24px', color: '#ef4444' }}>{t('default.error_no_service')}</div>;
  }

  if (!service) {
    return (
      <div style={{ padding: '24px', color: '#64748b' }}>
        {t('default.service_not_found', { id: serviceId })}
        <br /><br />
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>{t('dashboard.tab_more_tasks')}</Button>
      </div>
    );
  }

  if (entityNames.length === 0) {
    return (
      <div className="service-mgr-container">
        <div className="panel">
          <div className="panel-title">{serviceId?.toUpperCase()} MANAGEMENT</div>
          <div className="panel-content" style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>
            {t('default.no_entity_defs')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="service-mgr-container">
      <EntityTabs
        entityNames={entityNames}
        activeEntity={activeEntity}
        setActiveEntity={setActiveEntity}
        serviceId={serviceId}
      />

      <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <EntityHeader
          serviceId={serviceId}
          activeEntity={activeEntity}
          entityDef={currentEntityDef}
          currentKeyword={currentKeyword}
          onSearch={(val) => {
            setKeywords(prev => ({ ...prev, [activeEntity]: val }));
            setPage(1);
          }}
          onAdd={startCreating}
          dataLoading={dataLoading}
          onOpenRecycleBin={() => setIsRecycleBinOpen(true)}
          softDelete={currentEntityDef?.softDelete}
        />

        <div className="panel-content" style={{ padding: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
            <GenericList
              items={data}
              entityDef={currentEntityDef}
              onViewRaw={startEditing}
              onDelete={handleRemove}
              serviceId={serviceId}
              activeEntity={activeEntity}
              isLoading={dataLoading}
              error={dataError}
            />
          </div>

          <EntityPagination
            page={page}
            pageSize={pageSize}
            total={total}
            dataLoading={dataLoading}
            onPageChange={setPage}
            description={currentEntityDef?.description}
          />
        </div>
      </div>

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
        mode={isCreateMode ? 'create' : 'edit'}
      />

      <RecycleBinModal
        isOpen={isRecycleBinOpen}
        onClose={() => setIsRecycleBinOpen(false)}
        serviceId={serviceId || ''}
        activeEntity={activeEntity}
        onRestoreSuccess={() => queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] })}
      />
    </div>
  );
}
