// Display Protocol (docs/protocol/zh/display.md) — system-console editor types.
// An EntityDisplay manifest declares how an entity renders. It is resolved (in the operator) from:
//   ① schema (introspection, read-only)  ← ② operator config (static base ← administrator override)  ← ③ personal prefs
// This portal (system console) authors layer ②-B: the deployment-level override, stored in
// administrator via `setting.display.*`. The operator boot-fetches and renders by it.

export type ViewMode = 'table' | 'card' | 'gallery';

export type I18n = string | { zh?: string; en?: string; [lang: string]: string | undefined };

export type FormatKind =
  | 'text' | 'number' | 'percent' | 'currency' | 'bytes' | 'bool'
  | 'datetime' | 'relative-time' | 'enum-badge' | 'link' | 'json' | 'bar';

export interface FieldDisplay {
  key: string;
  label?: I18n;
  show?: boolean;                 // default true; omission ≠ hide (explicit show:false hides)
  order?: number;                 // advisory; resolution mainly uses array position
  format?: FormatKind;
  formatOptions?: Record<string, any>;
  width?: string;                 // table column grid hint (e.g. "2fr")
  locked?: boolean;               // personal layer cannot hide/relabel
}

export interface ComputedField {
  key: string;
  label?: I18n;
  compute: any;                   // JsonLogic over a single row (json-logic-js dialect)
  format?: FormatKind;
  formatOptions?: Record<string, any>;
  render?: 'text' | 'bar' | 'badge';
}

export interface EntityDisplay {
  service?: string;
  entity?: string;
  label?: I18n;
  icon?: string;
  views?: ViewMode[];
  defaultView?: ViewMode;
  primaryField?: string;
  imageField?: string;
  fields?: FieldDisplay[];
  computed?: ComputedField[];
}

/** Scope key shared with the operator's view-mode + personal-field memory. */
export const displayScope = (serviceId: string, entity?: string): string =>
  entity ? `${serviceId}_${entity}` : serviceId;
