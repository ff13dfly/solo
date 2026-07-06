import { useUI } from '../../providers/UIProvider';

interface WorkflowRawJsonModalProps {
  workflow: any;
  onClose: () => void;
}

export default function WorkflowRawJsonModal({
  workflow,
  onClose
}: WorkflowRawJsonModalProps) {
  const { toast } = useUI();

  const handleExport = () => {
    const dataStr = JSON.stringify(workflow, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workflow.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Exported!');
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex justify-center items-center z-[9999]"
      onClick={onClose}
    >
      <div
        className="w-[700px] max-h-[80vh] flex flex-col bg-bg-primary border border-border rounded-lg shadow-[0_12px_48px_rgba(0,0,0,0.6)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white transition-all"
              onClick={handleExport}
            >
              EXPORT
            </button>
            <span>RAW :: {workflow.id}</span>
          </div>
          <button
            className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-0.5 text-sm font-medium hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white transition-all"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <pre className="m-0 text-[11px] font-mono whitespace-pre-wrap break-all text-text-secondary">
            {JSON.stringify(workflow, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
