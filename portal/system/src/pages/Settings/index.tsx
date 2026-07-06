import { useState, useEffect, useMemo } from 'react';
import { useLang } from '../../providers/LanguageProvider';
import { callRpc } from '../../utils/rpc';
import type { ServiceListItem, ServiceInfo } from './types';
import { BasicPanel } from './BasicPanel';
import { ServicePanel } from './ServicePanel';
import { ModelPanel } from './ModelPanel';

const BASIC_ID = '__basic__';
const MODELS_ID = '__models__';

const ROUTER_METHODS = [
  'ping', 'methods', 'entities',
  'system.service.add', 'system.service.remove', 'system.service.status', 'system.service.list',
  'system.capability.list', 'system.category.reserve', 'system.category.delete',
  'system.category.locate', 'system.category.list', 'system.workflow.list',
  'admin.log.debug', 'admin.log.clear', 'admin.log.interaction',
  'setting.task.get', 'setting.task.update', 'setting.limit.get', 'setting.limit.update',
  'setting.blacklist.get', 'setting.blacklist.update',
];

export default function Settings() {
  const { t } = useLang();
  const [selected, setSelected] = useState<string>(BASIC_ID);

  // Data
  const [services, setServices] = useState<ServiceListItem[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [allServices, setAllServices] = useState<ServiceInfo[]>([]);
  const [blSaving, setBlSaving] = useState(false);

  // Load services + blacklist on mount
  useEffect(() => {
    setServicesLoading(true);
    Promise.all([
      callRpc<ServiceListItem[]>('system.service.list').catch(() => []),
      callRpc<string[]>('setting.blacklist.get').catch(() => []),
      callRpc<ServiceInfo[]>('system.service.list').catch(() => []),
    ]).then(([svcs, bl, svcInfos]) => {
      setServices(svcs || []);
      setBlacklist(bl || []);
      setAllServices(svcInfos || []);
    }).finally(() => setServicesLoading(false));
  }, []);

  // Methods keyed by service id
  const methodsByService = useMemo(() => {
    const map: Record<string, { name: string; desc: string }[]> = {};
    map['router'] = ROUTER_METHODS.map(name => ({ name, desc: '' }));
    for (const svc of allServices) {
      if (!map[svc.id]) map[svc.id] = [];
      for (const m of (svc.methods || [])) {
        map[svc.id].push({ name: m.name, desc: m.description || '' });
      }
    }
    return map;
  }, [allServices]);

  const toggleBlacklist = (name: string) => {
    setBlacklist(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  };

  const saveBlacklist = async () => {
    setBlSaving(true);
    try {
      await callRpc('setting.blacklist.update', { blacklist });
    } finally {
      setBlSaving(false);
    }
  };

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
        <span>{t('settings.title')}</span>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ── Left sidebar ── */}
        <div style={{ width: '200px', flexShrink: 0, borderRight: '1px solid var(--border-color)', overflowY: 'auto' }}>
          {/* Basic */}
          <button
            onClick={() => setSelected(BASIC_ID)}
            className="transition-all hover:bg-white/[0.02]"
            style={{
              width: '100%', textAlign: 'left', padding: '12px 14px', fontSize: '13px',
              background: selected === BASIC_ID ? 'rgba(255,255,255,0.06)' : 'transparent',
              borderTop: 'none', borderRight: 'none',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              borderLeft: selected === BASIC_ID ? '4px solid var(--accent)' : '4px solid transparent',
              color: selected === BASIC_ID ? '#ffffff' : 'var(--text-primary)',
              fontWeight: selected === BASIC_ID ? 'bold' : 'normal',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
              letterSpacing: '0.04em', textTransform: 'uppercase',
            }}
          >
            <span style={{ fontSize: '11px', opacity: 0.5 }}>⚙</span>
            <span>Basic</span>
          </button>

          {/* Models */}
          <button
            onClick={() => setSelected(MODELS_ID)}
            className="transition-all hover:bg-white/[0.02]"
            style={{
              width: '100%', textAlign: 'left', padding: '12px 14px', fontSize: '13px',
              background: selected === MODELS_ID ? 'rgba(255,255,255,0.06)' : 'transparent',
              borderTop: 'none', borderRight: 'none',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              borderLeft: selected === MODELS_ID ? '4px solid var(--accent)' : '4px solid transparent',
              color: selected === MODELS_ID ? '#ffffff' : 'var(--text-primary)',
              fontWeight: selected === MODELS_ID ? 'bold' : 'normal',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
              letterSpacing: '0.04em', textTransform: 'uppercase',
            }}
          >
            <span style={{ fontSize: '11px', opacity: 0.5 }}>◇</span>
            <span>Models</span>
          </button>

          {/* Section label */}
          <div style={{ padding: '8px 14px 4px', fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Services
          </div>

          {/* Services */}
          {servicesLoading ? (
            <div className="p-4 text-[12px] text-text-secondary">Loading...</div>
          ) : services.length === 0 ? (
            <div className="p-4 text-[12px] text-text-secondary">No services</div>
          ) : services.map(svc => (
            <button
              key={svc.id}
              onClick={() => setSelected(svc.id)}
              className="transition-all hover:bg-white/[0.02]"
              style={{
                width: '100%', textAlign: 'left', padding: '10px 14px', fontSize: '13px',
                background: selected === svc.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                borderTop: 'none', borderRight: 'none',
                borderBottom: '1px solid rgba(255,255,255,0.02)',
                borderLeft: selected === svc.id ? '4px solid var(--accent)' : '4px solid transparent',
                color: selected === svc.id ? '#ffffff' : 'var(--text-primary)',
                fontWeight: selected === svc.id ? 'bold' : 'normal',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: '8px',
              }}
            >
              <span className="font-mono tracking-wide">{svc.id}</span>
              <span style={{
                fontSize: '9px', padding: '1px 5px', borderRadius: '3px',
                background: svc.status === 'online' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                color: svc.status === 'online' ? '#22c55e' : '#ef4444',
                border: `1px solid ${svc.status === 'online' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                flexShrink: 0,
              }}>
                {svc.status === 'online' ? 'ON' : 'OFF'}
              </span>
            </button>
          ))}
        </div>

        {/* ── Right panel ── */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {selected === BASIC_ID ? (
            <BasicPanel services={services} blacklistCount={blacklist.length} />
          ) : selected === MODELS_ID ? (
            <ModelPanel />
          ) : (() => {
            const svc = services.find(s => s.id === selected);
            if (!svc) return <div className="p-6 text-text-secondary text-[13px]">Select a service</div>;
            return (
              <ServicePanel
                svc={svc}
                methods={methodsByService[selected] || []}
                blacklist={blacklist}
                onToggleBlacklist={toggleBlacklist}
                onSaveBlacklist={saveBlacklist}
                blLoading={blSaving}
              />
            );
          })()}
        </div>
      </div>
    </div>
  );
}
