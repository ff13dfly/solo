import { useState } from 'react';
import { useLang } from '../../providers/LanguageProvider';

interface WorkflowDenyModalProps {
  workflowName: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export default function WorkflowDenyModal({ workflowName, onClose, onConfirm }: WorkflowDenyModalProps) {
  const { t } = useLang();
  const [denyReason, setDenyReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!denyReason.trim()) return;
    setSubmitting(true);
    try {
      await onConfirm(denyReason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999]">
      <div className="w-[480px] bg-bg-primary border border-border shadow-[0_8px_24px_rgba(0,0,0,0.5)] rounded-lg">
        <div className="px-4 py-3 border-b border-border font-bold text-error">
          {t('approval.deny_title') || 'DENY WORKFLOW'}
        </div>
        <div className="p-4">
          <p className="mb-3 text-sm text-text-primary">
            Deny <strong className="text-accent">{workflowName}</strong>? This moves it to REJECTED status.
          </p>
          <label className="block text-[10px] text-text-secondary mb-1.5 uppercase tracking-wider font-bold">
            Reason (required)
          </label>
          <textarea
            className="w-full bg-bg-secondary border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-none focus:outline-none focus:border-accent/60 font-sans"
            rows={3}
            placeholder="Explain why this workflow is being denied..."
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            disabled={submitting}
            autoFocus
          />
          <div className="flex justify-end gap-3 mt-4 font-sans">
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
              onClick={onClose}
              disabled={submitting}
            >
              CANCEL
            </button>
            <button
              className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1.5 text-xs font-medium hover:bg-error hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleConfirm}
              disabled={!denyReason.trim() || submitting}
            >
              {submitting ? 'DENYING...' : 'DENY WORKFLOW'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
