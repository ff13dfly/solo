import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { copyToClipboard } from '../../../utils/format';
import { useLang } from '../../../providers/LanguageProvider';
import './QRList.css';

interface QRListProps {
    items: any[];
    onEdit: (item: any) => void;
    onDelete: (item: any) => void;
    onPhotoClick: (item: any) => void;
    isLoading?: boolean;
}

const buildQrUrl = (item: any) => {
    const qrData = item.value || item.id;
    return qrData;
};

export const QRList = ({ items, onEdit, onDelete, onPhotoClick, isLoading }: QRListProps) => {
    const { t } = useLang();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const handleCopy = async (item: any) => {
        const success = await copyToClipboard(item.id);
        if (success) {
            setCopiedId(item.id);
            setTimeout(() => setCopiedId(null), 2000);
        }
    };

    return (
        <div className="qr-card-grid" onClick={() => setSelectedId(null)}>
            {items.map((item: any) => {
                const isSelected = selectedId === item.id;
                const qrUrl = buildQrUrl(item);

                return (
                    <div
                        key={item.id}
                        className={`qr-card ${isSelected ? 'selected' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (item.targetId) {
                                onPhotoClick(item);
                            } else {
                                setSelectedId(isSelected ? null : item.id);
                            }
                        }}
                    >
                        <div className="qr-image-wrapper">
                            <QRCodeSVG
                                value={qrUrl}
                                size={156}
                                level="H"
                                includeMargin={false}
                            />
                            {item.targetType && item.targetId && (
                                <div className="qr-bound-badge" title={`${item.targetType}: ${item.targetId}`}>
                                    {t('commodity.bound')}
                                </div>
                            )}
                            {item.meta?.lp2At && (
                                <div className="qr-lp2-badge" title={`LP2 exported ${item.meta.lp2Count}×`}>
                                    LP2
                                </div>
                            )}
                        </div>

                        <div className="qr-card-footer" onClick={(e) => e.stopPropagation()}>
                            <div
                                className={`qr-id ${copiedId === item.id ? 'success' : ''}`}
                                onClick={() => handleCopy(item)}
                                title={t('commodity.click_to_copy')}
                            >
                                {copiedId === item.id ? t('common.copied') : `ID: ${item.id}`}
                            </div>

                            <div className="qr-mini-actions">
                                 <button
                                    onClick={() => onEdit(item)}
                                    className="mini-action-btn"
                                    title={t('common.edit')}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                <button
                                    onClick={() => onDelete(item)}
                                    className="mini-action-btn danger"
                                    title={t('common.delete')}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })}
            {items.length === 0 && (
                <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-secondary)', padding: '40px' }}>{isLoading ? t('common.fetching_data') : t('commodity.no_qr_data')}</p>
            )}
        </div>
    );
};
