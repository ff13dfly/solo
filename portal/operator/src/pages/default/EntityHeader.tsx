import React from 'react';
import { stripPrefix } from './utils';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { ExtensionRegistry } from '../../ExtensionRegistry';
import { ColumnConfig } from './ColumnConfig';
import { displayScope } from '../../displayConfig/types';
import './DefaultPage.css';

interface EntityHeaderProps {
  serviceId: string;
  activeEntity: string;
  entityDef?: any;
  currentKeyword: string;
  onSearch: (val: string) => void;
  onAdd: () => void;
  hideAdd?: boolean;
  dataLoading: boolean;
  onOpenRecycleBin: () => void;
  softDelete?: boolean;
  extraHeader?: React.ReactNode;
  extraActions?: React.ReactNode;
  /** Optional filter affordance handler (the funnel icon after the search box). */
  onFilter?: () => void;
}

export function EntityHeader({
  serviceId,
  activeEntity,
  entityDef,
  currentKeyword,
  onSearch,
  onAdd,
  hideAdd,
  dataLoading,
  onOpenRecycleBin,
  softDelete,
  extraHeader,
  extraActions,
  onFilter
}: EntityHeaderProps) {
  const { getViewMode, setViewMode } = useUI();
  const { t, lang } = useLang();
  const isIndependent = serviceId ? !!ExtensionRegistry[serviceId] : false;
  const entityDisplayName = stripPrefix(activeEntity, serviceId);
  // Per-entity view-mode memory: each {service}_{entity} list keeps its own toggle.
  const viewScope = displayScope(serviceId, activeEntity);
  const viewMode = getViewMode(viewScope);

  return (
    <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {/* Deployment-level display manifests are edited in the system console (Settings → service →
            Display). The operator only consumes them; here it owns the personal layer below. */}

        {/* Field config (gear) + view-mode toggles as one segmented unit; the inner divider
            separates the field-config area from the view-mode area. */}
        {!isIndependent && (
          <div className="header-view-toggle">
            {entityDef && <ColumnConfig scope={viewScope} entityDef={entityDef} />}
            {entityDef && <span className="header-tool-divider" />}
            <button
              onClick={() => setViewMode(viewScope, 'table')}
              className={`view-toggle-btn${viewMode === 'table' ? ' active' : ''}`}
              title="Table View"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
            <button
              onClick={() => setViewMode(viewScope, 'card')}
              className={`view-toggle-btn${viewMode === 'card' ? ' active' : ''}`}
              title="Card View"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            </button>
            <button
              onClick={() => setViewMode(viewScope, 'gallery')}
              className={`view-toggle-btn${viewMode === 'gallery' ? ' active' : ''}`}
              title="Gallery View"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-4.5-4.5L3 21"/></svg>
            </button>
          </div>
        )}

        <span style={{ whiteSpace: 'nowrap', flexShrink: 0, fontWeight: 700, color: '#1e293b', textTransform: 'uppercase' }}>
            {serviceId} / {entityDisplayName}
        </span>
        {extraHeader}
      </div>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        {extraActions}
        
        {/* Search + filter as one field — the funnel is a trailing button inside the search
            pill (divider-separated) so it visibly belongs to the search/filter unit. */}
        <div className="search-box-container">
          <span className="search-box-icon">🔍</span>
          <input
            type="text"
            placeholder={t('default.search_placeholder', { entity: entityDisplayName })}
            value={currentKeyword}
            onChange={(e) => onSearch(e.target.value)}
            className="search-box-input"
          />
          {currentKeyword && (
            <button type="button" className="search-box-clear" onClick={() => onSearch('')} aria-label="clear">×</button>
          )}
          <span className="search-box-divider" />
          <button
            type="button"
            className="search-box-filter"
            onClick={onFilter}
            title={lang === 'zh' ? '筛选' : 'Filter'}
            aria-label={lang === 'zh' ? '筛选' : 'Filter'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" /></svg>
          </button>
        </div>

        {/* Divider — separates the search group from the action group */}
        {(!hideAdd || softDelete) && (
          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 2px' }} />
        )}

        {/* Add + recycle-bin collapsed into a compact icon group, styled like the left-side
            view-mode selector (.header-view-toggle) to cut the horizontal footprint. */}
        {(!hideAdd || softDelete) && (
          <div className="header-view-toggle">
            {!hideAdd && (
              <button
                onClick={onAdd}
                disabled={dataLoading}
                className="view-toggle-btn"
                title={t('default.btn_add_entity', { entity: entityDisplayName })}
                style={{ color: 'var(--accent-color)' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            )}
            {softDelete && (
              <button
                onClick={onOpenRecycleBin}
                className="view-toggle-btn"
                title={t('default.btn_recycle_bin')}
              >
                {/* Archive box — opens the soft-deleted list (NOT a delete action). */}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
