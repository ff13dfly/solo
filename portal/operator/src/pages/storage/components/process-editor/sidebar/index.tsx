import type { ProcessDefinition, Flow } from '../types';
import { FlowCard } from './FlowCard';
import { useLang } from '../../../../../providers/LanguageProvider';
import { IconButton } from '../../../../../components/ui';

interface Props {
    process: ProcessDefinition;
    activeFlowKey: string | null;
    serviceId: string;
    availableMethods: string[];
    setProcess: (p: ProcessDefinition) => void;
    setActiveFlowKey: (key: string | null) => void;
}

export function ProcessSidebar({ process, activeFlowKey, serviceId, availableMethods, setProcess, setActiveFlowKey }: Props) {
    const { t } = useLang();
    const handleUpdateBasic = (fields: Partial<ProcessDefinition>) => {
        setProcess({ ...process, ...fields });
    };

    const handleUpdateFlow = (key: string, fields: Partial<Flow>) => {
        const newFlows = { ...process.flows };
        newFlows[key] = { ...newFlows[key], ...fields };
        setProcess({ ...process, flows: newFlows });
    };

    const handleAddFlow = () => {
        const key = 'STATUS_' + Date.now().toString(36).toUpperCase();
        setProcess({
            ...process,
            flows: { ...process.flows, [key]: { ui: { title: t('storage.sidebar.newFlowTitle'), color: '#cbd5e1', actions: [] } } }
        });
        setActiveFlowKey(key);
    };

    return (
        <div style={{
            width: '450px', borderRight: '1px solid #e2e8f0', background: '#fff',
            display: 'flex', flexDirection: 'column', overflow: 'hidden'
        }}>
            <div style={{ padding: '24px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                        <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>{t('storage.sidebar.protocolId')}</label>
                        <input
                            style={{ width: '100%', padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }}
                            value={process.id} onChange={e => handleUpdateBasic({ id: e.target.value })}
                        />
                    </div>
                    <div>
                        <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>{t('storage.sidebar.version')}</label>
                        <input
                            style={{ width: '100%', padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }}
                            value={process.version} onChange={e => handleUpdateBasic({ version: e.target.value })}
                        />
                    </div>
                </div>
                <div style={{ marginTop: '12px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>{t('storage.sidebar.displayName')}</label>
                    <input
                        style={{ width: '100%', padding: '8px', border: '1px solid #e2e8f0', borderRadius: '6px' }}
                        value={process.name} onChange={e => handleUpdateBasic({ name: e.target.value })}
                    />
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ fontSize: '14px', color: '#1e293b', margin: 0 }}>{t('storage.sidebar.flowNodes')}</h3>
                    <IconButton
                        variant="secondary"
                        round
                        onClick={handleAddFlow}
                        style={{ height: '24px', width: '24px', borderRadius: '50%', border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                        +
                    </IconButton>
                </div>

                {Object.entries(process.flows).map(([key, flow]) => (
                    <FlowCard
                        key={key}
                        flowKey={key}
                        flow={flow}
                        isActive={activeFlowKey === key}
                        allFlowKeys={Object.keys(process.flows)}
                        serviceId={serviceId}
                        availableMethods={availableMethods}
                        onActivate={() => setActiveFlowKey(key)}
                        onUpdate={(f) => handleUpdateFlow(key, f)}
                    />
                ))}
            </div>
        </div>
    );
}
