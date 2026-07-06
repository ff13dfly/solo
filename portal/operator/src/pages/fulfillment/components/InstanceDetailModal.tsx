import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { callRpc } from '../../../utils/rpc';
import { useUI } from '../../../providers/UIProvider';
import { useLang } from '../../../providers/LanguageProvider';
import { IconButton } from '../../../components/ui';
import { STATE_COLOR } from './transitions/types';
import type { Transition } from './transitions/types';

export function InstanceDetailModal({ instance: initialInstance, onClose, onUpdated }: {
    instance: any;
    onClose: () => void;
    onUpdated: () => void;
}) {
    const { toast } = useUI();
    const { t } = useLang();
    const [instance, setInstance] = useState(initialInstance);
    const [profile, setProfile] = useState<any>(null);
    const [triggering, setTriggering] = useState<string | null>(null);
    const [sourceFetching, setSourceFetching] = useState(false);

    // Load profile, then fetch meta_fields with source declarations
    useEffect(() => {
        if (!instance.profileId) return;
        callRpc<any>('fulfillment.profile.get', { id: instance.profileId })
            .then(async p => {
                setProfile(p);
                const fields: any[] = p?.meta_fields ?? [];
                const withSource = fields.filter((f: any) => f.source?.service && f.source?.method);
                if (withSource.length === 0) return;

                setSourceFetching(true);
                const resolved: Record<string, any> = {};

                await Promise.allSettled(withSource.map(async (f: any) => {
                    try {
                        // Resolve template params: "{instance.sourceId}" → actual value
                        const params: Record<string, any> = {};
                        for (const [k, v] of Object.entries(f.source.params ?? {})) {
                            if (typeof v === 'string') {
                                params[k] = v.replace(/\{instance\.(\w+)\}/g, (_: string, prop: string) => instance[prop] ?? v);
                            } else if (typeof v === 'object' && (v as any).var) {
                                // JsonLogic var: { var: "instance.sourceId" }
                                const path = (v as any).var.split('.');
                                params[k] = path.reduce((obj: any, key: string) => obj?.[key], { instance });
                            } else {
                                params[k] = v;
                            }
                        }
                        const result = await callRpc<any>(`${f.source.service}.${f.source.method}`, params);
                        // pick: dot-path into result, e.g. "paid_amount" or "order.total"
                        const pick = f.source.pick ?? f.source.field ?? '';
                        const value = pick
                            ? pick.split('.').reduce((obj: any, key: string) => obj?.[key], result)
                            : result;
                        resolved[f.key] = value;
                    } catch {
                        // Degraded: keep existing cached value from instance.meta, skip silently
                    }
                }));

                setSourceFetching(false);
                if (Object.keys(resolved).length > 0) {
                    setInstance((prev: any) => ({ ...prev, meta: { ...prev.meta, ...resolved } }));
                }
            })
            .catch(() => {});
    }, [instance.profileId]);

    // Available transitions from current state
    const availableTransitions: Transition[] = (profile?.transitions || [])
        .filter((t: Transition) => t.from === instance.state);

    const handleTransition = async (event: string) => {
        setTriggering(event);
        try {
            const updated = await callRpc<any>('fulfillment.instance.transition', { id: instance.id, event });
            setInstance(updated);
            onUpdated();
            toast.success(t('fulfillment.instance.event_triggered', { event }));
        } catch (e: any) {
            toast.error(e.message || t('fulfillment.instance.trigger_fail'));
        } finally {
            setTriggering(null);
        }
    };

    const stateColor = STATE_COLOR[instance.state] || '#94a3b8';
    const stateLabel = profile?.state_meta?.[instance.state]?.label?.zh || instance.state;

    return createPortal(
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }} onClick={onClose}>
            <div style={{
                background: 'white', borderRadius: '12px', width: '680px', maxHeight: '80vh',
                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                boxShadow: '0 20px 60px rgba(0,0,0,0.2)'
            }} onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 700, color: '#1e293b' }}>{instance.id}</span>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>← {instance.sourceId}</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {sourceFetching && (
                            <span style={{ fontSize: '10px', color: '#94a3b8' }}>{t('fulfillment.instance.fetching_data')}</span>
                        )}
                        <span style={{
                            padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700,
                            background: `${stateColor}18`, color: stateColor, border: `1px solid ${stateColor}40`
                        }}>{stateLabel}</span>
                        <IconButton variant="ghost" onClick={onClose} style={{ fontSize: '18px' }}>×</IconButton>
                    </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    {/* Meta fields */}
                    {Object.keys(instance.meta || {}).length > 0 && (
                        <section>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', marginBottom: '8px' }}>{t('fulfillment.meta_section')}</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                                {Object.entries(instance.meta).map(([k, v]) => (
                                    <div key={k} style={{ padding: '8px 10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                                        <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '2px', fontFamily: 'monospace' }}>{k}</div>
                                        <div style={{ fontSize: '12px', color: '#1e293b', fontWeight: 600, wordBreak: 'break-all' }}>{String(v)}</div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Available events */}
                    <section>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', marginBottom: '8px' }}>{t('fulfillment.instance.available_events')}</div>
                        {availableTransitions.length === 0 ? (
                            <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px', fontSize: '12px', color: '#94a3b8', border: '1px dashed #e2e8f0' }}>
                                {profile ? t('fulfillment.instance.no_events') : t('fulfillment.instance.loading_profile')}
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                {availableTransitions.map((t: Transition) => (
                                    <button key={t.event}
                                        onClick={() => handleTransition(t.event)}
                                        disabled={!!triggering}
                                        style={{
                                            padding: '7px 14px', borderRadius: '8px', border: '1px solid #c7d2fe',
                                            background: triggering === t.event ? '#6366f1' : '#eef2ff',
                                            color: triggering === t.event ? 'white' : '#4338ca',
                                            fontSize: '12px', fontWeight: 600, cursor: triggering ? 'not-allowed' : 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '6px', opacity: triggering && triggering !== t.event ? 0.5 : 1
                                        }}>
                                        {triggering === t.event && (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                        )}
                                        <span style={{ fontFamily: 'monospace', fontSize: '11px', opacity: 0.7 }}>{t.event}</span>
                                        <span style={{ color: '#818cf8' }}>→</span>
                                        <span>{profile?.state_meta?.[t.to]?.label?.zh || t.to}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* History */}
                    {(instance.history || []).length > 0 && (
                        <section>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', marginBottom: '8px' }}>{t('fulfillment.instance.history')}</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {[...instance.history].reverse().map((h: any, i: number) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px', background: i === 0 ? '#f0fdf4' : '#f8fafc', borderRadius: '6px', border: `1px solid ${i === 0 ? '#bbf7d0' : '#e2e8f0'}` }}>
                                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: STATE_COLOR[h.state] || '#94a3b8', flexShrink: 0 }} />
                                        <span style={{ fontSize: '11px', fontWeight: 700, color: '#1e293b', minWidth: '120px' }}>{profile?.state_meta?.[h.state]?.label?.zh || h.state}</span>
                                        {h.event && <span style={{ fontSize: '10px', color: '#6366f1', fontFamily: 'monospace', background: '#eef2ff', padding: '1px 6px', borderRadius: '4px' }}>{h.event}</span>}
                                        <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: 'auto' }}>{h.user || '—'} · {new Date(h.stamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
