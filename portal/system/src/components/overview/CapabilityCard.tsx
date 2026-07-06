import React from 'react';

interface Capability {
  method: string;
  description: string;
  params: any[];
  returns?: string[];
  ai?: boolean;
  limit?: { window: number; max: number; by: 'user' | 'ip' };
}

interface CapabilityCardProps {
  cap: Capability;
  isNested?: boolean;
}

export const CapabilityCard: React.FC<CapabilityCardProps> = ({ cap, isNested }) => {
  return (
    <div className={`
      flex flex-col gap-2 p-4 rounded-md transition-all cursor-default relative overflow-hidden
      ${isNested
        ? 'bg-[#161b22]/40 border border-dashed border-[#30363d]'
        : 'bg-bg-primary border border-border'}
    `}>
      <div className="flex justify-between items-start gap-4">
        <div className="flex items-center gap-2 min-w-0">
          {cap.ai ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 border border-green-500/40 font-semibold flex-shrink-0">AI</span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 border border-red-500/40 font-semibold flex-shrink-0">NO</span>
          )}
          <span className="font-mono text-accent text-[13px] font-medium truncate" title={cap.method}>
            {cap.method}
          </span>
        </div>

        {cap.limit && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/30 font-medium flex items-center gap-1 flex-shrink-0" title={`Rate limit: ${cap.limit.max} req / ${cap.limit.window}s by ${cap.limit.by}`}>
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {cap.limit.max}/{cap.limit.window}s
            <span className="opacity-60 text-[8px] uppercase">{cap.limit.by === 'user' ? 'u' : 'ip'}</span>
          </span>
        )}
      </div>

      <div className="text-xs text-text-secondary leading-relaxed">
        {cap.description}
      </div>

      {cap.params && cap.params.length > 0 && (
        <div className="mt-auto pt-2 flex flex-wrap gap-1">
          {cap.params.map((p: any, i: number) => (
            <span key={i} title={`${p.name}: ${p.type}`} className="text-[10px] px-1.5 py-0.5 bg-white/5 rounded border border-white/10 text-text-secondary cursor-help">
              <span className="font-semibold text-text-secondary/70">{p.name}</span>
              <span className="opacity-50 mx-0.5">:</span>
              <span className="text-accent/80">{p.type || 'any'}</span>
            </span>
          ))}
        </div>
      )}

      {cap.returns && (
        <div className="mt-1 flex flex-wrap gap-1 items-center">
          <span className="text-[9px] text-green-500 opacity-70 font-semibold">RET</span>
          {Array.isArray(cap.returns) ? (
            cap.returns.map((r: string, i: number) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-green-500/10 rounded border border-green-500/20 text-green-500 font-mono">
                {r}
              </span>
            ))
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 bg-green-500/10 rounded border border-green-500/20 text-green-500 font-mono">
              {cap.returns}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
