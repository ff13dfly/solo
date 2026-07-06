import React from 'react';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  color?: string; // RGB string like "88, 166, 255"
  tag?: string;
  tagColor?: string;
}

interface TabbedLayoutProps {
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: React.ReactNode;
  headerStyle?: React.CSSProperties;
}

export const TabbedLayout: React.FC<TabbedLayoutProps> = ({
  tabs,
  activeTab,
  onTabChange,
  children,
  headerStyle
}) => {
  return (
    <div className="flex flex-col h-full">
      <div
        className="border-b border-border px-4 flex gap-0.5 bg-bg-secondary/50 overflow-x-auto"
        style={headerStyle}
      >
        {tabs.map(tab => {
          const color = tab.color || '88, 166, 255';
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-5 py-3 border-none cursor-pointer text-xs transition-all outline-none whitespace-nowrap flex items-center gap-2 ${isActive
                  ? 'text-text-primary font-semibold'
                  : 'text-text-secondary font-normal hover:text-text-primary'
                }`}
              style={{
                background: isActive ? `rgba(${color}, 0.1)` : 'transparent',
                borderBottom: isActive ? `2px solid rgb(${color})` : '2px solid transparent',
              }}
            >
              {tab.label}
              {tab.tag && (
                <span
                  className="text-[9px] px-1 py-px border"
                  style={{ color: tab.tagColor, borderColor: tab.tagColor, opacity: 0.7 }}
                >{tab.tag}</span>
              )}
              {tab.count !== undefined && (
                <span className="text-[10px] opacity-60 bg-white/5 px-1.5 py-px rounded-full">{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex-1 bg-transparent overflow-hidden">
        {children}
      </div>
    </div>
  );
};
