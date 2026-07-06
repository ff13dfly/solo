import type { Flow } from '../types';
import { useLang } from '../../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../../components/ui';

interface ActionItemProps {
    action: any;
    ai: number;
    allFlowKeys: string[];
    availableMethods: string[];
    onUpdate: (ai: number, fields: any) => void;
    onRemove: (ai: number) => void;
}

function ActionItem({ action, ai, allFlowKeys, availableMethods, onUpdate, onRemove }: ActionItemProps) {
    const { t } = useLang();
    return (
        <div style={{ padding: '8px', background: '#fff', border: '1px solid #f1f5f9', borderRadius: '6px', marginBottom: '8px' }}>
            <div style={{ marginBottom: '4px' }}>
                <label style={{ fontSize: '9px', color: '#94a3b8' }}>{t('storage.flowCard.buttonText')}</label>
                <input
                    placeholder={t('storage.flowCard.buttonTextPlaceholder')}
                    style={{ width: '100%', border: 'none', borderBottom: '1px solid #f1f5f9', fontSize: '11px', outline: 'none' }}
                    value={action.text}
                    onChange={e => onUpdate(ai, { text: e.target.value })}
                />
            </div>

            <div style={{ marginBottom: '4px' }}>
                <label style={{ fontSize: '9px', color: '#94a3b8' }}>{t('storage.flowCard.rpcPath')}</label>
                <input
                    list="rpc-methods"
                    placeholder={t('storage.flowCard.rpcPathPlaceholder')}
                    style={{ width: '100%', border: 'none', borderBottom: '1px solid #f1f5f9', fontSize: '11px', outline: 'none', color: '#6366f1' }}
                    value={action.rpc}
                    onChange={e => onUpdate(ai, { rpc: e.target.value })}
                />
                <datalist id="rpc-methods">
                    {availableMethods.map(m => <option key={m} value={m} />)}
                </datalist>
            </div>

            <div style={{ display: 'flex', gap: '4px' }}>
                <select
                    style={{ flex: 1, fontSize: '10px', border: 'none', color: '#6366f1', background: '#f8faff', outline: 'none' }}
                    value={action.target || ''}
                    onChange={e => onUpdate(ai, { target: e.target.value })}
                >
                    <option value="">{t('storage.flowCard.noTransition')}</option>
                    {allFlowKeys.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                <IconButton
                    variant="danger"
                    onClick={(e) => { e.stopPropagation(); onRemove(ai); }}
                    style={{ border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer', padding: '0 4px' }}
                >
                    ×
                </IconButton>
            </div>
        </div>
    );
}

interface Props {
    flowKey: string;
    flow: Flow;
    isActive: boolean;
    allFlowKeys: string[];
    availableMethods: string[];
    serviceId: string;
    onActivate: () => void;
    onUpdate: (fields: Partial<Flow>) => void;
}

export function FlowCard({ flowKey, flow, isActive, allFlowKeys, availableMethods, serviceId, onActivate, onUpdate }: Props) {
    const { t } = useLang();
    const handleAddAction = () => {
        const actions = flow.ui.actions || [];
        onUpdate({
            ui: {
                ...flow.ui,
                actions: [...actions, { id: 'act_' + Date.now().toString(36), text: t('storage.flowCard.newAction'), rpc: serviceId + '.action' }]
            }
        });
    };

    const handleUpdateAction = (ai: number, fields: any) => {
        const actions = [...(flow.ui.actions || [])];
        actions[ai] = { ...actions[ai], ...fields };
        onUpdate({ ui: { ...flow.ui, actions } });
    };

    const handleRemoveAction = (ai: number) => {
        const actions = flow.ui.actions?.filter((_, idx) => idx !== ai);
        onUpdate({ ui: { ...flow.ui, actions } });
    };

    return (
        <div
            onClick={onActivate}
            style={{
                padding: '12px', border: `1px solid ${isActive ? '#6366f1' : '#f1f5f9'}`,
                borderRadius: '10px', marginBottom: '12px', cursor: 'pointer',
                background: isActive ? '#f8faff' : '#fff', transition: 'all 0.2s'
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: flow.ui.color }} />
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b' }}>{flow.ui.title}</div>
                    <div style={{ fontSize: '10px', color: '#94a3b8' }}>{flowKey}</div>
                </div>
                <div style={{ fontSize: '11px', color: '#6366f1', background: '#eef2ff', padding: '2px 6px', borderRadius: '4px' }}>
                    {t('storage.actions_count', { n: flow.ui.actions?.length || 0 })}
                </div>
            </div>

            {isActive && (
                <div style={{ marginTop: '16px', borderTop: '1px solid #eef2ff', paddingTop: '12px' }}>
                    <div style={{ marginBottom: '12px' }}>
                        <label style={{ fontSize: '10px', color: '#94a3b8' }}>{t('storage.flowCard.stateTitle')}</label>
                        <input
                            style={{ width: '100%', padding: '6px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '12px' }}
                            value={flow.ui.title}
                            onChange={e => onUpdate({ ui: { ...flow.ui, title: e.target.value } })}
                        />
                    </div>

                    <div style={{ fontWeight: 600, fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>{t('storage.flowCard.actionsList')}</div>
                    {flow.ui.actions?.map((action, ai) => (
                        <ActionItem
                            key={action.id ?? ai} ai={ai} action={action}
                            allFlowKeys={allFlowKeys}
                            availableMethods={availableMethods}
                            onUpdate={handleUpdateAction}
                            onRemove={handleRemoveAction}
                        />
                    ))}
                    <Button
                        variant="ghost"
                        onClick={handleAddAction}
                        style={{ width: '100%', padding: '6px', border: '1px dashed #cbd5e1', background: 'none', borderRadius: '4px', fontSize: '10px', color: '#94a3b8' }}
                    >
                        {t('storage.flowCard.addTransitionAction')}
                    </Button>
                </div>
            )}
        </div>
    );
}
