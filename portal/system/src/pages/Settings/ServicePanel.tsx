import { useState, useEffect, useRef } from 'react';
import { useLang } from '../../providers/LanguageProvider';
import { callRpc } from '../../utils/rpc';
import { TabbedLayout } from '../../components/shared/TabbedLayout';
import type { TabItem } from '../../components/shared/TabbedLayout';
import type { ServiceListItem } from './types';
import { ServiceBlacklist } from './ServiceBlacklist';
import { ServiceJsonEditor } from './ServiceJsonEditor';
import { ServiceConfigEditor } from './ServiceConfigEditor';
import { DisplayConfigPanel } from './DisplayConfigPanel';

interface ServicePanelProps {
  svc: ServiceListItem;
  methods: { name: string; desc: string }[];
  blacklist: string[];
  onToggleBlacklist: (name: string) => void;
  onSaveBlacklist: () => Promise<void>;
  blLoading: boolean;
}

export const ServicePanel: React.FC<ServicePanelProps> = ({
  svc, methods, blacklist, onToggleBlacklist, onSaveBlacklist, blLoading,
}) => {
  const { t } = useLang();

  const [activeTab, setActiveTab] = useState('config');
  const [jsonContent, setJsonContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Keep full config in memory so we can merge scoped edits back
  const fullConfigRef = useRef<Record<string, any>>({});

  // Reset tab when service changes
  useEffect(() => {
    setActiveTab('config');
    setMessage(null);
  }, [svc.id]);

  // Load config scoped to this service
  useEffect(() => {
    if (activeTab !== 'tasks' && activeTab !== 'limits') return;
    setLoading(true);
    setJsonContent('');
    setMessage(null);

    const rpcMethod = activeTab === 'tasks' ? 'setting.task.get' : 'setting.limit.get';
    callRpc<any>(rpcMethod)
      .then(result => {
        const full = result || {};
        fullConfigRef.current = full;
        let scoped;
        if (activeTab === 'tasks') {
          scoped = full[svc.id] !== undefined ? full[svc.id] : { allowFrom: [], allowMethods: [] };
        } else {
          const prefixKey = `${svc.id}.`;
          scoped = full.prefixes?.[prefixKey] !== undefined
            ? full.prefixes[prefixKey]
            : { window: 60, max: 60, by: 'ip' };
        }
        setJsonContent(JSON.stringify(scoped, null, 2));
      })
      .catch((err: any) => {
        if (err.code === -32601) {
          setMessage({ type: 'error', text: t('settings.feature_not_supported') });
        } else {
          setMessage({ type: 'error', text: err.message });
        }
      })
      .finally(() => setLoading(false));
  }, [activeTab, svc.id]);

  // Save: merge scoped edit back into full config, then persist
  const handleJsonSave = async () => {
    let parsed;
    try { parsed = JSON.parse(jsonContent); }
    catch { setMessage({ type: 'error', text: t('settings.validation_error') }); return; }
    setLoading(true);
    try {
      // Merge this service's portion back into the full config
      let merged;
      if (activeTab === 'tasks') {
        merged = { ...fullConfigRef.current, [svc.id]: parsed };
        await callRpc('setting.task.update', { whitelist: merged });
      } else {
        merged = {
          ...fullConfigRef.current,
          prefixes: { ...fullConfigRef.current.prefixes, [`${svc.id}.`]: parsed },
        };
        await callRpc('setting.limit.update', { rules: merged });
      }
      fullConfigRef.current = merged;
      setMessage({ type: 'success', text: t('settings.toast_success') });
    } catch (err: any) {
      setMessage({ type: 'error', text: t('settings.toast_fail').replace('{msg}', err.message) });
    } finally {
      setLoading(false);
    }
  };

  const blockedCount = methods.filter(m => blacklist.includes(m.name)).length;

  const tabs: TabItem[] = [
    { id: 'config', label: t('settings.tab_config'), tag: 'M', tagColor: '#58a6ff' },
    { id: 'display', label: t('settings.tab_display'), tag: 'M', tagColor: '#58a6ff' },
    { id: 'blacklist', label: t('settings.tab_blacklist'), tag: 'R', tagColor: '#d29922', count: blockedCount || undefined },
    { id: 'tasks', label: t('settings.tab_tasks'), tag: 'R', tagColor: '#d29922' },
    { id: 'limits', label: t('settings.tab_limits'), tag: 'R', tagColor: '#d29922' },
  ];

  return (
    <TabbedLayout
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => { setActiveTab(id); setMessage(null); }}
      headerStyle={{ padding: '0 20px', marginTop: '0' }}
    >
      <div className="p-5 flex-1 flex flex-col overflow-y-auto">
        {activeTab === 'blacklist' && (
          <ServiceBlacklist
            methods={methods}
            blacklist={blacklist}
            onToggle={onToggleBlacklist}
            onSave={onSaveBlacklist}
            loading={blLoading}
            message={activeTab === 'blacklist' ? message : null}
          />
        )}
        {(activeTab === 'tasks' || activeTab === 'limits') && (
          <ServiceJsonEditor
            tab={activeTab}
            jsonContent={jsonContent}
            onChange={setJsonContent}
            onSave={handleJsonSave}
            loading={loading}
            message={message}
          />
        )}
        {activeTab === 'config' && <ServiceConfigEditor serviceId={svc.id} />}
        {activeTab === 'display' && <DisplayConfigPanel key={svc.id} serviceId={svc.id} entities={svc.entities || {}} />}
      </div>
    </TabbedLayout>
  );
};
