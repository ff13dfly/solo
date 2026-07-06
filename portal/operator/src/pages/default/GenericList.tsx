import { useState, memo, type MouseEvent } from 'react';
import { List } from 'react-window';
import type { EntityDefinition } from '../../providers/ServicesProvider';
import { EntityResolver } from './EntityResolver';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Badge, CopyButton, Button } from '../../components/ui';
import { GenericCardList } from './GenericCardList';
import { GenericImageCardList } from './GenericImageCardList';
import { useDisplayConfig } from '../../providers/DisplayConfigProvider';
import { resolveEffectiveFields, resolveLabel, evalComputed, type ResolvedField } from '../../displayConfig/resolve';
import { displayScope } from '../../displayConfig/types';
import { rendererRegistry } from './registry/RendererRegistry';
import { CommonErrorBoundary } from '../../components/CommonErrorBoundary';
import './DefaultPage.css';

const Row = memo(({ index, style, items, gridTemplate, onViewRaw, onDelete, serviceId, resolverTarget, setResolverTarget, fields, t }: any) => {
  const item = items[index];
  if (!item) return null;
  const isRowResolving = resolverTarget?.rowIdx === index;

  return (
    <div 
      className="generic-list-row"
      style={{ 
        ...style,
        gridTemplateColumns: gridTemplate,
        zIndex: isRowResolving ? 100 : 1,
        overflow: isRowResolving ? 'visible' : 'hidden'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
        <Button 
          onClick={() => onViewRaw(item)}
          size="sm"
          className="btn-action-edit"
        >
          {t('default.btn_edit_raw')}
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
          <Badge variant="neutral" size="sm" style={{ fontFamily: 'var(--font-mono)' }}>
            {item.id || '-'}
          </Badge>
          {item.id && (
            <CopyButton text={item.id} />
          )}
        </div>
      </div>

      {fields.map((f: ResolvedField) => {
        const name = f.key;
        const isComputed = !!f.computed;
        let relatedEntityName: string | null = null;
        if (!isComputed) {
          const lowerName = name.toLowerCase();
          // 1. Explicit Mappings
          if (lowerName === 'uid') {
            relatedEntityName = 'user';
          }
          // 2. Suffix Mappings
          else if (lowerName.endsWith('id') && name.length > 2) {
            const idIndex = lowerName.lastIndexOf('id');
            let base = name.slice(0, idIndex);
            if (base.endsWith('_')) base = base.slice(0, -1);
            relatedEntityName = base.toLowerCase();
          }
        }

        const isRelatedId = !!relatedEntityName && relatedEntityName.length > 1;
        const val = isComputed ? evalComputed(f.computed, item) : item[name];
        const isResolving = resolverTarget?.rowIdx === index && resolverTarget?.field === name;

        return (
          <div key={name} style={{
            whiteSpace: 'nowrap',
            overflow: isResolving ? 'visible' : 'hidden',
            textOverflow: 'ellipsis',
            position: 'relative'
          }}>
            <CommonErrorBoundary>
              {isRelatedId && val ? (
                <>
                  <button
                    onClick={() => setResolverTarget(isResolving ? null : { entity: relatedEntityName!, id: val, field: name, rowIdx: index })}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--accent-color)',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 'inherit',
                      fontFamily: 'var(--font-mono)'
                    }}
                  >
                    {val.length > 10 ? val.substring(0, 10) + '...' : val}
                  </button>
                  {isResolving && (
                    <EntityResolver
                      currentServiceId={serviceId}
                      entityName={relatedEntityName!}
                      id={val}
                      onClose={() => setResolverTarget(null)}
                    />
                  )}
                </>
              ) : (
                rendererRegistry.render({
                  value: val,
                  type: f.fieldType,
                  field: name,
                  item,
                  serviceId,
                  format: f.format,
                  formatOptions: f.formatOptions,
                })
              )}
            </CommonErrorBoundary>
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center' }}>
        {onDelete && (
          <Button 
            variant="danger"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item);
            }}
          >
            {t('default.btn_delete')}
          </Button>
        )}
      </div>
    </div>
  );
});

interface GenericListProps {
  items: any[];
  entityDef: any;
  onViewRaw: (item: any) => void;
  onDelete?: (item: any) => void;
  serviceId: string;
  isLoading?: boolean;
  // Identifies the list so view mode is remembered per `{serviceId}_{activeEntity}`.
  activeEntity?: string;
}

export function GenericList({ items, entityDef, onViewRaw, onDelete, serviceId, isLoading, activeEntity }: GenericListProps) {
  const { getViewMode, getFieldConfig } = useUI();
  const { getManifest } = useDisplayConfig();
  const { t, lang } = useLang();
  const scope = displayScope(serviceId, activeEntity);
  const viewMode = getViewMode(scope);
  // Hooks must run unconditionally, BEFORE the view-mode early returns below — otherwise
  // toggling table↔card/gallery changes the rendered hook count and React crashes
  // ("Rendered fewer/more hooks than during the previous render").
  const [resolverTarget, setResolverTarget] = useState<{ entity: string, id: string, field: string, rowIdx: number } | null>(null);

  if (!entityDef) return null;

  if (viewMode === 'card') {
    return (
      <div style={{ padding: '20px', flex: 1, overflowY: 'auto' }}>
        <GenericCardList
          items={items}
          entityDef={entityDef}
          serviceId={serviceId}
          activeEntity={activeEntity}
          onEdit={onViewRaw}
          onDelete={onDelete || (() => {})}
        />
      </div>
    );
  }

  if (viewMode === 'gallery') {
    return (
      <div style={{ padding: '20px', flex: 1, overflowY: 'auto' }}>
        <GenericImageCardList
          items={items}
          entityDef={entityDef}
          serviceId={serviceId}
          activeEntity={activeEntity}
          onEdit={onViewRaw}
          onDelete={onDelete || (() => {})}
        />
      </div>
    );
  }

  // Table columns: resolved display fields (manifest label/format/computed + personal order/hide),
  // else every non-id schema field. A ResolvedField list drives both header labels and cells.
  const resolved = resolveEffectiveFields(entityDef, getManifest(scope), getFieldConfig(scope));
  const fields: ResolvedField[] = resolved
    ? resolved
    : (Object.entries(entityDef?.fields || {}) as [string, any][])
        .filter(([name]) => name.toLowerCase() !== 'id')
        .map(([name, def]) => ({ key: name, locked: false, fieldType: def?.type }));
  const gridTemplate = `2.5fr ${fields.map((f) => f.width || '2fr').join(' ')} 100px`;

  return (
    <div className="generic-list-container">
      <div 
        className="generic-list-header"
        style={{ 
          gridTemplateColumns: gridTemplate, 
          minWidth: `${(fields.length + 2) * 150}px`
        }}
      >
        <div>{t('default.list_id_label')}</div>
        {fields.map((f) => (
          <div key={f.key}>{resolveLabel(f.label, lang, f.key)}</div>
        ))}
        <div>{t('default.list_actions_label')}</div>
      </div>
      
      <div style={{ flex: 1, position: 'relative', minWidth: `${(fields.length + 2) * 150}px` }}>
        {items.length > 0 ? (
          <List
            style={{ height: '100%', width: '100%' }}
            rowCount={items.length}
            rowHeight={52}
            rowComponent={Row as any}
            rowProps={{
              items,
              gridTemplate,
              onViewRaw,
              onDelete,
              serviceId,
              resolverTarget,
              setResolverTarget,
              fields,
              t
            }}
          />
        ) : (
          <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>
            {isLoading ? t('default.loading_data') : t('default.no_data_found')}
          </div>
        )}
      </div>
    </div>
  );
}
