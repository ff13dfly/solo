import { IconButton } from '../../../../components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskAction {
  type: 'task';
  service: string;
  method: string;
  params: Record<string, any>;
}

export interface WorkflowAction {
  type: 'workflow';
  workflowId: string;
  input: Record<string, any>;
  on_complete: {
    event: string;
    meta_patch: Record<string, any>;
  };
}

export type Action = TaskAction | WorkflowAction;

export interface Transition {
  event: string;
  from: string;
  to: string;
  condition?: any;
  actions?: Action[];
}

export interface MetaFieldSource {
  service: string;  // e.g. "sale"
  method: string;   // e.g. "order.get"
  params?: Record<string, string>; // e.g. { "id": "{instance.sourceId}" }
  pick: string;     // dot-path into response, e.g. "paid_amount"
}

export interface MetaField {
  key: string;
  label: string;
  source?: MetaFieldSource;
}

export interface StateMeta {
  label: { zh: string; en: string };
  description: { zh: string; en: string };
}

export type Lang = 'zh' | 'en';

export interface ErpView {
  label: string;
  method: string;
  params?: Record<string, any>;
}

// Single canonical Profile shape (was re-declared, divergently, in ProfileList + InstanceDetailModal).
export interface Profile {
  id: string;
  name: string;
  description?: string;
  states?: string[];
  state_meta?: Record<string, StateMeta>;
  state_config?: Record<string, { erp_views?: ErpView[] }>;
  meta_fields?: MetaField[];
  transitions?: Transition[];
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const SYSTEM_STATES = ['DRAFT', 'CANCELLED'];

// Single canonical state→color map (union of the three that had drifted across screens;
// SETTLED reconciled to the majority #10b981). Unknown states fall back to #94a3b8 at call sites.
export const STATE_COLOR: Record<string, string> = {
  DRAFT: '#94a3b8', CANCELLED: '#ef4444', ON_HOLD: '#ca8a04',
  DEPOSIT_PENDING: '#f59e0b', DEPOSIT_CONFIRMED: '#10b981',
  SOURCING: '#3b82f6', PACKING: '#8b5cf6',
  BALANCE_PENDING: '#f59e0b', READY_TO_SHIP: '#06b6d4',
  DISPATCHED: '#f97316', SHIPPED: '#f97316', DELIVERED: '#10b981',
  AFTER_SALES: '#7c3aed', DISPUTE: '#7c3aed',
  SETTLED: '#10b981', CLOSED: '#16a34a',
};

// ─── Field Catalog ────────────────────────────────────────────────────────────
// 运行时 JsonLogic 求值上下文: { instance, user, permit, constraints }

type TFn = (path: string, params?: Record<string, string | number>) => string;

export interface FieldOption { value: string; label: string; }

export interface FieldGroup {
  category: string;
  label: string;
  fields: FieldOption[];
}

/** 字段目录的 i18n key 表（label 在消费处经 t() 解析） */
const FIELD_CATALOG_KEYS: { category: string; labelKey: string; fields: { value: string; labelKey: string }[] }[] = [
  {
    category: 'instance',
    labelKey: 'fulfillment.label.groupInstance',
    fields: [
      { value: 'instance.state',          labelKey: 'fulfillment.label.fieldCurrentState' },
      { value: 'instance.prevState',      labelKey: 'fulfillment.label.fieldPrevState' },
      { value: 'instance.sourceId',       labelKey: 'fulfillment.label.fieldSourceId' },
      { value: 'instance.profileId',      labelKey: 'fulfillment.label.fieldProfileId' },
      { value: 'instance.stateChangedAt', labelKey: 'fulfillment.label.fieldStateChangedAt' },
      { value: 'instance.createdAt',      labelKey: 'fulfillment.label.fieldCreatedAt' },
    ],
  },
  {
    category: 'instance.meta',
    labelKey: 'fulfillment.label.groupInstanceMeta',
    fields: [], // 动态填充：由 profile.meta_fields 注入
  },
  {
    category: 'user',
    labelKey: 'fulfillment.label.groupUser',
    fields: [
      { value: 'user.uid',  labelKey: 'fulfillment.label.fieldUserUid' },
      { value: 'user.name', labelKey: 'fulfillment.label.fieldUserName' },
    ],
  },
  {
    category: 'permit',
    labelKey: 'fulfillment.label.groupPermit',
    fields: [
      { value: 'permit.allow_all', labelKey: 'fulfillment.label.fieldAdminPermit' },
    ],
  },
  {
    category: 'constraints',
    labelKey: 'fulfillment.label.groupConstraints',
    fields: [
      { value: 'constraints.field_mask', labelKey: 'fulfillment.label.fieldMask' },
    ],
  },
];

/** 合并静态目录 + 动态 meta_fields，经 t() 解析 label，返回带 optgroup 的完整字段列表 */
export function buildFieldGroups(metaFields: MetaField[], t: TFn): FieldGroup[] {
  return FIELD_CATALOG_KEYS.map(g => {
    if (g.category === 'instance.meta' && metaFields.length > 0) {
      return { category: g.category, label: t(g.labelKey), fields: metaFields.map(f => ({ value: `instance.meta.${f.key}`, label: f.label })) };
    }
    return { category: g.category, label: t(g.labelKey), fields: g.fields.map(f => ({ value: f.value, label: t(f.labelKey) })) };
  }).filter(g => g.fields.length > 0);
}

/** 比较运算符；符号类 label 直接展示，'!!' 的 label 经 t() 解析为"存在" */
export function buildConditionOps(t: TFn): FieldOption[] {
  return [
    { value: '>=', label: '>=' }, { value: '<=', label: '<=' },
    { value: '>', label: '>' }, { value: '<', label: '<' },
    { value: '==', label: '==' }, { value: '!=', label: '!=' },
    { value: '!!', label: t('fulfillment.label.opExists') },
  ];
}

/** 运算符 value 列表（与展示无关，供 JsonLogic 解析用） */
export const CONDITION_OP_VALUES = ['>=', '<=', '>', '<', '==', '!=', '!!'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-secondary)', width: '40px', flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

export function DelBtn({ onClick }: { onClick: () => void }) {
  return (
    <IconButton variant="danger" size="sm" onClick={onClick} style={{ flexShrink: 0 }}>✕</IconButton>
  );
}
