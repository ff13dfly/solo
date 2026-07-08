import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { useLang } from '../../providers/LanguageProvider';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../utils/format';
import type { Sentinel, DeliveryItem } from './types';

interface SentinelDeliveriesModalProps {
  sentinel: Sentinel;
  onClose: () => void;
}

export default function SentinelDeliveriesModal({ sentinel, onClose }: SentinelDeliveriesModalProps) {
  const { t } = useLang();
  const [items, setItems] = useState<DeliveryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<DeliveryItem | null>(null);

  const fetchItems = useCallback(() => {
    callRpc<{ items: DeliveryItem[] }>('notification.inbox.list', { targetId: sentinel.id, unreadOnly: false, pageSize: 50 })
      .then(r => setItems(r?.items ?? []))
      .catch(err => { setItems([]); setError(err.message || t('nexus_mgmt.failed_load_deliveries')); });
  }, [sentinel.id, t]);
  
  useEffect(() => { fetchItems(); }, [fetchItems]);

  return (
    <Modal isOpen onClose={onClose} title={`${t('nexus_mgmt.deliveries_modal_title')}: ${sentinel.name}`} size="lg"
      footer={<Button onClick={onClose}>{t('nexus_mgmt.close')}</Button>}>
      <div className="flex flex-col gap-3" data-test="sentinel-deliveries-modal">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-secondary">
            {t('nexus_mgmt.delivery_audit_caption')}
          </span>
          <button
            onClick={fetchItems}
            className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
          >
            {t('nexus_mgmt.refresh')}
          </button>
        </div>

        {error && <div className="text-error text-[12px]">{t('nexus_mgmt.error_prefix')}: {error}</div>}

        <div className="grid gap-3 px-3 py-2 border-b-2 border-border bg-bg-secondary font-bold text-[10px] text-accent uppercase tracking-wider"
          style={{ gridTemplateColumns: '1.4fr 2fr 1.4fr 2.2fr 0.7fr' }}>
          <div>{t('nexus_mgmt.col_time')}</div>
          <div>{t('nexus_mgmt.col_stream')}</div>
          <div>{t('nexus_mgmt.col_decision')}</div>
          <div>{t('nexus_mgmt.col_outcome')}</div>
          <div></div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto flex flex-col">
          {items === null && <div className="p-4 text-center opacity-50 text-sm">{t('nexus_mgmt.loading')}</div>}
          {items?.map(m => {
            const out = m.payload?.context?.output;
            const err2 = m.payload?.context?.autorun_error;
            return (
              <div key={m.id} data-test="delivery-row"
                className="grid gap-3 px-3 py-2 border-b border-border items-center text-[11px]"
                style={{ gridTemplateColumns: '1.4fr 2fr 1.4fr 2.2fr 0.7fr' }}>
                <div className="text-text-secondary">{m.createdAt ? formatDate(m.createdAt) : '—'}</div>
                <div className="font-mono text-[10px] text-text-secondary truncate" title={m.type}>{m.type || '—'}</div>
                <div className="font-mono">
                  {out?.decision
                    ? <span className="text-accent">{out.decision}{typeof out.confidence === 'number' ? ` (${out.confidence})` : ''}</span>
                    : <span className="opacity-40">—</span>}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {out?.escalate && (
                    <span className="text-[9px] px-1.5 py-0.5 border rounded border-warning/40 text-warning bg-warning/10"
                      title={t('nexus_mgmt.escalate_tooltip', { reason: out.reason || '' })}>{t('nexus_mgmt.escalate')}</span>
                  )}
                  {err2 && (
                    <span className="text-[9px] px-1.5 py-0.5 border rounded border-error/40 text-error bg-error/10 truncate max-w-[180px]"
                      title={err2}>autorun_error</span>
                  )}
                  {!out?.escalate && !err2 && <span className="text-[10px] text-success">{t('nexus_mgmt.delivered')}</span>}
                </div>
                <div>
                  <button
                    className="bg-accent-dim border border-accent/40 text-accent rounded px-2 py-1 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                    onClick={() => setRaw(m)}
                  >
                    {t('nexus_mgmt.raw')}
                  </button>
                </div>
              </div>
            );
          })}
          {items && items.length === 0 && !error && (
            <div className="p-5 text-center opacity-50 text-[12px]">
              {t('nexus_mgmt.no_deliveries')}
            </div>
          )}
        </div>

        {raw && (
          <pre className="bg-bg-primary p-3 rounded-md text-[10px] font-mono overflow-auto border border-border text-text-secondary max-h-[30vh]">
            {JSON.stringify(raw, null, 2)}
          </pre>
        )}
      </div>
    </Modal>
  );
}
