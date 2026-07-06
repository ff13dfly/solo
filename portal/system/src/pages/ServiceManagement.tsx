import { callRpc } from '../utils/rpc';
import React, { useState, useEffect } from 'react';
import { useUI } from '../providers/UIProvider';

interface ServiceNode {
  id: string;
  url: string;
  status: 'active' | 'unknown' | 'error' | 'pending';
  lastSeen?: string;
  version?: string;
  methods?: any[];
  entities?: Record<string, { description: string, fields: Record<string, any> }>;
}

import { useLang } from '../providers/LanguageProvider';

export default function ServiceManagement() {
  const { toast, confirm } = useUI();
  const { t } = useLang();

  const [url, setUrl] = useState('');
  const [services, setServices] = useState<ServiceNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [isAutoDetect, setIsAutoDetect] = useState(false);
  const servicesRef = React.useRef(services);
  const checkIdxRef = React.useRef(0);

  servicesRef.current = services;

  const [selectedService, setSelectedService] = useState<ServiceNode | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let interval: any;
    if (isAutoDetect) {
      interval = setInterval(() => {
        const list = servicesRef.current;
        if (list.length === 0 || checkIdxRef.current >= list.length) {
          setIsAutoDetect(false);
          return;
        }
        const idx = checkIdxRef.current;
        const id = list[idx].id;
        checkStatus(id, true);
        checkIdxRef.current++;
      }, 300);
    }
    return () => clearInterval(interval);
  }, [isAutoDetect]);

  useEffect(() => {
    fetchServices();
  }, []);

  const fetchServices = async () => {
    try {
      const list = await callRpc<ServiceNode[]>('system.service.list', {});
      setServices(list.map(s => ({
        ...s,
        status: (['configured', 'online'].includes(s.status as string) ? 'active' : s.status) as any,
        lastSeen: s.lastSeen ? formatOnlyTime(new Date(s.lastSeen)) : undefined
      })));
    } catch (err: any) {
      console.error('Failed to fetch services:', err);
      toast.error(t('service.toast_fetch_fail'));
    }
  };

  const formatOnlyTime = (date: Date) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);

    try {
      const result = await callRpc<{ serviceName: string, methods: any[], version: string }>('system.service.add', { url });

      console.log('Service added:', result);
      toast.success(t('service.toast_add_success', { name: result.serviceName }));

      setServices(prev => [...prev, {
        id: result.serviceName,
        url: url,
        status: 'active',
        lastSeen: formatOnlyTime(new Date()),
        version: result.version,
        methods: result.methods,
        entities: (result as any).entities || {}
      }]);
      setUrl('');
    } catch (err: any) {
      console.error('Failed to add service:', err);
      toast.error(err.message || t('service.toast_add_fail'));
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async (id: string, silent: boolean = false) => {
    try {
      const res = await callRpc<{ status: string, latency: number, error?: string }>('system.service.status', { serviceId: id });
      console.log('Status check:', res);
      setServices(prev => prev.map(s => {
        if (s.id === id) {
          return {
            ...s,
            status: (res.status === 'online' ? 'active' : 'error') as any,
            lastSeen: formatOnlyTime(new Date())
          };
        }
        return s;
      }));
      if (res.status === 'online') {
        if (!silent) toast.success(t('service.toast_online', { id, latency: res.latency }));
      } else {
        if (!silent) toast.error(t('service.toast_offline', { id }));
      }
    } catch (err) {
      if (!silent) toast.error(t('service.toast_check_fail', { id }));
      setServices(prev => prev.map(s => {
        if (s.id === id) {
          return { ...s, status: 'error', lastSeen: formatOnlyTime(new Date()) };
        }
        return s;
      }));
    }
  };

  const handleDelete = async (id: string) => {
    const isConfirmed = await confirm({
      message: t('service.confirm_remove', { id }),
      confirmLabel: t('service.confirm_remove_btn'),
      isDangerous: true
    });

    if (!isConfirmed) return;

    callRpc('system.service.remove', { serviceId: id })
      .then(() => {
        toast.success(t('service.toast_remove_success', { id }));
        setServices(prev => prev.filter(s => s.id !== id));
      })
      .catch(err => {
        console.error('Delete failed:', err);
        toast.error(t('service.toast_remove_fail', { msg: err.message }));
      });
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1200);
    }).catch(() => toast.error(t('service.toast_copy_fail')));
  };

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Title Bar */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span>{t('service.active_title')}</span>
          <button
            className={`px-2 py-0.5 text-[10px] border rounded transition-all ${isAutoDetect ? 'bg-green-500 border-green-500 text-white' : 'bg-accent-dim border-accent/40 text-accent hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white'}`}
            onClick={() => {
              const newState = !isAutoDetect;
              setIsAutoDetect(newState);
              if (newState) {
                // Set all to pending for better visual feedback
                setServices(prev => prev.map(s => ({ ...s, status: 'pending' as any })));
                checkIdxRef.current = 0; // Reset index to start from beginning
              }
            }}
          >
            {isAutoDetect ? t('service.auto_on') : t('service.auto_off')}
          </button>
        </div>
        <div className="flex gap-3 items-center bg-white/[0.03] px-3 py-1 rounded-md border border-white/5">
          <form onSubmit={handleAdd} className="flex items-center gap-2">
            <input
              className="w-56 bg-bg-primary rounded-md border border-border py-1 px-3 text-text-primary text-[12px] outline-none focus:border-accent transition-colors"
              type="text"
              value={url}
              onChange={e => { setUrl(e.target.value); }}
              placeholder={t('service.placeholder_url')}
              disabled={loading}
            />
            <button type="submit" className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap" disabled={loading}>
              {loading ? t('service.adding_btn') : t('service.add_btn')}
            </button>
          </form>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Header Row */}
        <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-accent text-[11px] uppercase tracking-wider sticky top-0 z-10 grid-cols-[40px_120px_90px_1fr_70px_100px_100px_160px]">
          <div>#</div>
          <div>{t('service.col_id')}</div>
          <div>{t('service.col_status')}</div>
          <div>{t('service.col_url')}</div>
          <div>{t('service.col_version')}</div>
          <div>{t('service.col_methods')}</div>
          <div>{t('service.col_last_seen')}</div>
          <div>{t('service.col_action')}</div>
        </div>

        {/* Data Rows */}
        <div className="flex-1 overflow-y-auto">
          {services.map((svc, index) => (
            <div key={svc.id} className="grid gap-4 px-5 border-b border-border items-center h-[52px] hover:bg-white/[0.02] transition-colors grid-cols-[40px_120px_90px_1fr_70px_100px_100px_160px]">
              <div className="font-bold text-[#484f58] text-[11px]">#{index + 1}</div>
              <div className="font-medium text-text-secondary truncate text-[12px]">{svc.id}</div>
              <div className={`text-[11px] font-bold flex items-center gap-2 ${svc.status === 'active' ? 'text-success' : svc.status === 'error' ? 'text-error' : svc.status === 'pending' ? 'text-text-secondary animate-pulse' : 'text-text-secondary'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${svc.status === 'active' ? 'bg-success shadow-[0_0_8px_var(--color-success)]' : svc.status === 'error' ? 'bg-error shadow-[0_0_8px_var(--color-error)]' : svc.status === 'pending' ? 'bg-amber-500 shadow-[0_0_8px_var(--color-warning)]' : 'bg-text-secondary'}`} />
                {t(`status.${svc.status}` as any) || svc.status.toUpperCase()}
              </div>
              <div
                className="flex items-center gap-1.5 text-accent text-[12px] truncate cursor-pointer hover:underline transition-all"
                title={svc.url}
                onClick={() => handleCopy(svc.url, svc.id)}
              >
                <span className="truncate">{svc.url}</span>
                {copiedId === svc.id && <span className="text-success text-[11px] shrink-0">✓</span>}
              </div>
              <div className="text-text-secondary text-[12px]">{svc.version || '-'}</div>
              <div className="text-[12px] relative">
                {svc.methods && svc.methods.length > 0 ? (
                  <span
                    className="bg-white/5 border border-border rounded-xl px-2 py-0.5 text-[11px] text-text-secondary cursor-help hover:border-accent hover:text-accent transition-colors"
                    onClick={() => setSelectedService(svc)}
                  >
                    {svc.methods.length} {t('service.supported')}
                  </span>
                ) : '-'}
              </div>
              <div className="text-[11px] text-text-secondary">{svc.lastSeen}</div>
              <div className="flex gap-2">
                <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-4 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all" onClick={() => checkStatus(svc.id)}>{t('service.btn_check')}</button>
                {svc.id !== 'administrator' && (
                  <button className="bg-error/10 border border-error/40 text-error rounded-md px-4 py-1.5 text-[11px] font-medium hover:bg-error hover:text-white transition-all" onClick={() => handleDelete(svc.id)}>DEL</button>
                )}
              </div>
            </div>
          ))}

          {services.length === 0 && (
            <div className="p-6 text-center opacity-50">
              No services found.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center">
          <span className="text-xs text-text-secondary">TOTAL: {services.length} NODES</span>
        </div>
      </div>

      {/* Methods/Entities Detail Modal */}
      {selectedService && (
        <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999] backdrop-blur-sm" onClick={() => setSelectedService(null)}>
          <div
            className="w-[800px] max-h-[80vh] flex flex-col bg-bg-primary border border-border shadow-[0_12px_48px_rgba(0,0,0,0.6)] rounded-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
              <span>{t('service.modal_title')} {selectedService.id.toUpperCase()}</span>
              <button
                onClick={() => setSelectedService(null)}
                className="border-none bg-transparent text-text-secondary p-0 text-base hover:text-error transition-colors"
              >
                ×
              </button>
            </div>

            <div className="px-4 py-3 border-b border-border flex gap-6 text-xs">
              <span className="text-text-secondary">URL: <span className="text-accent">{selectedService.url}</span></span>
              <span className="text-text-secondary">VERSION: <span className="text-text-primary">{selectedService.version || '1.0.0'}</span></span>
            </div>

            <div className="flex-1 overflow-y-auto bg-bg-primary flex flex-col divide-y divide-border">
              {/* RPC Methods Section */}
              <div className="p-6">
                <div className="flex items-center gap-2 mb-4 text-xs font-black text-blue-400 uppercase tracking-[0.2em]">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]" />
                  RPC Methods
                </div>
                <div className="space-y-4">
                  {selectedService.methods?.map((m, i) => (
                    <div key={i} className="pb-4 border-b border-[#21262d] last:border-0 last:pb-0 group">
                      <span className="font-mono text-sm text-blue-400 font-bold block group-hover:text-blue-300 transition-colors">{m.name || m}</span>
                      {m.description && <span className="text-xs text-slate-400 leading-relaxed block mt-1">{m.description}</span>}
                      {m.params && m.params.length > 0 && (
                        <div className="mt-2 text-[10px] text-slate-500 font-mono">
                          {t('service.params')}: <span className="text-slate-400">{m.params.map((p: any) => p.name).join(', ')}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Entities Section */}
              <div className="p-6">
                <div className="flex items-center gap-2 mb-4 text-xs font-black text-rose-400 uppercase tracking-[0.2em]">
                  <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]" />
                  Entities
                </div>
                <div className="space-y-6">
                  {selectedService.entities && Object.keys(selectedService.entities).length > 0 ? (
                    Object.entries(selectedService.entities).map(([name, def]: [string, any]) => (
                      <div key={name} className="pb-6 border-b border-[#21262d] last:border-0 last:pb-0">
                        <span className="font-black text-slate-200 text-sm block mb-1">{name.toUpperCase()}</span>
                        {def.description && <span className="text-xs text-slate-500 block mb-3 italic">{def.description}</span>}
                        {def.fields && (
                          <div className="flex flex-col gap-2">
                            {Object.entries(def.fields).map(([fname, fdef]: [string, any]) => (
                              <div key={fname} className="flex items-center justify-between p-2 rounded bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-all group">
                                <span className="text-xs font-mono text-rose-300/80 group-hover:text-rose-300 transition-colors">{fname}</span>
                                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-tighter">{fdef.type}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-600 text-sm italic py-4">{t('service.no_entities')}</div>
                  )}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-border bg-bg-secondary text-right">
              <button
                className="px-6 py-2 bg-[#21262d] hover:bg-[#30363d] text-slate-300 text-xs font-bold rounded-lg border border-border transition-all active:scale-95"
                onClick={() => setSelectedService(null)}
              >
                {t('service.modal_close')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
