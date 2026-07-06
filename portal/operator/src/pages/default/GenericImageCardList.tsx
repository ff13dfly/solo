import { useLang } from '../../providers/LanguageProvider';
import { useUI } from '../../providers/UIProvider';
import { useDisplayConfig } from '../../providers/DisplayConfigProvider';
import { resolveEffectiveFields, resolveLabel, evalComputed, type ResolvedField } from '../../displayConfig/resolve';
import { displayScope } from '../../displayConfig/types';
import { rendererRegistry } from './registry/RendererRegistry';
import { IconButton } from '../../components/ui';

interface GenericImageCardListProps {
  items: any[];
  entityDef: any;
  serviceId: string;
  activeEntity?: string;
  onEdit: (item: any) => void;
  onDelete: (item: any) => void;
  renderExtraActions?: (item: any) => React.ReactNode;
}

/**
 * Best-effort image detection for the gallery (image-card) view. The model-driven
 * UI has no declared "image" field type, so we sniff the item's own string values:
 * a value is treated as an image when it is a data:image URI, ends in an image
 * extension, or sits in a field whose name hints at an image (photo/cover/logo…).
 * Returns null when nothing matches → the card shows a placeholder.
 */
function imageUrlOf(item: any): string | null {
  if (!item || typeof item !== 'object') return null;
  for (const [k, v] of Object.entries(item)) {
    if (typeof v !== 'string' || !v) continue;
    const looksLikeUrl = /^(https?:\/\/|data:image\/|\/)/i.test(v);
    if (!looksLikeUrl) continue;
    const hasImgExt = /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(v);
    const nameHints = /(image|img|photo|thumb|avatar|cover|icon|logo|picture|banner|poster|pic)/i.test(k);
    if (v.startsWith('data:image/') || hasImgExt || nameHints) return v;
  }
  return null;
}

export const GenericImageCardList: React.FC<GenericImageCardListProps> = ({
  items,
  entityDef,
  serviceId,
  activeEntity,
  onEdit,
  onDelete,
  renderExtraActions,
}) => {
  const { lang, t } = useLang();
  const { getFieldConfig } = useUI();
  const { getManifest } = useDisplayConfig();
  if (!entityDef) return null;

  const fields = Object.entries(entityDef.fields || {}) as [string, any][];
  const scope = displayScope(serviceId, activeEntity);
  const manifest = getManifest(scope);
  // Resolved display fields (manifest + personal), or null → keep the auto-pick default.
  const resolved = resolveEffectiveFields(entityDef, manifest, getFieldConfig(scope));

  const renderValue = (val: any, type?: string, field?: string, item?: any) => {
    if (val === undefined || val === null || val === '') return '-';
    if (typeof val === 'object') return val[lang] || val['zh'] || val['en'] || JSON.stringify(val);
    return rendererRegistry.render({ value: val, type: type || 'string', field: field || '', item, serviceId });
  };
  const renderField = (cf: ResolvedField, item: any) => {
    const val = cf.computed ? evalComputed(cf.computed, item) : item[cf.key];
    if (val === undefined || val === null || val === '') return '-';
    return rendererRegistry.render({ value: val, type: cf.fieldType, field: cf.key, item, serviceId, format: cf.format, formatOptions: cf.formatOptions });
  };

  const pick = () => {
    const titleEntry =
      fields.find(([k]) => ['name', 'title', 'label'].includes(k)) ||
      fields.find(([, d]) => d.type === 'string') ||
      (['id', { type: 'string' }] as [string, any]);
    const titleKey = (manifest && manifest.primaryField) || titleEntry[0];
    const statusEntry = fields.find(([, d]) => d.type === 'enum');
    const statusKey = statusEntry ? statusEntry[0] : null;
    // Content rows: resolved fields (minus title/status, shown structurally), else first 2.
    const contentFields: ResolvedField[] = resolved
      ? resolved.filter((f) => f.key !== titleKey && f.key !== statusKey)
      : fields
          .filter(([k, d]) => k !== titleKey && k !== statusKey && k !== 'id' && d.type !== 'object' && d.type !== 'array')
          .slice(0, 2)
          .map(([k, d]) => ({ key: k, locked: false, fieldType: (d as any).type } as ResolvedField));
    return { titleKey, statusKey, contentFields };
  };

  return (
    <div
      data-testid="gallery-grid"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '20px', padding: '4px' }}
    >
      {items.map((item) => {
        const { titleKey, statusKey, contentFields } = pick();
        const img = imageUrlOf(item);

        return (
          <div key={item.id} className="panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Image (or placeholder) */}
            <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#f1f5f9', flexShrink: 0, overflow: 'hidden' }}>
              {img ? (
                <img
                  src={img}
                  alt={String(item[titleKey] || item.id)}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <div data-testid="gallery-placeholder" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#cbd5e1' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                  </svg>
                </div>
              )}
              {statusKey && item[statusKey] && (
                <span
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    padding: '3px 8px',
                    borderRadius: 10,
                    fontSize: 10,
                    fontWeight: 700,
                    background: 'rgba(255,255,255,0.92)',
                    color: '#475569',
                    textTransform: 'uppercase',
                  }}
                >
                  {renderValue(item[statusKey], 'enum', statusKey, item)}
                </span>
              )}
            </div>

            {/* Body */}
            <div style={{ padding: '12px 14px', flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {renderValue(item[titleKey] || item.id)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginBottom: contentFields.length ? 8 : 0 }}>
                {item.id}
              </div>
              {contentFields.map((cf) => (
                <div key={cf.key} style={{ fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{resolveLabel(cf.label, lang, cf.key)}: </span>
                  {renderField(cf, item)}
                </div>
              ))}
            </div>

            {/* Actions (same visible affordance as the card view) */}
            <div style={{ padding: '10px 14px', background: '#f9fafb', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
              {renderExtraActions?.(item)}
              <IconButton variant="ghost" onClick={() => onEdit(item)} label={t('common.edit')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </IconButton>
              <IconButton variant="danger" onClick={() => onDelete(item)} label={t('common.delete')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </IconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
};
