import jsonLogic from 'json-logic-js';
import { orderedAllKeys, type FieldConfig } from '../pages/default/fieldConfig';
import type { EntityDisplay, FieldDisplay, FormatKind, I18n } from './types';

/** A field ready to render: schema field or computed column, after all layers merged. */
export interface ResolvedField {
  key: string;
  label?: I18n;
  format?: FormatKind;
  formatOptions?: Record<string, any>;
  width?: string;
  locked: boolean;
  fieldType?: string;   // schema type, for renderer fallback when no explicit format
  computed?: any;       // JsonLogic rule — when set, value is derived per-row, not read
}

/** Deep-merge two manifests by field/computed key (override wins per key). */
export function mergeManifest(base?: EntityDisplay | null, override?: EntityDisplay | null): EntityDisplay | null {
  if (!base) return override || null;
  if (!override) return base;
  return {
    ...base,
    ...override,
    fields: mergeByKey(base.fields, override.fields),
    computed: mergeByKey(base.computed, override.computed),
  };
}

function mergeByKey<T extends { key: string }>(a?: T[], b?: T[]): T[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const map = new Map(a.map((x) => [x.key, x] as [string, T]));
  const order = a.map((x) => x.key);
  for (const x of b) {
    if (map.has(x.key)) map.set(x.key, { ...map.get(x.key)!, ...x });
    else { map.set(x.key, x); order.push(x.key); }
  }
  return order.map((k) => map.get(k)!);
}

/** Resolve a label across i18n + fallback to the raw key. */
export function resolveLabel(label: I18n | undefined, lang: string, fallback: string): string {
  if (!label) return fallback;
  if (typeof label === 'string') return label;
  return label[lang] || label.zh || label.en || fallback;
}

/**
 * Candidate visible field keys for an entity, before the personal layer:
 * manifest field order (existing in schema) + remaining schema fields, minus
 * manifest-hidden (show:false) and `id`. This is what the personal gear edits.
 */
export function resolveBaseKeys(entityDef: any, manifest?: EntityDisplay | null): string[] {
  const schema = (entityDef && entityDef.fields) || {};
  const schemaKeys = Object.keys(schema).filter((k) => k !== 'id');
  const mFields: FieldDisplay[] = (manifest && manifest.fields) || [];
  const mByKey = new Map(mFields.map((f) => [f.key, f] as [string, FieldDisplay]));
  const baseOrder = [
    ...mFields.map((f) => f.key).filter((k) => schemaKeys.includes(k)),
    ...schemaKeys.filter((k) => !mByKey.has(k)),
  ];
  return baseOrder.filter((k) => {
    const mf = mByKey.get(k);
    return !mf || mf.show !== false;   // manifest show:false removes it from the candidate set
  });
}

/**
 * The final ordered, visible field list to render — manifest meta + personal order/hide + locks,
 * with computed columns appended. `personal` is the existing per-entity {order, hidden} prefs.
 * Returns `null` when there is neither a manifest nor personal config (caller keeps its default).
 */
export function resolveEffectiveFields(
  entityDef: any,
  manifest?: EntityDisplay | null,
  personal?: FieldConfig | null,
): ResolvedField[] | null {
  const hasManifest = !!(manifest && (manifest.fields?.length || manifest.computed?.length));
  const hasPersonal = !!(personal && ((personal.order && personal.order.length) || (personal.hidden && personal.hidden.length)));
  if (!hasManifest && !hasPersonal) return null;

  const schema = (entityDef && entityDef.fields) || {};
  const mByKey = new Map(((manifest && manifest.fields) || []).map((f) => [f.key, f] as [string, FieldDisplay]));

  const candidate = resolveBaseKeys(entityDef, manifest);
  const ordered = personal ? orderedAllKeys(candidate, personal) : candidate;
  const personalHidden = new Set((personal && personal.hidden) || []);

  const out: ResolvedField[] = [];
  for (const key of ordered) {
    const mf = mByKey.get(key) || ({} as FieldDisplay);
    const locked = !!mf.locked;
    if (!locked && personalHidden.has(key)) continue;   // personal can hide only non-locked
    out.push({
      key,
      label: mf.label,
      format: mf.format,
      formatOptions: mf.formatOptions,
      width: mf.width,
      locked,
      fieldType: schema[key] && schema[key].type,
    });
  }
  // Computed columns: single-row JsonLogic, appended after the real fields.
  for (const c of (manifest && manifest.computed) || []) {
    const format = c.format || (c.render === 'bar' ? 'bar' : undefined);
    out.push({ key: c.key, label: c.label, format, formatOptions: c.formatOptions, locked: false, computed: c.compute });
  }
  return out;
}

/** Evaluate a computed field's JsonLogic against a single row. Never throws. */
export function evalComputed(compute: any, row: any): any {
  try { return jsonLogic.apply(compute, row || {}); } catch { return null; }
}
