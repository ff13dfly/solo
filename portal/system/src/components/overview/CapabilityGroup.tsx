import React, { useState } from 'react';
import { CapabilityCard } from './CapabilityCard';

interface Capability {
  method: string;
  service: string;
  description: string;
  params: any[];
  returns?: string[];
  ai?: boolean;
}

interface CapabilityGroupProps {
  prefix: string;
  capabilities: Capability[];
  initialExpanded?: boolean;
}

export const CapabilityGroup: React.FC<CapabilityGroupProps> = ({ prefix, capabilities, initialExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  return (
    <div className="flex flex-col gap-3 mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="
          flex items-center gap-3 px-4 py-3 bg-[#388bfd]/10 border border-[#388bfd]/30 rounded-md
          text-[#58a6ff] cursor-pointer w-full text-left transition-all hover:bg-[#388bfd]/20 outline-none
        "
      >
        <div className={`
          flex items-center justify-center w-5 h-5 transition-transform duration-200
          ${isExpanded ? 'rotate-90' : 'rotate-0'}
        `}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path>
          </svg>
        </div>
        <span className="font-semibold text-sm font-mono truncate">
          {prefix}{prefix !== 'basic' ? '.*' : ''}
        </span>
        <span className="text-xs text-text-secondary ml-auto opacity-80 whitespace-nowrap">
          {capabilities.length} methods
        </span>
      </button>

      {isExpanded && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 pl-6 border-l-2 border-[#388bfd]/20">
          {capabilities.map((cap, idx) => (
            <CapabilityCard key={idx} cap={cap} isNested={true} />
          ))}
        </div>
      )}
    </div>
  );
};
