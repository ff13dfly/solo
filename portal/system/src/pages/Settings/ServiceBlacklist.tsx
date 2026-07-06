import { useLang } from '../../providers/LanguageProvider';

interface ServiceBlacklistProps {
  methods: { name: string; desc: string }[];
  blacklist: string[];
  onToggle: (name: string) => void;
  onSave: () => Promise<void>;
  loading: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
}

export const ServiceBlacklist: React.FC<ServiceBlacklistProps> = ({
  methods, blacklist, onToggle, onSave, loading, message
}) => {
  const { t } = useLang();
  const blockedCount = methods.filter(m => blacklist.includes(m.name)).length;

  return (
    <div className="flex flex-col h-full">
      <p className="text-text-secondary text-[13px] mb-4">
        {t('settings.desc_blacklist')}
      </p>

      {methods.length === 0 ? (
        <div className="p-10 text-center text-text-secondary text-[13px]">No registered methods for this service</div>
      ) : (
        <div className="flex-1 overflow-y-auto pr-1" style={{ maxHeight: 'calc(100vh - 340px)' }}>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-[12px] text-text-secondary">
              {blockedCount} / {methods.length} blocked
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {methods.map(m => {
              const blocked = blacklist.includes(m.name);
              return (
                <button
                  key={m.name}
                  onClick={() => onToggle(m.name)}
                  title={m.desc || m.name}
                  className="font-mono transition-all"
                  style={{
                    padding: '3px 10px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer',
                    border: `1px solid ${blocked ? '#f87171' : 'var(--border-color)'}`,
                    background: blocked ? 'rgba(239,68,68,0.08)' : 'transparent',
                    color: blocked ? '#ef4444' : 'var(--text-primary)',
                    textDecoration: blocked ? 'line-through' : 'none',
                    opacity: blocked ? 0.7 : 1,
                  }}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-5 mb-2 flex gap-4 items-center">
        <button
          onClick={onSave}
          disabled={loading}
          className="bg-accent-dim border border-accent/40 text-accent rounded-md px-6 py-2 text-xs font-medium hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'SAVING...' : t('settings.btn_save')}
        </button>
        {message && (
          <span className={`text-[13px] px-2 py-1 rounded border ${message.type === 'success' ? 'text-success bg-success/10 border-success/30' : 'text-error bg-error/10 border-error/30'}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
};
