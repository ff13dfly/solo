import { formatDate } from '../../utils/format';

interface Workflow {
  id: string;
  name: string;
  updatedAt: number;
}

interface WorkflowRecycleBinModalProps {
  loading: boolean;
  workflows: Workflow[];
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
  onRefresh: () => void;
}

export default function WorkflowRecycleBinModal({
  loading,
  workflows,
  onClose,
  onRestore,
  onRefresh
}: WorkflowRecycleBinModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/80 flex justify-center items-center z-[9999]"
      onClick={onClose}
    >
      <div
        className="w-[800px] h-[600px] flex flex-col bg-bg-primary border border-border rounded-lg shadow-[0_12px_48px_rgba(0,0,0,0.6)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="text-base">🗑️</span>
            <span>RECYCLE BIN</span>
          </div>
          <button
            className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-0.5 text-sm font-medium hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white transition-all"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="p-10 text-center opacity-50">Loading...</div>}
          {!loading && workflows.length === 0 && (
            <div className="p-10 text-center opacity-50">Recycle bin is empty</div>
          )}
          {!loading && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {workflows.map(wf => (
                <div
                  key={wf.id}
                  className="bg-white/[0.03] border border-border rounded-lg flex flex-col gap-2 p-3 transition-transform hover:-translate-y-0.5 cursor-default"
                >
                  <div className="flex justify-between items-start">
                    <div className="font-semibold text-accent text-[13px] break-all">{wf.name}</div>
                  </div>
                  <div className="text-[10px] opacity-50 font-mono">ID: {wf.id}</div>
                  <div className="text-[10px] mt-auto flex flex-wrap gap-1">
                    <span className="opacity-60">Deleted: {formatDate(wf.updatedAt)}</span>
                  </div>
                  <div className="border-t border-border pt-2 mt-1 flex justify-end">
                    <button
                      className="bg-accent-dim border border-[#238636] text-[#3fb950] rounded-md px-3 py-1 text-[11px] font-medium hover:bg-[#238636] hover:text-white transition-all"
                      onClick={async () => {
                        await onRestore(wf.id);
                        onRefresh();
                      }}
                    >
                      RESTORE
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] opacity-50 bg-black/20">
          Items in recycle bin can be restored to the registry.
        </div>
      </div>
    </div>
  );
}
