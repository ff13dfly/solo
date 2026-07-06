import React, { useState } from 'react';

interface SystemPanelProps {
  title: string;
  icon?: string;
  badge?: {
    text: string;
    color: string;
    bg: string;
    border: string;
  };
  children: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  style?: React.CSSProperties;
  headerContent?: React.ReactNode;
  contentStyle?: React.CSSProperties;
}

export const SystemPanel: React.FC<SystemPanelProps> = ({
  title,
  icon,
  badge,
  children,
  collapsible = true,
  defaultCollapsed = false,
  style,
  headerContent,
  contentStyle
}) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  return (
    <div className="border border-border bg-bg-primary mb-6" style={style}>
      <div className={`px-4 py-3 font-bold text-accent bg-white/[0.03] flex items-center justify-between gap-3 ${isCollapsed ? '' : 'border-b border-border'}`}>
        <div className="flex items-center gap-3">
          {icon && <span>{icon}</span>}
          {title}
          {badge && (
            <span className="text-[11px] px-2 py-0.5 rounded-xl font-medium" style={{
              background: badge.bg,
              color: badge.color,
              border: `1px solid ${badge.border}`
            }}>
              {badge.text}
            </span>
          )}
          {headerContent}
        </div>

        {collapsible && (
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="bg-transparent border-none text-text-secondary cursor-pointer flex items-center p-1 rounded transition-all outline-none hover:text-text-primary"
          >
            <svg className="transition-transform duration-300" style={{
              transform: isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)'
            }} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z"></path>
            </svg>
          </button>
        )}
      </div>

      {!isCollapsed && (
        <div className="p-0" style={contentStyle}>
          {children}
        </div>
      )}
    </div>
  );
};
