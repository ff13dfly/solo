import { useLang } from '../../providers/LanguageProvider';

export interface ServiceNode {
  id: string;
  url: string;
  status: 'active' | 'unknown' | 'error' | 'pending';
  lastSeen?: string;
  version?: string;
  methods?: any[];
  entities?: Record<string, { description: string; fields: Record<string, any> }>;
}

interface ServiceDetailModalProps {
  service: ServiceNode;
  onClose: () => void;
}

export default function ServiceDetailModal({ service, onClose }: ServiceDetailModalProps) {
  const { t } = useLang();

  return (
    <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999] backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[800px] max-h-[80vh] flex flex-col bg-bg-primary border border-border shadow-[0_12px_48px_rgba(0,0,0,0.6)] rounded-lg font-sans"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
          <span>{t('service.modal_title')} {service.id.toUpperCase()}</span>
          <button
            onClick={onClose}
            className="border-none bg-transparent text-text-secondary p-0 text-base hover:text-error transition-colors"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border flex gap-6 text-xs font-mono">
          <span className="text-text-secondary">URL: <span className="text-accent">{service.url}</span></span>
          <span className="text-text-secondary">VERSION: <span className="text-text-primary">{service.version || '1.0.0'}</span></span>
        </div>

        <div className="flex-1 overflow-y-auto bg-bg-primary flex flex-col divide-y divide-border">
          {/* RPC Methods Section */}
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4 text-xs font-black text-blue-400 uppercase tracking-[0.2em]">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]" />
              RPC Methods
            </div>
            <div className="space-y-4">
              {service.methods?.map((m, i) => (
                <div key={i} className="pb-4 border-b border-[#21262d] last:border-0 last:pb-0 group font-mono">
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
              {service.entities && Object.keys(service.entities).length > 0 ? (
                Object.entries(service.entities).map(([name, def]: [string, any]) => (
                  <div key={name} className="pb-6 border-b border-[#21262d] last:border-0 last:pb-0 font-mono">
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
            onClick={onClose}
          >
            {t('service.modal_close')}
          </button>
        </div>
      </div>
    </div>
  );
}
