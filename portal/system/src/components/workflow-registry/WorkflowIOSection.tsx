import React from 'react';

interface WorkflowIOSectionProps {
  onImport?: () => void;
  onExport?: () => void;
}

const WorkflowIOSection: React.FC<WorkflowIOSectionProps> = ({ onImport, onExport }) => {
  return (
    <div className="flex gap-2 items-center">
      <button
        className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-[11px] font-medium flex items-center gap-1 hover:bg-[#1f6feb] hover:text-white transition-all"
        onClick={onImport}
        title="Import from Redis"
      >
        IMPORT
      </button>
      <button
        className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-[11px] font-medium flex items-center gap-1 hover:bg-[#1f6feb] hover:text-white transition-all"
        onClick={onExport}
        title="Export to Redis"
      >
        EXPORT
      </button>
      <div className="w-px h-3.5 bg-white/10 mx-1"></div>
    </div>
  );
};

export default WorkflowIOSection;
