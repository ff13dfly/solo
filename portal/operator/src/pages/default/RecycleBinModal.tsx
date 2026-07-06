import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from '../../components/ui';

interface RecycleBinModalProps {
  isOpen: boolean;
  onClose: () => void;
  serviceId: string;
  activeEntity: string;
  onRestoreSuccess: () => void;
}

export function RecycleBinModal({
  isOpen,
  onClose,
  serviceId,
  activeEntity,
  onRestoreSuccess
}: RecycleBinModalProps) {
  const { toast, confirm } = useUI();
  const { t } = useLang();
  const [items, setItems] = useState<any[]>([]);
  const [isFetching, setIsFetching] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsFetching(true);
      fetchDeletedItems();
    }
  }, [isOpen, serviceId, activeEntity]);

  const fetchDeletedItems = async () => {
    try {
      const res = await callRpc<{ items: any[] }>(`${serviceId}.${activeEntity}.list`, {
        includeDeleted: true,
        limit: 100,
        offset: 0
      });
      const deleted = (res.items || []).filter((item: any) => item.status === 'DELETED');

      // Check destroyable status per item, bounded to a few concurrent .purgeable RPCs.
      // A full bin is up to 100 items (limit above); firing all at once would flood the
      // single router. Process in small sequential batches; order is preserved.
      const checkPurgeable = async (item: any) => {
        try {
          const check = await callRpc<{ canDestroy: boolean, reason?: string, count?: number }>(`${serviceId}.${activeEntity}.purgeable`, { id: item.id });
          return { ...item, canDestroy: check.canDestroy, destroyReason: check.reason, dependencyCount: check.count || 0 };
        } catch (e) {
          console.warn(`Failed to check destroyable for ${item.id}`, e);
          return { ...item, canDestroy: true, destroyReason: null, dependencyCount: 0 };
        }
      };
      const CONCURRENCY = 6;
      const enrichedItems: any[] = [];
      for (let i = 0; i < deleted.length; i += CONCURRENCY) {
        const batch = await Promise.all(deleted.slice(i, i + CONCURRENCY).map(checkPurgeable));
        enrichedItems.push(...batch);
      }

      setItems(enrichedItems);
    } catch (err) {
      console.error('Failed to fetch deleted items:', err);
      toast.error(t('recycle.err_load'));
    } finally {
      setIsFetching(false);
    }
  };

  const handleRestore = async (id: string) => {
    setIsProcessing(true);
    try {
      await callRpc(`${serviceId}.${activeEntity}.restore`, { id });
      toast.success(t('recycle.restored'));
      await fetchDeletedItems();
      onRestoreSuccess();
    } catch (err: any) {
      console.error('Failed to restore item:', err);
      toast.error(err.message || 'Restoration failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDestroy = async (id: string) => {
    const isConfirmed = await confirm({
      title: t('recycle.confirm_title'),
      message: t('recycle.confirm_msg'),
      confirmLabel: t('recycle.btn_confirm_delete'),
      isDangerous: true
    });

    if (!isConfirmed) return;

    setIsProcessing(true);
    try {
      await callRpc(`${serviceId}.${activeEntity}.destroy`, { id });
      toast.success(t('recycle.deleted'));
      await fetchDeletedItems();
    } catch (err: any) {
      console.error('Failed to destroy item:', err);
      toast.error(err.message || 'Hard delete failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const getLocalizedName = (item: any) => {
    const name = item.name || item.title || item.username;
    if (typeof name === 'string') return name;
    if (typeof name === 'object' && name) {
      if (name.zh) return name.zh;
      if (name.en) return name.en;
      const keys = Object.keys(name);
      if (keys.length > 0) return name[keys[0]];
    }
    return item.id || 'Unnamed';
  };

  const handleClose = () => {
    setItems([]);
    setIsFetching(true);
    onClose();
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal"
        style={{
          width: '1100px',
          height: '85vh',
          minHeight: '600px',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
          borderRadius: '16px',
          overflow: 'hidden'
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header" style={{ padding: '20px 24px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '20px' }}>🗑️</span>
            <h3 style={{ margin: 0, fontSize: '18px', color: '#1e293b', fontWeight: 700 }}>
              {t('recycle.title', { ENTITY: activeEntity.toUpperCase() })}
            </h3>
          </div>
          <IconButton variant="ghost" onClick={handleClose} style={{ fontSize: '24px', color: '#94a3b8' }}>
            ×
          </IconButton>
        </div>

        <div className="modal-content" style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {!isFetching && items.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>{t('recycle.empty')}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '20px' }}>
            {items.map(item => (
              <div
                key={item.id}
                className="panel"
                style={{
                  margin: 0,
                  padding: '16px',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px', marginBottom: '4px' }}>
                    {getLocalizedName(item)}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>ID: {item.id}</div>
                </div>

                {item.deletedAt && (
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    {t('recycle.label_deleted_at')}{new Date(item.deletedAt).toLocaleString()}
                  </div>
                )}

                {(item.dependencyCount > 0 || (!item.canDestroy && item.destroyReason)) && (
                  <div style={{
                    fontSize: '11px',
                    color: '#b91c1c',
                    background: '#fef2f2',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid #fee2e2',
                    marginTop: '4px',
                    fontWeight: 500
                  }}>
                    ⚠️ {item.dependencyCount > 0 ? t('default.dep_count', { count: item.dependencyCount }) : (item.destroyReason || t('default.in_use'))}
                  </div>
                )}

                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '12px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => item.canDestroy && handleDestroy(item.id)}
                    disabled={!item.canDestroy || isProcessing}
                    title={item.canDestroy ? t('recycle.btn_permanent_title') : item.destroyReason || t('recycle.cannot_delete')}
                  >
                    {t('recycle.btn_delete')}
                  </Button>
                  <button
                    className="service-btn"
                    onClick={() => handleRestore(item.id)}
                    disabled={isProcessing}
                    style={{ fontSize: '12px', borderColor: '#10b981', color: '#059669', background: '#ecfdf5' }}
                  >
                    {t('common.restore')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-footer" style={{ borderTop: '1px solid #e2e8f0', background: '#f8fafc', padding: '12px 24px', fontSize: '12px', color: '#64748b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '44px' }}>
          {(isFetching || isProcessing) ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#3b82f6', fontWeight: 500 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                <style>{`.spinner_S1_S{animation:spinner_S1 1.2s linear infinite;animation-delay:.1s}.spinner_S1_S2{animation-delay:.3s}.spinner_S1_S3{animation-delay:.5s}@keyframes spinner_S1{0%{opacity:1}100%{opacity:0}}`}</style>
                <circle className="spinner_S1_S" cx="12" cy="12" r="3" />
                <circle className="spinner_S1_S spinner_S1_S2" cx="12" cy="12" r="3" transform="rotate(45 12 12)" />
                <circle className="spinner_S1_S spinner_S1_S3" cx="12" cy="12" r="3" transform="rotate(90 12 12)" />
              </svg>
              <span>{isFetching ? t('recycle.loading_items') : t('common.processing')}</span>
            </div>
          ) : (
            <div>{t('recycle.restore_hint')}</div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
