import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { useLang } from '../../providers/LanguageProvider';
import { formatDate } from '../../utils/format';
import type { Delivery } from './types';
import { OUTCOMES, outcomeBadge } from './utils';

export default function DeliveriesTab({ outcome, refreshTrigger }: { outcome: string; refreshTrigger?: number }) {
  const { t } = useLang();
  const [items, setItems] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callRpc<{ items: Delivery[]; total: number }>('ingress.log.recent', {
        limit: 200, days: 7, ...(outcome ? { outcome } : {}),
      });
      setItems(result.items || []);
    } catch (err: any) {
      setError(err.message || t('ingress_mgmt.err_load_log'));
    } finally {
      setLoading(false);
    }
  }, [outcome, t]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  useEffect(() => {
    if (refreshTrigger) {
      fetchLog();
    }
  }, [refreshTrigger, fetchLog]);

  const cols = '1.8fr 1.2fr 2.4fr 1.2fr 0.8fr 0.8fr';

  return (
    <>
      {error && <div className="p-4 text-error text-[13px]">{t('ingress_mgmt.error_prefix', { msg: error })}</div>}

      <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10" style={{ gridTemplateColumns: cols }}>
        <div>{t('ingress_mgmt.col_time')}</div>
        <div>{t('ingress_mgmt.col_source')}</div>
        <div>{t('ingress_mgmt.col_request_id')}</div>
        <div>{t('ingress_mgmt.col_outcome')}</div>
        <div>{t('ingress_mgmt.col_status')}</div>
        <div>{t('ingress_mgmt.col_bytes')}</div>
      </div>

      <div className="flex-1 overflow-y-auto font-mono text-[13px]">
        {loading && <div className="p-5 text-center opacity-50 text-sm">{t('ingress_mgmt.loading')}</div>}

        {items.map((d, i) => (
          <div key={i} className="grid gap-4 px-5 border-b border-border hover:bg-white/[0.02] items-center transition-colors min-h-[44px] py-2" style={{ gridTemplateColumns: cols }}>
            <div className="text-[11px] text-text-secondary">{formatDate(d.ts)}</div>
            <div className="text-[12px] truncate font-sans" title={d.source}>{d.source}</div>
            <div className="text-[11px] text-text-secondary truncate" title={d.request_id || ''}>{d.request_id || '—'}</div>
            <div><span className={outcomeBadge(d.outcome)}>{t(`ingress_mgmt.outcome_${d.outcome}`)}</span></div>
            <div className="text-[11px]">{d.status}</div>
            <div className="text-[11px] text-text-secondary">{d.bytes}</div>
          </div>
        ))}

        {!loading && items.length === 0 && (
          <div className="p-6 text-center opacity-50 text-[13px] font-sans">
            {outcome ? t('ingress_mgmt.empty_deliveries_filtered', { outcome }) : t('ingress_mgmt.empty_deliveries')}
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex items-center shrink-0">
        <span className="text-xs text-text-secondary font-sans">
          {outcome ? t('ingress_mgmt.footer_showing_filtered', { n: items.length, outcome }) : t('ingress_mgmt.footer_showing', { n: items.length })} · logs/ingress/{'{year}'}/{'{day}'}.jsonl
        </span>
      </div>
    </>
  );
}
