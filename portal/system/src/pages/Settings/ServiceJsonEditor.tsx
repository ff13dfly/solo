import { useLang } from '../../providers/LanguageProvider';

interface ServiceJsonEditorProps {
  tab: 'tasks' | 'limits';
  jsonContent: string;
  onChange: (val: string) => void;
  onSave: () => Promise<void>;
  loading: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
}

export const ServiceJsonEditor: React.FC<ServiceJsonEditorProps> = ({
  tab, jsonContent, onChange, onSave, loading, message
}) => {
  const { t } = useLang();

  return (
    <div className="flex flex-col h-full">
      <p className="text-text-secondary mb-4">
        {tab === 'tasks' ? t('settings.desc_tasks') : t('settings.desc_limits')}
      </p>
      <div className="flex-1 flex flex-col">
        <label className="block mb-2 font-bold">
          {tab === 'tasks' ? t('settings.json_label') : t('settings.json_label_limits')}
        </label>
        <textarea
          value={jsonContent}
          onChange={(e) => onChange(e.target.value)}
          className="w-full flex-1 min-h-[300px] font-mono text-[13px] bg-bg-primary text-text-primary border border-border rounded-md p-3 leading-relaxed resize-none outline-none focus:border-accent transition-colors"
          spellCheck={false}
        />
        <div className="mt-1 text-[11px] text-text-secondary text-right">JSON Format</div>
      </div>
      <div className="mt-5 mb-5 flex gap-4 items-center">
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
