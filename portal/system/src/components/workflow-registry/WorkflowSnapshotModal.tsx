import { formatDate } from '../../utils/format';

interface Workflow {
  id: string;
  name: string;
  desc: string;
  tags: string[];
}

interface WorkflowSnapshotModalProps {
  loading: boolean;
  workflows: Workflow[];
  timestamp: number | null;
  onClose: () => void;
}

export default function WorkflowSnapshotModal({
  loading,
  workflows,
  timestamp,
  onClose
}: WorkflowSnapshotModalProps) {
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
            <span className="text-base">🧠</span>
            <span>AI CAPABILITY SNAPSHOT</span>
          </div>
          <button
            className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-0.5 text-sm font-medium hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white transition-all"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="p-10 text-center opacity-50">Loading capability set...</div>}
          {!loading && workflows.length === 0 && (
            <div className="p-10 text-center opacity-50">No cached capabilities found. Try "BUILD & DEPLOY" first.</div>
          )}
          {!loading && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {workflows.map(wf => (
                <div
                  key={wf.id}
                  className="bg-accent/5 border border-accent/20 rounded-lg flex flex-col gap-1.5 p-3 transition-transform hover:-translate-y-0.5 cursor-default"
                >
                  <div className="font-semibold text-accent text-[13px]">{wf.name}</div>
                  <div className="text-[10px] opacity-50 font-mono">ID: {wf.id}</div>
                  <div className="text-[11px] opacity-80 mt-1">
                    {wf.desc?.substring(0, 80)}{wf.desc?.length > 80 ? '...' : ''}
                  </div>
                  <div className="mt-auto flex flex-wrap gap-1 pt-2">
                    {wf.tags?.map((t: string) => (
                      <span key={t} className="text-[9px] bg-black/30 px-1 py-0.5 rounded">#{t}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] opacity-50 bg-black/20 flex justify-between">
          <span>Showing workflows recognized by AI Agent.</span>
          {timestamp && <span>Last Built: {formatDate(timestamp)}</span>}
        </div>
      </div>
    </div>
  );
}
