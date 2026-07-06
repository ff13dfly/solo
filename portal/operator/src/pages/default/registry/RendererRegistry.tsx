import type { ReactNode } from 'react';
import { CategoryDisplay } from '../CategoryDisplay';
import { renderValue } from '../utils';

export type RendererProps = {
  value: any;
  type?: string;
  field: string;
  item: any;
  serviceId: string;
  format?: string;                       // explicit Display-Protocol format directive (wins over type)
  formatOptions?: Record<string, any>;
};

export type Renderer = (props: RendererProps) => ReactNode;

class RendererRegistry {
  private renderers: Record<string, Renderer> = {};

  register(fieldType: string, renderer: Renderer) {
    this.renderers[fieldType.toLowerCase()] = renderer;
  }

  get(fieldType: string): Renderer | null {
    return this.renderers[fieldType.toLowerCase()] || null;
  }

  render(props: RendererProps): ReactNode {
    const { type, field, format } = props;

    // 0. Explicit format directive (Display Protocol) takes precedence.
    if (format) {
      const fmtRenderer = this.get(format);
      if (fmtRenderer) return fmtRenderer(props);
      // unknown format → fall through to the legacy resolution (degrades to text)
    }

    // 1. Try specific field name first (e.g. 'categories')
    const fieldRenderer = this.get(field);
    if (fieldRenderer) return fieldRenderer(props);

    // 2. Try type match (e.g. 'datetime')
    if (type) {
      const typeRenderer = this.get(type);
      if (typeRenderer) return typeRenderer(props);
    }

    // 3. Fallback to default util
    return renderValue(props.value, type || '');
  }
}

export const rendererRegistry = new RendererRegistry();

// --- numeric helpers ---
const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dash = '-';

// --- Field-name / type renderers (pre-existing) ---
rendererRegistry.register('categories', (props) => (
  <CategoryDisplay categories={props.value} />
));

rendererRegistry.register('datetime', (props) => (
  <span style={{ color: '#64748b' }}>{renderValue(props.value, 'datetime')}</span>
));

rendererRegistry.register('id', (props) => (
  <code style={{ fontSize: '11px', color: '#94a3b8' }}>{props.value}</code>
));

// --- Display-Protocol format renderers ---
rendererRegistry.register('text', (p) => <>{p.value === null || p.value === undefined || p.value === '' ? dash : String(p.value)}</>);

rendererRegistry.register('number', (p) => {
  const n = num(p.value);
  if (n === null) return <>{dash}</>;
  const d = p.formatOptions?.decimals;
  return <>{typeof d === 'number' ? n.toFixed(d) : n.toLocaleString()}</>;
});

rendererRegistry.register('percent', (p) => {
  const n = num(p.value);
  if (n === null) return <>{dash}</>;
  const d = p.formatOptions?.decimals ?? 0;
  // value is a ratio (0..1) unless formatOptions.scale === 'absolute' (already a percent number)
  const pct = p.formatOptions?.scale === 'absolute' ? n : n * 100;
  return <>{pct.toFixed(d)}%</>;
});

rendererRegistry.register('currency', (p) => {
  const n = num(p.value);
  if (n === null) return <>{dash}</>;
  const currency = p.formatOptions?.currency || 'CNY';
  const d = p.formatOptions?.decimals ?? 2;
  try {
    return <>{new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: d, minimumFractionDigits: d }).format(n)}</>;
  } catch {
    return <>{n.toFixed(d)}</>;
  }
});

rendererRegistry.register('bytes', (p) => {
  let n = num(p.value);
  if (n === null) return <>{dash}</>;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return <>{`${i === 0 ? n : n.toFixed(1)} ${units[i]}`}</>;
});

rendererRegistry.register('bool', (p) => {
  const v = p.value;
  const on = v === true || v === 'true' || v === 1 || v === '1';
  const off = v === false || v === 'false' || v === 0 || v === '0';
  if (!on && !off) return <>{dash}</>;
  return (
    <span style={{ color: on ? '#16a34a' : '#94a3b8', fontWeight: 700 }}>{on ? '✓' : '✗'}</span>
  );
});

rendererRegistry.register('relative-time', (p) => {
  const v = p.value;
  if (!v) return <>{dash}</>;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) return <>{renderValue(v, 'datetime')}</>;
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60000, 'minute'], [3600000, 'hour'], [86400000, 'day'], [604800000, 'week'], [2592000000, 'month'], [31536000000, 'year'],
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let div = 1000;
  for (const [ms, u] of steps) { if (abs >= ms) { unit = u; div = ms; } }
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    return <span style={{ color: '#64748b' }}>{rtf.format(Math.round(diff / div), unit)}</span>;
  } catch {
    return <>{renderValue(v, 'datetime')}</>;
  }
});

rendererRegistry.register('enum-badge', (p) => {
  if (p.value === null || p.value === undefined || p.value === '') return <>{dash}</>;
  return (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#f1f5f9', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
      {String(typeof p.value === 'object' ? (p.value.zh || p.value.en || JSON.stringify(p.value)) : p.value)}
    </span>
  );
});

rendererRegistry.register('link', (p) => {
  const v = p.value;
  if (!v) return <>{dash}</>;
  const href = String(v);
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-color)', textDecoration: 'underline' }}>
      {p.formatOptions?.label ? String(p.formatOptions.label) : href}
    </a>
  );
});

rendererRegistry.register('json', (p) => (
  <code style={{ fontSize: 11, color: '#64748b' }}>
    {(() => { try { return JSON.stringify(p.value); } catch { return String(p.value); } })()}
  </code>
));

rendererRegistry.register('bar', (p) => {
  const n = num(p.value);
  if (n === null) return <>{dash}</>;
  const max = num(p.formatOptions?.max) ?? 1;
  const ratio = Math.max(0, Math.min(1, max ? n / max : 0));
  const pct = Math.round(ratio * 100);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 80 }}>
      <span style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden', minWidth: 48 }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct >= 80 ? '#16a34a' : pct >= 40 ? '#2563eb' : '#f59e0b' }} />
      </span>
      <span style={{ fontSize: 11, color: '#64748b' }}>{pct}%</span>
    </span>
  );
});
