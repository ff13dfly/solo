import React, { useState, useMemo, useEffect } from 'react';
import { Card } from '../ui/Card';
import { Tabs, type TabItem } from '../ui/Tabs';

interface PublicMethodsProps {
  systemMethods: string[];
  serviceMethods: string[];
}

export const PublicMethods: React.FC<PublicMethodsProps> = ({ systemMethods, serviceMethods }) => {
  const [activeTab, setActiveTab] = useState('system');
  const [selectedNamespace, setSelectedNamespace] = useState('ALL');
  const [isCollapsed, setIsCollapsed] = useState(true);

  // Reset namespace when tab changes
  useEffect(() => {
    setSelectedNamespace('ALL');
  }, [activeTab]);

  const namespaces = useMemo(() => {
    const list = activeTab === 'system' ? systemMethods : serviceMethods;
    const set = new Set<string>();
    list.forEach(m => {
      const parts = m.split('.');
      if (parts.length > 1) {
        set.add(parts[0]); // Only the first part (microservice)
      } else {
        set.add('core');
      }
    });
    return Array.from(set).sort();
  }, [activeTab, systemMethods, serviceMethods]);

  const filteredMethods = useMemo(() => {
    const list = activeTab === 'system' ? systemMethods : serviceMethods;
    if (selectedNamespace === 'ALL') return list.sort();

    return list.filter(m => {
      if (selectedNamespace === 'core') {
        return !m.includes('.');
      }
      return m.startsWith(`${selectedNamespace}.`);
    }).sort();
  }, [activeTab, selectedNamespace, systemMethods, serviceMethods]);

  const tabs: TabItem[] = [
    { id: 'system', label: 'SYSTEM INTERNAL', count: systemMethods.length },
    { id: 'service', label: 'SERVICE PUBLIC', count: serviceMethods.length }
  ];

  const colorClass = activeTab === 'system'
    ? 'bg-text-secondary/10 border-text-secondary/30 text-text-secondary/80 hover:bg-text-secondary/20'
    : 'bg-accent/10 border-accent/30 text-accent hover:bg-accent/20';

  return (
    <Card
      title={
        <div className="flex items-center gap-3">
          <span>🔓 PUBLIC METHODS</span>
          <span className="px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/40 text-[10px] font-medium">NO AUTH REQUIRED</span>
        </div>
      }
      headerAction={
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-1 hover:bg-white/10 rounded transition-all cursor-pointer outline-none border-none text-text-secondary hover:text-text-primary"
          title={isCollapsed ? 'Expand' : 'Collapse'}
        >
          <svg
            className={`w-5 h-5 transition-transform duration-300 ${isCollapsed ? '-rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      }
    >
      {!isCollapsed && (
        <>
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={setActiveTab}
            className="justify-end"
          />

          <div className="flex h-72 animate-in fade-in slide-in-from-top-2 duration-300">
            {/* Sidebar */}
            <div className="w-[23%] border-r border-border bg-bg-secondary/10 flex flex-col overflow-hidden">
              <div className="p-2 space-y-2 overflow-y-auto no-scrollbar">
                <button
                  onClick={() => setSelectedNamespace('ALL')}
                  className={`
                    w-full text-center px-3 py-2 rounded text-[11px] font-bold tracking-widest transition-all cursor-pointer outline-none border !normal-case
                    ${selectedNamespace === 'ALL'
                      ? 'bg-accent/20 text-accent border-accent/30'
                      : 'text-text-secondary/60 hover:text-text-primary hover:bg-white/5 border-transparent'}
                  `}
                >
                  all methods
                </button>
                <div className="grid grid-cols-2 gap-1">
                  {namespaces.map(ns => (
                    <button
                      key={ns}
                      onClick={() => setSelectedNamespace(ns)}
                      className={`
                        text-center px-2 py-2 rounded text-[11px] font-medium transition-all cursor-pointer outline-none overflow-hidden text-ellipsis whitespace-nowrap border !normal-case
                        ${selectedNamespace === ns
                          ? 'bg-accent/10 text-accent border-accent/20'
                          : 'text-text-secondary/70 hover:bg-white/5 hover:text-text-primary border-transparent'}
                      `}
                      title={ns}
                    >
                      {ns}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5 bg-bg-primary/20 no-scrollbar content-start">
              {filteredMethods.length === 0 ? (
                <div className="flex h-full items-center justify-center text-text-secondary text-xs italic">
                  No methods found
                </div>
              ) : (
                <div className="flex flex-wrap gap-2.5 content-start">
                  {filteredMethods.map((method, idx) => (
                    <span key={idx} className={`
                      inline-block px-2.5 py-1.5 rounded font-mono text-[11px] transition-all border
                      ${colorClass}
                    `}>
                      {method}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
};
