import { useState, useRef, useEffect } from 'react';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { useDisplayConfig } from '../../providers/DisplayConfigProvider';
import { resolveBaseKeys } from '../../displayConfig/resolve';
import { orderedAllKeys } from './fieldConfig';
import { Button } from '../../components/ui';

interface ColumnConfigProps {
  scope: string;       // `${serviceId}_${activeEntity}` — same key as the view-mode memory
  entityDef: any;
}

/**
 * Gear popover that configures which fields a list shows and in what order.
 * The config is shared by all three view modes (table columns / card+gallery content rows)
 * and persisted per `{service}_{entity}` scope via the UI provider. `id`, the title, the
 * status badge and the image are structural and not listed here — this controls data fields.
 */
export function ColumnConfig({ scope, entityDef }: ColumnConfigProps) {
  const { getFieldConfig, setFieldConfig } = useUI();
  const { getManifest } = useDisplayConfig();
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const tx = (zh: string, en: string) => (lang === 'zh' ? zh : en);

  // Candidate fields = the resolved manifest base (manifest order/curation), so the personal
  // gear edits the same field set the list renders.
  const allKeys = resolveBaseKeys(entityDef, getManifest(scope));
  const config = getFieldConfig(scope);
  const ordered = orderedAllKeys(allKeys, config);   // full editor list (excludes id)
  const hidden = new Set(config?.hidden || []);
  const isCustom = !!config;
  const visibleCount = ordered.filter((k) => !hidden.has(k)).length;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commit = (nextOrder: string[], nextHidden: Set<string>) =>
    setFieldConfig(scope, { order: nextOrder, hidden: Array.from(nextHidden) });

  const toggle = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    commit(ordered, next);
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from == null || to == null) return;
    const next = ordered.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next, hidden);
  };

  const reset = () => { setFieldConfig(scope, null); setOpen(false); };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className={`view-toggle-btn header-config-btn${isCustom ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={tx('字段配置', 'Configure fields')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200, width: 260,
            background: '#fff', border: '1px solid var(--border-color)', borderRadius: 10,
            boxShadow: '0 12px 28px -8px rgba(0,0,0,0.18)', paddingTop: 12, paddingBottom: 12,
          }}
        >
          <div style={{ padding: '0 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              {tx('显示字段', 'Fields')}
            </span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{visibleCount}/{ordered.length}</span>
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto', padding: '6px 0' }}>
            {ordered.map((key, i) => {
              const on = !hidden.has(key);
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={() => { dragFrom.current = i; }}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(i); }}
                  onDragEnd={() => { setDragOver(null); dragFrom.current = null; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current != null) reorder(dragFrom.current, i);
                    setDragOver(null); dragFrom.current = null;
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'grab',
                    background: dragOver === i ? '#eff6ff' : 'transparent',
                    borderTop: dragOver === i ? '2px solid #93c5fd' : '2px solid transparent',
                  }}
                >
                  <span style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 1, userSelect: 'none' }}>⠿</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(key)} style={{ cursor: 'pointer', flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: on ? '#1e293b' : '#94a3b8', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {key}
                    </span>
                  </label>
                </div>
              );
            })}
            {ordered.length === 0 && (
              <div style={{ padding: '12px 14px', fontSize: 12, color: '#94a3b8' }}>{tx('无可配置字段', 'No configurable fields')}</div>
            )}
          </div>

          <div style={{ padding: '10px 14px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1f5f9' }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={!isCustom}
            >
              {tx('重置', 'Reset')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setOpen(false)}
            >
              {tx('完成', 'Done')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
