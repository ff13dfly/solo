import { useState } from 'react';
import { resolveAssetUrl } from '../../../utils/asset';
import { formatBytes, isImage } from '../utils';
import { useLang } from '../../../providers/LanguageProvider';
import { IconButton } from '../../../components/ui';

const THUMB_SIZES = ['sm', 'md', 'lg'] as const;

// ── Lightbox ─────────────────────────────────────────────────────────────────

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
    return (
        <div onClick={onClose} style={{
            position: 'fixed', top: 0, bottom: 0, right: 0, left: 'var(--sidebar-width, 0px)',
            zIndex: 9999,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
        }}>
            <img src={url} alt="" onClick={e => e.stopPropagation()}
                style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '4px' }} />
            <IconButton onClick={onClose} style={{
                position: 'absolute', top: 20, right: 24,
                background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
                fontSize: '22px', cursor: 'pointer', borderRadius: '50%',
                width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</IconButton>
        </div>
    );
}

// ── Asset Card ────────────────────────────────────────────────────────────────

function AssetCard({ item, onEdit, onDelete, onRebuild }: {
    item: any;
    onEdit: (item: any) => void;
    onDelete: (item: any) => void;
    onRebuild?: (id: string) => Promise<void>;
}) {
    const { t } = useLang();
    const [imgError, setImgError] = useState(false);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [lightbox, setLightbox] = useState(false);
    const [rebuilding, setRebuilding] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [thumbHits, setThumbHits] = useState<Record<string, boolean>>({});
    const imgUrl = item.url ? resolveAssetUrl(item.url) : '';
    // Pregenerated thumbnails arrive as direct object-store URLs in item.thumbnails;
    // fall back to the original if a given size is missing.
    const thumb = (s: string): string => (item.thumbnails && item.thumbnails[s]) || imgUrl;
    const showImage = isImage(item.mimeType) && imgUrl && !imgError;

    return (
        <>
            <div
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                style={{
                    background: '#fff', border: `1px solid ${hovered ? '#cbd5e1' : '#e2e8f0'}`,
                    borderRadius: '12px', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column',
                    boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.09)' : 'none',
                    transition: 'box-shadow 0.15s, border-color 0.15s',
                    cursor: 'default',
                }}
            >
                {/* Image area */}
                <div
                    onClick={() => showImage && imgLoaded && setLightbox(true)}
                    style={{
                        width: '100%', paddingTop: '80%', position: 'relative',
                        background: '#f8fafc', flexShrink: 0,
                        cursor: showImage && imgLoaded ? 'zoom-in' : 'default',
                        borderRadius: '12px 12px 0 0', overflow: 'hidden',
                    }}
                >
                    {showImage ? (
                        <>
                            {!imgLoaded && (
                                <div style={{
                                    position: 'absolute', inset: 0,
                                    background: 'linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%)',
                                    backgroundSize: '200% 100%', animation: 'shimmer 1.4s infinite',
                                }} />
                            )}
                            <img
                                src={thumb('md')} alt=""
                                onLoad={() => setImgLoaded(true)}
                                onError={() => setImgError(true)}
                                style={{
                                    position: 'absolute', inset: 0,
                                    width: '100%', height: '100%', objectFit: 'cover',
                                    opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.2s ease',
                                }}
                            />
                        </>
                    ) : (
                        <div style={{
                            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center', gap: '6px', color: '#94a3b8',
                        }}>
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                            </svg>
                            <span style={{ fontSize: '10px' }}>{item.mimeType || 'file'}</span>
                        </div>
                    )}

                    {/* DELETED badge */}
                    {item.status === 'DELETED' && (
                        <span style={{
                            position: 'absolute', top: 6, left: 6, background: '#ef4444', color: '#fff',
                            fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                        }}>{t('storage.deleted_badge')}</span>
                    )}

                    {/* Thumbnail badges — top right */}
                    {showImage && (
                        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: '2px' }}>
                            {THUMB_SIZES.map(s => (
                                <span key={s} style={{
                                    fontSize: '8px', fontWeight: 800, lineHeight: 1,
                                    padding: '2px 4px', borderRadius: '3px',
                                    background: thumbHits[s] ? 'rgba(16,185,129,0.85)' : 'rgba(0,0,0,0.20)',
                                    color: thumbHits[s] ? '#fff' : 'rgba(255,255,255,0.4)',
                                    transition: 'background 0.2s',
                                }}>{s[0].toUpperCase()}</span>
                            ))}
                        </div>
                    )}

                    {/* Hidden probes */}
                    {showImage && THUMB_SIZES.map(s => (
                        <img key={s} src={thumb(s)} alt=""
                            style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                            onLoad={() => setThumbHits(prev => ({ ...prev, [s]: true }))}
                            onError={() => setThumbHits(prev => ({ ...prev, [s]: false }))}
                        />
                    ))}
                </div>

                {/* Footer: ID left, action icons right (hover-reveal) */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', gap: '6px',
                }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{
                            fontFamily: 'monospace', fontSize: '11px', fontWeight: 600, color: '#475569',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }} title={item.id}>
                            ID: {item.id}
                        </div>
                        <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '1px' }}>
                            {formatBytes(item.size)}
                        </div>
                    </div>

                    {/* Icon buttons — visible on hover, Time shown when not hovered */}
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
                        {/* 上传时间 */}
                        <div style={{
                            fontSize: '9px', color: '#94a3b8', whiteSpace: 'nowrap',
                            opacity: hovered ? 0 : 0.8, transition: 'opacity 0.15s',
                            position: 'absolute', right: 0, pointerEvents: 'none',
                            fontFamily: 'monospace'
                        }}>
                            {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '-') : ''}
                        </div>

                        {/* Icon buttons — visible on hover */}
                        <div style={{
                            display: 'flex', gap: '4px',
                            opacity: hovered ? 1 : 0, transition: 'opacity 0.15s',
                        }}>
                        {/* Edit */}
                        <IconButton onClick={e => { e.stopPropagation(); onEdit(item); }} label={t('common.edit')}
                            style={{
                                width: 28, height: 28, border: '1px solid #e2e8f0', borderRadius: '6px',
                                background: '#fff', color: '#64748b', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#6366f1'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#64748b'; }}
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </IconButton>
                        {/* Delete */}
                        <IconButton onClick={e => { e.stopPropagation(); onDelete(item); }} label={t('common.delete')} variant="danger"
                            style={{
                                width: 28, height: 28, border: '1px solid #e2e8f0', borderRadius: '6px',
                                background: '#fff', color: '#64748b', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#64748b'; }}
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                            </svg>
                        </IconButton>
                        {/* Rebuild thumbnails */}
                        {showImage && (
                            <IconButton onClick={async e => {
                                e.stopPropagation();
                                if (rebuilding) return;
                                setRebuilding(true);
                                try {
                                    if (onRebuild) await onRebuild(item.id);
                                    setThumbHits({});
                                    THUMB_SIZES.forEach(s => {
                                        const img = new Image();
                                        img.onload = () => setThumbHits(prev => ({ ...prev, [s]: true }));
                                        img.onerror = () => setThumbHits(prev => ({ ...prev, [s]: false }));
                                        const t = thumb(s);
                                        img.src = `${t}${t.includes('?') ? '&' : '?'}_=${Date.now()}`;
                                    });
                                } finally {
                                    setRebuilding(false);
                                }
                            }} label={t('storage.rebuild_thumbs')}
                                style={{
                                    width: 28, height: 28, border: '1px solid #e2e8f0', borderRadius: '6px',
                                    background: '#fff', color: '#64748b', cursor: rebuilding ? 'wait' : 'pointer',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                                }}
                                onMouseEnter={e => { e.currentTarget.style.borderColor = '#f59e0b'; e.currentTarget.style.color = '#f59e0b'; }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#64748b'; }}
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                                    style={{ animation: rebuilding ? 'spin 1s linear infinite' : 'none' }}>
                                    <polyline points="23 4 23 10 17 10"/>
                                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                                </svg>
                            </IconButton>
                        )}
                    </div>
                </div>
            </div>
        </div>

            {lightbox && <Lightbox url={imgUrl} onClose={() => setLightbox(false)} />}
        </>
    );
}

// ── Template Card ─────────────────────────────────────────────────────────────

function TemplateCard({ item, onEdit, onDelete }: { 
    item: any; 
    onEdit: (item: any) => void;
    onDelete: (item: any) => void;
}) {
    return (
        <div className="template-card" style={{
            background: '#fff', borderRadius: '12px', border: '1px solid #f1f5f9',
            padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px',
            transition: 'all 0.2s ease', position: 'relative'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ 
                    width: '40px', height: '40px', borderRadius: '8px', background: '#eff6ff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px',
                    color: '#3b82f6'
                }}>
                    📜
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.name}
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
                        ID: {item.id}
                    </div>
                </div>
            </div>

            <div style={{ 
                display: 'flex', justifyContent: 'flex-end', gap: '8px', 
                paddingTop: '12px', borderTop: '1px solid #f8fafc' 
            }}>
                <IconButton onClick={() => onEdit(item)} style={{ padding: '4px', color: '#6366f1' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </IconButton>
                <IconButton onClick={() => onDelete(item)} variant="danger" style={{ padding: '4px', color: '#ef4444' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                    </svg>
                </IconButton>
            </div>

            <style dangerouslySetInnerHTML={{ __html: `
                .template-card:hover { transform: translateY(-2px); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border-color: #3b82f6; }
            `}} />
        </div>
    );
}

export function AssetList({ items, isLoading, onEdit, onDelete, onRebuild, isTemplate = false }: {
    items: any[];
    isLoading: boolean;
    onEdit: (item: any) => void;
    onDelete: (item: any) => void | Promise<void>;
    onRebuild?: (id: string) => Promise<void>;
    isTemplate?: boolean;
}) {
    const { t } = useLang();
    if (isLoading) {
        return <div style={{ textAlign: 'center', color: '#94a3b8', padding: '60px' }}>{t('common.loading')}</div>;
    }
    if (items.length === 0) {
        return <div style={{ textAlign: 'center', color: '#94a3b8', padding: '60px' }}>{t('storage.no_assets_found')}</div>;
    }

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${isTemplate ? '300px' : '200px'}, 1fr))`,
            gap: '12px',
        }}>
            {items.map(item => (
                isTemplate ? (
                    <TemplateCard
                        key={item.id}
                        item={item}
                        onEdit={onEdit}
                        onDelete={onDelete}
                    />
                ) : (
                    <AssetCard
                        key={item.id}
                        item={item}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onRebuild={onRebuild}
                    />
                )
            ))}
        </div>
    );
}
