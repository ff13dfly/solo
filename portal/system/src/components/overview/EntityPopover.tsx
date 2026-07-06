import React from 'react';

interface EntityPopoverProps {
  entityName: string;
  def: {
    fields: Record<string, any>;
  };
}

export const EntityPopover: React.FC<EntityPopoverProps> = ({ entityName, def }) => {
  return (
    <div
      className="absolute top-[calc(100%+12px)] right-0 w-60 bg-bg-primary border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.5)] z-[100] p-3 flex flex-col gap-2 animate-[fadeInDown_0.2s_ease-out]"
      onClick={e => e.stopPropagation()}
    >
      {/* Arrow */}
      <div className="absolute -top-1.5 right-5 w-2.5 h-2.5 bg-bg-primary border-l border-t border-border rotate-45" />

      <div className="text-xs text-text-primary font-semibold border-b border-[#21262d] pb-1.5 mb-1">
        {entityName.toUpperCase()} FIELDS
      </div>
      <div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto">
        {Object.entries(def.fields).map(([fname, fdef]: [string, any]) => (
          <div key={fname} className="flex justify-between items-center px-2 py-1 bg-text-secondary/5 rounded text-[11px]">
            <span className="text-text-primary font-mono">{fname}</span>
            <span className="text-text-secondary text-[10px]">{fdef.type}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
