import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { callRpc } from '../../utils/rpc';
import { useEntityQuery } from '../default/hooks/useEntityQuery';
import { EntityTabs } from '../default/EntityTabs';
import { EntityHeader } from '../default/EntityHeader';
import { EntityPagination } from '../default/EntityPagination';
import { EntityEditModal } from '../default/EntityEditModal';
import { prepareEntityForEditing, prepareEntityForCreation } from '../default/EntityUtils';
import { useServices } from '../../providers/ServicesProvider';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { AssetList } from './components/AssetList';
import { QRList } from '../../components/biz/commodity/QRList';
import { ProcessEditorModal } from './components/ProcessEditorModal';
import { RecycleBinModal } from '../default/RecycleBinModal';
import { Button } from '../../components/ui';

const PAGE_SIZE = 24;

function MintButton({ serviceId, onMinted }: { serviceId: string; onMinted: () => void }) {
    const { t } = useLang();
    const { toast } = useUI();
    const [loading, setLoading] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const handleClick = useCallback(async () => {
        if (!confirm) {
            setConfirm(true);
            timerRef.current = setTimeout(() => setConfirm(false), 3000);
            return;
        }
        if (timerRef.current) clearTimeout(timerRef.current);
        setConfirm(false);
        setLoading(true);
        try {
            const result = await callRpc<{ created: number }>(`${serviceId}.qr.mint`, { count: 64 });
            toast.success(t('storage.mint_success', { count: result.created }));
            onMinted();
        } catch (err: any) {
            toast.error(err.message || t('storage.mint_fail'));
        } finally {
            setLoading(false);
        }
    }, [confirm, onMinted, toast, serviceId, t]);

    return (
        <Button
            variant="secondary"
            size="sm"
            pill
            onClick={handleClick}
            disabled={loading}
            icon={
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
            }
            style={{
                whiteSpace: 'nowrap',
                border: `1px solid ${confirm ? '#ef4444' : '#e2e8f0'}`,
                color: confirm ? '#ef4444' : '#64748b',
            }}
        >
            {loading ? t('storage.mint_creating') : confirm ? t('storage.mint_confirm') : t('storage.mint_btn')}
        </Button>
    );
}

export default function AssetManagementPage({ serviceId = 'storage' }: { serviceId?: string }) {
    const { t } = useLang();
    const queryClient = useQueryClient();
    const { services } = useServices();
    const { toast, confirm: uiConfirm } = useUI();

    const primaryEntity = serviceId === 'asset' ? 'item' : 'asset';
    const isAssetService = serviceId === 'asset';
    const entityNames = isAssetService ? [primaryEntity, 'qr', 'template'] : [primaryEntity];

    const [activeEntity, setActiveEntity] = useState<string>(isAssetService ? 'qr' : primaryEntity);
    const [page, setPage] = useState(1);
    const [keywords, setKeywords] = useState<Record<string, string>>({});
    const [editingData, setEditingData] = useState<any | null>(null);
    const [editContent, setEditContent] = useState('');
    const [isCreateMode, setIsCreateMode] = useState(false);
    const [saveLoading, setSaveLoading] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
    const [qrBoundFilter, setQrBoundFilter] = useState('all');

    const currentKeyword = keywords[activeEntity] || '';
    const service = services.find(s => s.id === serviceId);
    const entityDef = service?.entities?.[activeEntity];

    const { data: queryData, isLoading } = useEntityQuery({
        serviceId,
        activeEntity,
        page,
        pageSize: activeEntity === 'qr' ? 64 : PAGE_SIZE,
        keyword: currentKeyword,
        boundFilter: activeEntity === 'qr' ? qrBoundFilter : undefined,
    });

    const items: any[] = queryData?.items || [];
    const total: number = queryData?.total || 0;

    useEffect(() => { setPage(1); }, [activeEntity]);

    const startEditing = useCallback((item: any) => {
        setIsCreateMode(false);
        setEditingData(item);
        const editable = entityDef ? prepareEntityForEditing(item, entityDef) : item;
        setEditContent(JSON.stringify(editable, null, 2));
        setSaveError(null);
    }, [entityDef]);

    const startCreating = useCallback(() => {
        if (!entityDef) return;
        setIsCreateMode(true);
        setEditingData({});
        setEditContent(JSON.stringify(prepareEntityForCreation(entityDef), null, 2));
        setSaveError(null);
    }, [entityDef]);

    const handleSave = async () => {
        if (!editingData) return;
        try {
            const parsed = JSON.parse(editContent);
            setSaveLoading(true);
            setSaveError(null);
            const method = isCreateMode ? 'create' : 'update';
            const payload = isCreateMode ? parsed : { id: editingData.id, ...parsed };
            await callRpc(`${serviceId}.${activeEntity}.${method}`, payload);
            setEditingData(null);
            queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });
        } catch (err: any) {
            setSaveError(err.message || t('common.error'));
        } finally {
            setSaveLoading(false);
        }
    };

    const handleDelete = async (item: any) => {
        try {
            await callRpc(`${serviceId}.${activeEntity}.delete`, { id: item.id });
            queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });
        } catch (err: any) {
            toast.error(err.message || t('common.error'));
        }
    };

    const handleRebuild = async (id: string) => {
        await callRpc('storage.thumbnail.rebuild', { id, force: true });
    };

    const [rebuildProgress, setRebuildProgress] = useState<{ done: number; total: number } | null>(null);
    const rebuildAbortRef = useRef(false);

    const handleBatchRebuild = async () => {
        if (rebuildProgress) return;
        if (!await uiConfirm({ message: t('storage.rebuild_confirm') })) return;
        rebuildAbortRef.current = false;
        const ids = items.filter(i => i.mimeType?.startsWith('image/')).map(i => i.id);
        if (!ids.length) return;
        setRebuildProgress({ done: 0, total: ids.length });
        let firstError: string | null = null;
        for (let i = 0; i < ids.length; i++) {
            if (rebuildAbortRef.current) break;
            try { await callRpc('storage.thumbnail.rebuild', { id: ids[i], force: false }); }
            catch (err: any) {
                if (!firstError) {
                    firstError = err?.message || t('storage.page.unknown_error');
                    toast.error(t('storage.rebuild_fail', { msg: String(firstError) }));
                    rebuildAbortRef.current = true;
                }
            }
            setRebuildProgress({ done: i + 1, total: ids.length });
        }
        setRebuildProgress(null);
        queryClient.invalidateQueries({ queryKey: ['entities', 'storage', 'asset'] });
    };

    return (
        <div className="service-mgr-container">
            {isAssetService && (
                <EntityTabs
                    entityNames={entityNames}
                    activeEntity={activeEntity}
                    setActiveEntity={setActiveEntity}
                    serviceId={serviceId}
                />
            )}

            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <EntityHeader
                    serviceId={serviceId}
                    activeEntity={activeEntity}
                    currentKeyword={currentKeyword}
                    onSearch={(val) => { setKeywords(prev => ({ ...prev, [activeEntity]: val })); setPage(1); }}
                    onAdd={activeEntity === 'qr' ? () => {} : startCreating}
                    hideAdd={activeEntity === 'qr'}
                    dataLoading={isLoading}
                    onOpenRecycleBin={() => setIsRecycleBinOpen(true)}
                    softDelete={entityDef?.softDelete}
                    extraHeader={
                        activeEntity === 'qr' ? (
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <MintButton
                                    serviceId={serviceId}
                                    onMinted={() => queryClient.invalidateQueries({ queryKey: ['entities', serviceId, 'qr'] })}
                                />
                            </div>
                        ) : activeEntity === primaryEntity && serviceId === 'storage' ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                pill
                                onClick={rebuildProgress ? () => { rebuildAbortRef.current = true; } : handleBatchRebuild}
                                title={rebuildProgress ? t('storage.page.click_to_cancel') : t('storage.rebuild_thumbs')}
                                icon={
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                                        style={{ animation: rebuildProgress ? 'spin 1s linear infinite' : 'none' }}>
                                        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                                    </svg>
                                }
                                style={{
                                    whiteSpace: 'nowrap',
                                    border: `1px solid ${rebuildProgress ? '#f59e0b' : '#e2e8f0'}`,
                                    color: rebuildProgress ? '#f59e0b' : '#64748b',
                                }}
                            >
                                {rebuildProgress ? `${rebuildProgress.done} / ${rebuildProgress.total}` : t('storage.rebuild_thumbs')}
                            </Button>
                        ) : null
                    }
                    extraActions={
                        activeEntity === 'qr' ? (
                            <select
                                value={qrBoundFilter}
                                onChange={(e) => { setQrBoundFilter(e.target.value); setPage(1); }}
                                style={{ padding: '5px 10px', borderRadius: '20px', border: '1px solid #e2e8f0', background: '#fff', fontSize: '12px', color: '#1e293b', outline: 'none', cursor: 'pointer' }}
                            >
                                <option value="all">{t('storage.filter_all')}</option>
                                <option value="unbound">{t('storage.filter_unbound')}</option>
                                <option value="bound">{t('storage.filter_bound')}</option>
                            </select>
                        ) : null
                    }
                />

                <div className="panel-content" style={{ padding: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                        {activeEntity === 'qr' ? (
                            <QRList
                                items={items}
                                onEdit={startEditing}
                                onDelete={handleDelete}
                                onPhotoClick={startEditing}
                                isLoading={isLoading}
                            />
                        ) : (
                            <AssetList
                                items={items}
                                isLoading={isLoading}
                                onEdit={startEditing}
                                onDelete={handleDelete}
                                onRebuild={serviceId === 'storage' ? handleRebuild : undefined}
                                isTemplate={activeEntity === 'template'}
                            />
                        )}
                    </div>

                    <EntityPagination
                        page={page}
                        pageSize={activeEntity === 'qr' ? 64 : PAGE_SIZE}
                        total={total}
                        dataLoading={isLoading}
                        onPageChange={setPage}
                    />
                </div>
            </div>

            {editingData && entityDef && (
                activeEntity === 'template' ? (
                    <ProcessEditorModal
                        data={editingData}
                        serviceId={serviceId}
                        onClose={() => setEditingData(null)}
                        onSave={async (processData) => {
                            const method = isCreateMode ? 'create' : 'update';
                            await callRpc(`${serviceId}.${activeEntity}.${method}`, processData);
                            setEditingData(null);
                            queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] });
                        }}
                    />
                ) : (
                    <EntityEditModal
                        mode={isCreateMode ? 'create' : 'edit'}
                        activeEntity={activeEntity}
                        editingData={editingData}
                        editContent={editContent}
                        setEditContent={setEditContent}
                        onClose={() => setEditingData(null)}
                        onSave={handleSave}
                        saveLoading={saveLoading}
                        saveError={saveError}
                        entityDef={entityDef}
                        qrUrl={activeEntity === 'qr' && editingData
                            ? (() => { const v = editingData.value || editingData.id; return v?.startsWith('http') ? v : v; })()
                            : undefined}
                    />
                )
            )}

            <RecycleBinModal
                isOpen={isRecycleBinOpen}
                onClose={() => setIsRecycleBinOpen(false)}
                serviceId={serviceId}
                activeEntity={activeEntity}
                onRestoreSuccess={() => queryClient.invalidateQueries({ queryKey: ['entities', serviceId, activeEntity] })}
            />
        </div>
    );
}
