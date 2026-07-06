import { formatDateTime } from '../../utils/format';
import { useLang } from '../../providers/LanguageProvider';
import { useUI } from '../../providers/UIProvider';
import { useDisplayConfig } from '../../providers/DisplayConfigProvider';
import { resolveEffectiveFields, resolveLabel, evalComputed, type ResolvedField } from '../../displayConfig/resolve';
import { displayScope } from '../../displayConfig/types';
import { rendererRegistry } from './registry/RendererRegistry';
import { IconButton } from '../../components/ui';

interface GenericCardListProps {
  items: any[];
  entityDef: any;
  serviceId: string;
  activeEntity?: string;
  onEdit: (item: any) => void;
  onDelete: (item: any) => void;
  renderExtraActions?: (item: any) => React.ReactNode;
}

export const GenericCardList: React.FC<GenericCardListProps> = ({
  items,
  entityDef,
  serviceId,
  activeEntity,
  onEdit,
  onDelete,
  renderExtraActions
}) => {
  const { lang, t } = useLang();
  const { getFieldConfig } = useUI();
  const { getManifest } = useDisplayConfig();
  if (!entityDef) return null;

  const scope = displayScope(serviceId, activeEntity);
  const manifest = getManifest(scope);
  const renderValue = (val: any, type?: string, field?: string, item?: any) => {
    if (!val) return '-';
    if (typeof val === 'object') {
      return val[lang] || val['zh'] || val['en'] || JSON.stringify(val);
    }
    return rendererRegistry.render({ value: val, type: type || 'string', field: field || '', item, serviceId });
  };
  // Render one (possibly computed) content field via the renderer registry honoring format.
  const renderField = (cf: ResolvedField, item: any) => {
    const val = cf.computed ? evalComputed(cf.computed, item) : item[cf.key];
    if (val === undefined || val === null || val === '') return '-';
    return rendererRegistry.render({ value: val, type: cf.fieldType, field: cf.key, item, serviceId, format: cf.format, formatOptions: cf.formatOptions });
  };

  const fields = Object.entries(entityDef.fields || {});
  // Resolved display fields (manifest + personal), or null → keep the auto-pick default.
  const resolved = resolveEffectiveFields(entityDef, manifest, getFieldConfig(scope));

  // Mapping Logic
  const getFieldInfo = (item: any) => {
    const titleField = fields.find(([key]) => ['name', 'title', 'label'].includes(key)) || fields.find(([_, def]) => def.type === 'string') || ['id', { type: 'string' }];
    const titleKey = (manifest && manifest.primaryField) || titleField[0];

    const statusField = fields.find(([_, def]) => def.type === 'enum');
    const statusKey = statusField ? statusField[0] : null;

    const timeField = fields.find(([_, def]) => def.type === 'datetime');
    const timeKey = timeField ? timeField[0] : null;

    // Content rows: resolved fields (minus the ones shown structurally as title/status/time),
    // else the default auto-pick of the first 4. Title/status/time stay auto-detected.
    const contentFields: ResolvedField[] = resolved
      ? resolved.filter((f) => f.key !== titleKey && f.key !== statusKey && f.key !== timeKey)
      : fields.filter(([key, def]) =>
          key !== titleKey &&
          key !== statusKey &&
          key !== timeKey &&
          key !== 'id' &&
          def.type !== 'object' &&
          def.type !== 'array'
        ).slice(0, 4).map(([key, def]) => ({ key, locked: false, fieldType: (def as any).type } as ResolvedField));

    return { titleKey, statusKey, timeKey, contentFields };
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
      gap: '20px',
      padding: '4px'
    }}>
      {items.map((item) => {
        const { titleKey, statusKey, timeKey, contentFields } = getFieldInfo(item);
        
        return (
          <div 
            key={item.id} 
            className="panel"
            style={{ 
              display: 'flex', 
              flexDirection: 'column',
              transition: 'all 0.2s ease',
              cursor: 'default',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            {/* Card Header */}
            <div style={{ 
              padding: '16px 20px', 
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              background: 'linear-gradient(to bottom, #ffffff, #fafafa)'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ 
                  fontSize: '15px', 
                  fontWeight: 700, 
                  color: 'var(--text-primary)',
                  marginBottom: '4px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}>
                  {renderValue(item[titleKey] || item.id)}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  ID: {item.id}
                </div>
              </div>
              
              {statusKey && item[statusKey] && (
                <span style={{
                  padding: '4px 10px',
                  borderRadius: '12px',
                  fontSize: '11px',
                  fontWeight: 700,
                  background: '#f1f5f9',
                  color: '#475569',
                  textTransform: 'uppercase',
                  letterSpacing: '0.02em',
                  flexShrink: 0,
                  marginLeft: '12px'
                }}>
                  {renderValue(item[statusKey], 'enum', statusKey, item)}
                </span>
              )}
            </div>

            {/* Card Content */}
            <div style={{ padding: '16px 20px', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                {contentFields.map((cf) => (
                  <div key={cf.key}>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
                      {resolveLabel(cf.label, lang, cf.key)}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {renderField(cf, item)}
                    </div>
                  </div>
                ))}
              </div>
              
              {timeKey && item[timeKey] && (
                <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px dotted var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '11px' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {formatDateTime(item[timeKey])}
                </div>
              )}
            </div>

            {/* Card Actions */}
            <div style={{
              padding: '12px 20px',
              background: '#f9fafb',
              borderTop: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              flexShrink: 0
            }}>
              {renderExtraActions?.(item)}
              <IconButton variant="ghost" onClick={() => onEdit(item)} label={t('common.edit')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </IconButton>
              <IconButton variant="danger" onClick={() => onDelete(item)} label={t('common.delete')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              </IconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
};
