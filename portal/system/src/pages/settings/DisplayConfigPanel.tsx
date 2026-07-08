import { useMemo, useState, useEffect, useRef } from 'react';
import { callRpc } from '../../utils/rpc';
import { useLang } from '../../providers/LanguageProvider';
import { useToast } from '../../components/shared/useToast';
import { ToastContainer } from '../../components/shared/Toast';
import { lintManifest } from '../../displayConfig/lint';
import type { EntityDisplay, FieldDisplay, ViewMode, FormatKind } from '../../displayConfig/types';

interface DisplayConfigPanelProps {
  serviceId: string;
  entities: Record<string, { fields?: Record<string, any> }>;
}

const VIEW_MODES: ViewMode[] = ['table', 'card', 'gallery'];
const FORMATS: FormatKind[] = [
  'text', 'number', 'percent', 'currency', 'bytes', 'bool',
  'datetime', 'relative-time', 'enum-badge', 'link', 'json', 'bar',
];

const ACCENT = 'var(--accent-color)';
// Row grid: drag | check | key | label | format | primary | image
const ROW_GRID = '16px 18px minmax(72px,1fr) minmax(84px,1.1fr) 116px 32px 32px';

/**
 * Admin editor for entity display manifests (Display Protocol §6, layer ②-B).
 *
 * Lives in the system console because the manifest is deployment-level authority: it is edited
 * here and stored in administrator (`setting.display.*`). The operator portal is a pure consumer
 * that boot-fetches these manifests and renders by them — per-user field/view prefs stay in
 * operator.
 *
 * Two editing modes over the SAME manifest:
 *   • Visual (default) — checkbox/drag UI for the structured parts: enabled views, default view,
 *     and the field list (show via checkbox, order via drag, plus format / label / primary·image).
 *   • JSON — the raw lint-gated editor, kept as the escape hatch for `computed` fields,
 *     `formatOptions` and anything the visual form does not surface.
 * The visual form only mutates the parts it controls; everything else (computed, icon, entity
 * label, …) is preserved verbatim, so switching modes round-trips losslessly. Save is blocked
 * while there are parse or lint errors in either mode.
 *
 * Mount one per service (`key={svc.id}`) so the entity selection resets when the service changes.
 */
export const DisplayConfigPanel: React.FC<DisplayConfigPanelProps> = ({ serviceId, entities }) => {
  const { lang } = useLang();
  const { toasts, show } = useToast();
  const tx = (zh: string, en: string) => (lang === 'zh' ? zh : en);

  const entityNames = useMemo(() => Object.keys(entities || {}).sort(), [entities]);
  const [entity, setEntity] = useState<string>(() => entityNames[0] || '');
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [manifest, setManifest] = useState<EntityDisplay>({});
  const [jsonText, setJsonText] = useState('');
  const [hasOverride, setHasOverride] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Field-row drag state.
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const schemaKeys = useMemo(
    () => Object.keys(entities[entity]?.fields || {}).filter((k) => k !== 'id'),
    [entities, entity],
  );

  const seedManifest = (keys: string[]): EntityDisplay => ({
    service: serviceId, entity, views: ['table', 'card', 'gallery'], fields: keys.map((k) => ({ key: k })),
  });
  const toJson = (m: EntityDisplay): string => JSON.stringify(m, null, 2);

  // Load the existing override (or seed a default) whenever the target entity changes.
  useEffect(() => {
    if (!entity) { setManifest({}); setJsonText(''); setHasOverride(false); return; }
    let cancelled = false;
    const keys = Object.keys(entities[entity]?.fields || {}).filter((k) => k !== 'id');
    setLoading(true);
    callRpc<EntityDisplay | null>('setting.display.get', { service: serviceId, entity })
      .then((existing) => {
        if (cancelled) return;
        const m = existing || seedManifest(keys);
        setManifest(m); setJsonText(toJson(m)); setHasOverride(!!existing);
      })
      .catch(() => {
        if (cancelled) return;
        const m = seedManifest(keys);
        setManifest(m); setJsonText(toJson(m)); setHasOverride(false);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, entity]);

  // Live parse + lint against the entity's real field keys. The effective manifest is the visual
  // model in visual mode, or the parsed JSON text in JSON mode.
  const { parseError, effective } = useMemo(() => {
    if (mode === 'visual') return { parseError: null as string | null, effective: manifest as EntityDisplay | null };
    try { return { parseError: null as string | null, effective: JSON.parse(jsonText) as EntityDisplay }; }
    catch (e: any) { return { parseError: e.message as string, effective: null as EntityDisplay | null }; }
  }, [mode, manifest, jsonText]);

  const report = useMemo(
    () => (effective ? lintManifest(effective, schemaKeys) : null),
    [effective, schemaKeys],
  );

  const blocked = !!parseError || !!(report && report.errors.length) || !entity || loading;

  // ── Visual mutators (operate on the structured manifest) ───────────────────────────────
  const patch = (fn: (m: EntityDisplay) => EntityDisplay) => setManifest((prev) => fn(prev));

  const views = manifest.views ?? [];
  const present = manifest.fields ?? [];
  const presentKeys = present.map((f) => f.key);
  const absentKeys = schemaKeys.filter((k) => !presentKeys.includes(k));

  const toggleView = (v: ViewMode) => patch((m) => {
    const set = new Set(m.views ?? []);
    if (set.has(v)) set.delete(v); else set.add(v);
    const next = VIEW_MODES.filter((x) => set.has(x));
    const defaultView = m.defaultView && next.includes(m.defaultView) ? m.defaultView : undefined;
    return { ...m, views: next, defaultView };
  });

  const setDefaultView = (v: ViewMode) =>
    patch((m) => ({ ...m, defaultView: m.defaultView === v ? undefined : v }));

  const toggleField = (key: string) => patch((m) => {
    const fields = m.fields ?? [];
    const idx = fields.findIndex((f) => f.key === key);
    if (idx >= 0) {
      const next = fields.slice(); next.splice(idx, 1);
      return {
        ...m, fields: next,
        primaryField: m.primaryField === key ? undefined : m.primaryField,
        imageField: m.imageField === key ? undefined : m.imageField,
      };
    }
    return { ...m, fields: [...fields, { key }] };
  });

  const reorder = (from: number, to: number) => patch((m) => {
    const fields = (m.fields ?? []).slice();
    if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) return m;
    const [moved] = fields.splice(from, 1);
    fields.splice(to, 0, moved);
    return { ...m, fields };
  });

  const setFieldProp = (key: string, p: Partial<FieldDisplay>) => patch((m) => ({
    ...m,
    fields: (m.fields ?? []).map((f) => {
      if (f.key !== key) return f;
      const merged: FieldDisplay = { ...f, ...p };
      if (merged.label === '' || merged.label == null) delete merged.label;
      if (!merged.format) delete merged.format;
      return merged;
    }),
  }));

  const setPrimary = (key: string) =>
    patch((m) => ({ ...m, primaryField: m.primaryField === key ? undefined : key }));
  const setImage = (key: string) =>
    patch((m) => ({ ...m, imageField: m.imageField === key ? undefined : key }));

  const labelValue = (f: FieldDisplay): string =>
    typeof f.label === 'string' ? f.label : (f.label?.[lang] ?? f.label?.en ?? f.label?.zh ?? '');

  // ── Mode switch ────────────────────────────────────────────────────────────────────────
  const switchMode = (next: 'visual' | 'json') => {
    if (next === mode) return;
    if (next === 'json') { setJsonText(toJson(manifest)); setMode('json'); return; }
    try { setManifest(JSON.parse(jsonText)); setMode('visual'); }
    catch (e: any) { show('error', tx('JSON 有误，无法切回可视化：', 'Invalid JSON, cannot switch to visual: ') + e.message); }
  };

  // ── Persistence ────────────────────────────────────────────────────────────────────────
  const onSave = async () => {
    if (blocked) return;
    setSaving(true);
    try {
      const m = mode === 'visual' ? manifest : JSON.parse(jsonText);
      const res = await callRpc<{ ok: boolean; warnings?: string[] }>('setting.display.set', { service: serviceId, entity, manifest: m });
      setManifest(m); setJsonText(toJson(m)); setHasOverride(true);
      show('success', tx('显示配置已保存', 'Display config saved') + (res?.warnings?.length ? ` (${res.warnings.length} ${tx('警告', 'warnings')})` : ''));
    } catch (e: any) {
      show('error', e.message || tx('保存失败', 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    setSaving(true);
    try {
      await callRpc('setting.display.delete', { service: serviceId, entity });
      const m = seedManifest(schemaKeys);
      setManifest(m); setJsonText(toJson(m)); setHasOverride(false);
      show('success', tx('已重置为静态基线', 'Reset to static base'));
    } catch (e: any) {
      show('error', e.message || tx('重置失败', 'Reset failed'));
    } finally {
      setSaving(false);
    }
  };

  if (entityNames.length === 0) {
    return (
      <div className="text-xs text-text-secondary font-mono opacity-60">
        {tx('该服务未发布实体，无可配置的显示清单。', 'This service publishes no entities to configure.')}
      </div>
    );
  }

  const segBtn = (active: boolean) =>
    `text-[11px] font-mono px-3 py-1 transition-colors ${active ? 'text-bg-primary' : 'text-text-secondary hover:text-text-primary'}`;

  const renderFieldRow = (f: FieldDisplay, index: number, isPresent: boolean) => {
    const key = f.key;
    const isPrimary = manifest.primaryField === key;
    const isImage = manifest.imageField === key;
    return (
      <div
        key={key}
        draggable={isPresent}
        onDragStart={() => { if (isPresent) dragFrom.current = index; }}
        onDragOver={(e) => { if (isPresent) { e.preventDefault(); setDragOver(index); } }}
        onDragEnd={() => { setDragOver(null); dragFrom.current = null; }}
        onDrop={(e) => {
          e.preventDefault();
          if (isPresent && dragFrom.current != null) reorder(dragFrom.current, index);
          setDragOver(null); dragFrom.current = null;
        }}
        className="items-center text-xs font-mono"
        style={{
          display: 'grid', gridTemplateColumns: ROW_GRID, gap: 8, padding: '5px 8px',
          background: dragOver === index ? 'var(--color-accent-dim, rgba(56,139,253,0.1))' : 'transparent',
          borderTop: dragOver === index ? `2px solid ${ACCENT}` : '2px solid transparent',
          opacity: isPresent ? 1 : 0.5,
        }}
      >
        <span style={{ color: 'var(--text-secondary)', cursor: isPresent ? 'grab' : 'default', userSelect: 'none', textAlign: 'center' }}>
          {isPresent ? '⠿' : ''}
        </span>
        <input
          type="checkbox"
          checked={isPresent}
          onChange={() => toggleField(key)}
          title={tx('在列表中显示', 'Show in list')}
          style={{ accentColor: ACCENT, cursor: 'pointer' }}
        />
        <span className="text-text-primary truncate" title={key}>{key}</span>
        <input
          type="text"
          value={isPresent ? labelValue(f) : ''}
          disabled={!isPresent}
          placeholder={key}
          onChange={(e) => setFieldProp(key, { label: e.target.value })}
          className="bg-bg-primary border border-border text-text-primary px-2 py-0.5 outline-none focus:border-accent disabled:opacity-40 rounded-sm"
          style={{ minWidth: 0 }}
        />
        <select
          value={isPresent ? (f.format ?? '') : ''}
          disabled={!isPresent}
          onChange={(e) => setFieldProp(key, { format: (e.target.value || undefined) as FormatKind | undefined })}
          className="bg-bg-secondary border border-border text-text-primary px-1 py-0.5 outline-none focus:border-accent disabled:opacity-40 rounded-sm"
        >
          <option value="">{tx('文本(默认)', 'text (default)')}</option>
          {FORMATS.filter((x) => x !== 'text').map((fmt) => <option key={fmt} value={fmt}>{fmt}</option>)}
        </select>
        <button
          type="button"
          disabled={!isPresent}
          onClick={() => setPrimary(key)}
          title={tx('设为主字段（标题）', 'Set as primary (title) field')}
          className="disabled:opacity-30"
          style={{ color: isPrimary ? ACCENT : 'var(--text-secondary)', cursor: isPresent ? 'pointer' : 'default', fontSize: 13 }}
        >
          {isPrimary ? '★' : '☆'}
        </button>
        <button
          type="button"
          disabled={!isPresent}
          onClick={() => setImage(key)}
          title={tx('设为图片字段', 'Set as image field')}
          className="disabled:opacity-30"
          style={{ color: isImage ? ACCENT : 'var(--text-secondary)', cursor: isPresent ? 'pointer' : 'default', fontSize: 12, opacity: isImage ? 1 : 0.7 }}
        >
          {isImage ? '🖼' : '▢'}
        </button>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <ToastContainer toasts={toasts} />

      {/* Entity picker + mode toggle */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-text-secondary font-mono uppercase tracking-wide">{tx('实体', 'Entity')}</span>
        <select
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          className="bg-bg-secondary border border-border text-text-primary font-mono text-xs px-2 py-1 outline-none focus:border-accent"
        >
          {entityNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {hasOverride
          ? <span className="text-[10px] text-accent font-mono">{tx('已覆盖', 'overridden')}</span>
          : <span className="text-[10px] text-text-secondary font-mono opacity-40">{tx('基线', 'base')}</span>}

        <div className="ml-auto inline-flex border border-border rounded-md overflow-hidden">
          <button onClick={() => switchMode('visual')} className={segBtn(mode === 'visual')} style={mode === 'visual' ? { background: ACCENT } : undefined}>
            {tx('可视化', 'Visual')}
          </button>
          <button onClick={() => switchMode('json')} className={segBtn(mode === 'json')} style={mode === 'json' ? { background: ACCENT } : undefined}>
            JSON
          </button>
        </div>
      </div>

      <p className="text-xs text-text-secondary font-mono opacity-60 leading-relaxed">
        {tx('编辑该实体的显示清单（EntityDisplay）。可视化覆盖视图与字段；computed 计算字段等高级项请切到 JSON。保存前需通过 lint；operator 启动时拉取并据此渲染。',
            'Edit this entity\'s display manifest. Visual mode covers views and fields; switch to JSON for computed fields and other advanced options. Save is blocked until lint passes; the operator boot-fetches and renders by it.')}
      </p>

      {mode === 'visual' ? (
        <div className="flex flex-col gap-5">
          {/* VIEWS */}
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-[11px] text-text-secondary font-mono uppercase tracking-wide w-16">{tx('视图', 'Views')}</span>
            {VIEW_MODES.map((v) => (
              <label key={v} className="inline-flex items-center gap-1.5 text-xs font-mono text-text-primary cursor-pointer">
                <input type="checkbox" checked={views.includes(v)} onChange={() => toggleView(v)} style={{ accentColor: ACCENT, cursor: 'pointer' }} />
                {v}
              </label>
            ))}
          </div>

          {/* DEFAULT VIEW */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] text-text-secondary font-mono uppercase tracking-wide w-16">{tx('默认', 'Default')}</span>
            {views.length === 0 && <span className="text-xs font-mono text-text-secondary opacity-50">{tx('（先勾选视图）', '(enable a view first)')}</span>}
            {views.map((v) => {
              const on = manifest.defaultView === v;
              return (
                <button
                  key={v}
                  onClick={() => setDefaultView(v)}
                  className="text-xs font-mono px-2.5 py-1 rounded border transition-colors"
                  style={on
                    ? { background: ACCENT, color: 'var(--color-bg-primary)', borderColor: ACCENT }
                    : { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}
                  title={tx('点击设为默认；再次点击取消', 'Click to set default; click again to clear')}
                >
                  {v}
                </button>
              );
            })}
          </div>

          {/* FIELDS */}
          <div className="flex flex-col gap-1">
            <div
              className="text-[10px] text-text-secondary font-mono uppercase tracking-wide"
              style={{ display: 'grid', gridTemplateColumns: ROW_GRID, gap: 8, padding: '0 8px' }}
            >
              <span /><span />
              <span>{tx('字段', 'Field')}</span>
              <span>{tx('标签', 'Label')}</span>
              <span>{tx('格式', 'Format')}</span>
              <span title={tx('主字段', 'Primary')} style={{ textAlign: 'center' }}>★</span>
              <span title={tx('图片', 'Image')} style={{ textAlign: 'center' }}>🖼</span>
            </div>
            <div className="border border-border rounded-md divide-y divide-border/60 max-h-[420px] overflow-y-auto">
              {present.map((f, i) => renderFieldRow(f, i, true))}
              {absentKeys.map((k) => renderFieldRow({ key: k }, -1, false))}
              {present.length === 0 && absentKeys.length === 0 && (
                <div className="text-xs font-mono text-text-secondary opacity-50 px-3 py-3">{tx('该实体无可配置字段', 'No configurable fields')}</div>
              )}
            </div>
            <span className="text-[10px] font-mono text-text-secondary opacity-50 mt-1">
              {tx('勾选=在列表显示 · 拖拽 ⠿ 排序 · ★主字段(标题) · 🖼图片字段', 'Check = show in list · drag ⠿ to reorder · ★ primary (title) · 🖼 image field')}
            </span>
          </div>
        </div>
      ) : (
        <textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          spellCheck={false}
          disabled={loading || saving}
          className="w-full font-mono text-xs leading-relaxed p-3 border bg-bg-primary text-text-primary outline-none focus:border-accent resize-y"
          style={{ minHeight: 300, borderColor: parseError || (report && report.errors.length) ? '#f85149' : 'var(--border-color)' }}
        />
      )}

      {/* lint feedback */}
      {parseError && (
        <div className="text-xs font-mono px-3 py-2" style={{ color: '#f85149', background: 'rgba(248,81,73,0.06)', border: '1px solid rgba(248,81,73,0.4)' }}>
          {tx('JSON 解析错误', 'JSON parse error')}: {parseError}
        </div>
      )}
      {report && report.errors.length > 0 && (
        <div className="text-xs font-mono px-3 py-2 flex flex-col gap-1" style={{ color: '#f85149', background: 'rgba(248,81,73,0.06)', border: '1px solid rgba(248,81,73,0.4)' }}>
          <span className="font-bold">{report.errors.length} {tx('个错误（阻止保存）', 'error(s) — blocks save')}</span>
          {report.errors.map((e, i) => <span key={i}>• {e}</span>)}
        </div>
      )}
      {report && report.warnings.length > 0 && (
        <div className="text-xs font-mono px-3 py-2 flex flex-col gap-1" style={{ color: '#d29922', background: 'rgba(210,153,34,0.06)', border: '1px solid rgba(210,153,34,0.4)' }}>
          <span className="font-bold">{report.warnings.length} {tx('个警告', 'warning(s)')}</span>
          {report.warnings.map((w, i) => <span key={i}>• {w}</span>)}
        </div>
      )}
      {report && !report.errors.length && !report.warnings.length && !parseError && (
        <div className="text-xs font-mono" style={{ color: '#3fb950' }}>✓ {tx('lint 通过', 'lint clean')}</div>
      )}

      {/* actions */}
      <div className="flex items-center justify-between border-t border-border pt-3">
        <button className="service-btn small danger" disabled={saving || loading || !hasOverride} onClick={onReset}>
          {tx('重置为基线', 'Reset to base')}
        </button>
        <button className="service-btn small" disabled={blocked || saving} onClick={onSave}>
          {saving ? tx('保存中…', 'Saving…') : tx('保存', 'Save')}
        </button>
      </div>
    </div>
  );
};
