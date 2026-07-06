import type { EntityDisplay } from './types';

// Display-manifest lint (Display Protocol §5) — runs against the LIVE introspection field schema
// the system console already holds (from system.service.list), so manifests are checked at author
// time, before they reach the administrator store. Constraints R1/R4/R6/R7/R8.
// (R3 sensitiveFields is enforced at render-time / server-side; the field schema seen here does
//  not carry a sensitive flag, so it is not lintable here — an honest gap.)

const VIEW_MODES = ['table', 'card', 'gallery'];
const FORMATS = [
  'text', 'number', 'percent', 'currency', 'bytes', 'bool',
  'datetime', 'relative-time', 'enum-badge', 'link', 'json', 'bar',
];

export interface LintReport {
  errors: string[];
  warnings: string[];
}

/** Collect the top-level field names referenced by `var` in a JsonLogic rule. */
function collectVars(rule: any, out: Set<string>): void {
  if (!rule || typeof rule !== 'object') return;
  if (Array.isArray(rule)) { rule.forEach((r) => collectVars(r, out)); return; }
  for (const [op, val] of Object.entries(rule)) {
    if (op === 'var') {
      const name = Array.isArray(val) ? val[0] : val;
      if (typeof name === 'string' && name) out.add(name.split('.')[0]);
    } else {
      collectVars(val, out);
    }
  }
}

/**
 * Lint a manifest against the target entity's schema field keys.
 * `schemaKeys` = the entity's real field names (from introspection).
 */
export function lintManifest(manifest: EntityDisplay, schemaKeys: string[]): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const schema = new Set(schemaKeys);

  if (!manifest || typeof manifest !== 'object') {
    return { errors: ['manifest must be a JSON object'], warnings };
  }

  // R6 — view whitelist
  if (manifest.views && (!Array.isArray(manifest.views) || manifest.views.some((v) => !VIEW_MODES.includes(v)))) {
    errors.push(`views must be a subset of ${VIEW_MODES.join('/')}`);
  }
  if (manifest.defaultView) {
    if (!VIEW_MODES.includes(manifest.defaultView)) errors.push(`defaultView "${manifest.defaultView}" is not a valid view mode`);
    else if (Array.isArray(manifest.views) && !manifest.views.includes(manifest.defaultView)) errors.push('defaultView must be in views');
  }

  // primary/image fields must exist
  if (manifest.primaryField && !schema.has(manifest.primaryField)) errors.push(`primaryField "${manifest.primaryField}" is not a field of this entity`);
  if (manifest.imageField && !schema.has(manifest.imageField)) errors.push(`imageField "${manifest.imageField}" is not a field of this entity`);

  // R1 + R8 — fields
  if (manifest.fields && !Array.isArray(manifest.fields)) errors.push('fields must be an array');
  const fieldKeys = new Set<string>();
  for (const f of manifest.fields || []) {
    if (!f || !f.key) { errors.push('a field entry has no key'); continue; }
    fieldKeys.add(f.key);
    if (!schema.has(f.key)) errors.push(`field "${f.key}" is not a field of this entity`);
    if (f.format && !FORMATS.includes(f.format)) warnings.push(`field "${f.key}" format "${f.format}" unknown — will fall back to text`);
  }

  // R1 (var closure) + R4 (no cross-row/entity) + R7 (no collision) + R8 — computed
  if (manifest.computed && !Array.isArray(manifest.computed)) errors.push('computed must be an array');
  const computedKeys = new Set((manifest.computed || []).map((c) => c && c.key).filter(Boolean) as string[]);
  for (const c of manifest.computed || []) {
    if (!c || !c.key) { errors.push('a computed entry has no key'); continue; }
    if (schema.has(c.key)) errors.push(`computed "${c.key}" collides with a real field`);
    if (!c.compute || typeof c.compute !== 'object') { errors.push(`computed "${c.key}" needs a JsonLogic compute object`); continue; }
    const vars = new Set<string>();
    collectVars(c.compute, vars);
    for (const v of vars) {
      if (!schema.has(v) && !computedKeys.has(v)) {
        errors.push(`computed "${c.key}" references "${v}" — not a field of this entity (cross-row/entity aggregation is not allowed)`);
      }
    }
    if (c.format && !FORMATS.includes(c.format)) warnings.push(`computed "${c.key}" format "${c.format}" unknown — will fall back to text`);
  }

  return { errors, warnings };
}
