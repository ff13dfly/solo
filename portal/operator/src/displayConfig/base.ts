import type { EntityDisplay } from './types';

/**
 * Static base layer (Display Protocol §6, layer ②-A) — operator's own default presentation,
 * versioned with the operator repo. SPARSE: only list entities that need tuning; an entity
 * with no entry keeps the generic auto-render. Keyed by `${service}_${entity}` scope.
 *
 * The `administrator` override layer (fetched at boot) merges ON TOP of this; personal prefs
 * on top of that. Example shape (uncomment / adapt per project):
 *
 *   'market_commodity': {
 *     service: 'market', entity: 'commodity',
 *     views: ['table', 'gallery'], defaultView: 'gallery',
 *     primaryField: 'name', imageField: 'coverUrl',
 *     fields: [
 *       { key: 'name', label: { zh: '名称', en: 'Name' }, locked: true },
 *       { key: 'price', label: { zh: '售价' }, format: 'currency', formatOptions: { currency: 'CNY' } },
 *       { key: 'internalNote', show: false },
 *     ],
 *     computed: [
 *       { key: 'stockPct', label: { zh: '库存占比' }, compute: { '/': [{ var: 'stock' }, { var: 'stockCap' }] }, format: 'percent', render: 'bar' },
 *     ],
 *   },
 */
export const STATIC_BASE: Record<string, EntityDisplay> = {};
