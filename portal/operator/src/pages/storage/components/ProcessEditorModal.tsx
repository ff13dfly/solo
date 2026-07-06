import { useState, useEffect } from 'react';
import { callRpc } from '../../../utils/rpc';
import { useLang } from '../../../providers/LanguageProvider';
import type { ProcessDefinition } from './process-editor/types';
import { ProcessSidebar } from './process-editor/sidebar';
import { FlowCanvas } from './process-editor/canvas';
import { Button, IconButton } from '../../../components/ui';

interface Props {
    data: any;
    onClose: () => void;
    onSave: (data: ProcessDefinition) => Promise<void>;
    serviceId: string;
}

export function ProcessEditorModal({ data, onClose, onSave, serviceId }: Props) {
    const { t } = useLang();
    const [process, setProcess] = useState<ProcessDefinition>({
        id: data?.id || '',
        name: data?.name || '',
        version: data?.version || '1.0.0',
        flows: data?.flows || {
            'START': { ui: { title: t('storage.process.initialState'), color: '#6366f1', actions: [] } }
        }
    });

    const [saveLoading, setSaveLoading] = useState(false);
    const [activeFlowKey, setActiveFlowKey] = useState<string | null>(Object.keys(process.flows)[0]);
    const [availableMethods, setAvailableMethods] = useState<string[]>([]);

    useEffect(() => {
        const fetchIntrospection = async () => {
            try {
                const res: any = await callRpc(`${serviceId}.introspection.list`, {});
                const methods: string[] = [];
                res.entities?.forEach((entity: any) => {
                    entity.methods?.forEach((method: any) => {
                        methods.push(`${serviceId}.${entity.name}.${method.name}`);
                    });
                });
                setAvailableMethods(methods.sort());
            } catch (err) {
                console.error('Introspection failed:', err);
            }
        };
        fetchIntrospection();
    }, [serviceId]);

    const handleSave = async () => {
        setSaveLoading(true);
        try {
            await onSave(process);
            onClose();
        } catch (err) {
            console.error(err);
        } finally {
            setSaveLoading(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', top: 0, bottom: 0, right: 0, left: 'var(--sidebar-width, 0px)',
            zIndex: 1000, background: '#f8fafc',
            display: 'flex', flexDirection: 'column',
            transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
        }}>
            {/* Header */}
            <div style={{
                height: '64px', borderBottom: '1px solid #e2e8f0', background: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <IconButton onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </IconButton>
                    <div>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#1e293b' }}>
                            {process.name || t('storage.process.untitled')}
                        </div>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>{t('storage.process.editorTitle')}</div>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '12px' }}>
                    <Button
                        variant="primary"
                        onClick={handleSave}
                        disabled={saveLoading}
                        style={{
                            background: '#1e293b', color: '#fff', border: 'none',
                        }}
                    >
                        {saveLoading ? t('common.saving') : t('storage.process.syncToService')}
                    </Button>
                </div>
            </div>

            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <ProcessSidebar
                    process={process}
                    activeFlowKey={activeFlowKey}
                    serviceId={serviceId}
                    setProcess={setProcess}
                    setActiveFlowKey={setActiveFlowKey}
                    availableMethods={availableMethods}
                />
                <FlowCanvas
                    flows={process.flows}
                    activeFlowKey={activeFlowKey}
                    onNodeClick={setActiveFlowKey}
                />
            </div>
        </div>
    );
}
