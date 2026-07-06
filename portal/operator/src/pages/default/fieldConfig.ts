// Per-`{serviceId}_{entity}` list field configuration: which fields show, and in what order.
// Stored in the UI provider (persisted to localStorage) and shared by all three list view
// modes — table columns, and card / gallery content rows. `id` is structural (always shown)
// and never part of the configurable set.
//
// The scope key itself lives in displayConfig/types.ts as `displayScope()` — the single source
// shared by view-mode memory, field config, and manifest resolution.

export interface FieldConfig {
  order: string[];   // field keys in display order (may omit newly-added fields)
  hidden: string[];  // field keys explicitly turned off
}

/**
 * Full ordered key list for the config editor: saved order first (existing keys only),
 * then any keys not yet in the saved order appended — so fields added to the entity after
 * a config was saved surface at the end (visible by default) instead of vanishing.
 */
export function orderedAllKeys(allKeys: string[], config?: FieldConfig | null): string[] {
  const known = allKeys.filter((k) => k !== 'id');
  const knownSet = new Set(known);
  const ordered = (config?.order || []).filter((k) => knownSet.has(k));
  const seen = new Set(ordered);
  for (const k of known) if (!seen.has(k)) ordered.push(k);
  return ordered;
}
