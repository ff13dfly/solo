import React from 'react';

export interface TabItem {
    id: string;
    label: string;
    count?: number;
    icon?: React.ReactNode;
}

interface TabsProps {
    tabs: TabItem[];
    activeTab: string;
    onChange: (id: string) => void;
    className?: string;
}

export const Tabs: React.FC<TabsProps> = ({ tabs, activeTab, onChange, className = '' }) => {
    return (
        <div className={`flex items-center gap-1 border-b border-border bg-bg-secondary/50 px-4 overflow-x-auto no-scrollbar ${className}`}>
            {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onChange(tab.id)}
                        className={`
              relative flex items-center gap-2 px-4 py-3 text-xs font-medium transition-colors outline-none whitespace-nowrap cursor-pointer
              ${isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-white/5'}
            `}
                    >
                        {tab.icon && <span className="text-base">{tab.icon}</span>}
                        {tab.label}
                        {tab.count !== undefined && (
                            <span className={`
                ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-white/10
                ${isActive ? 'text-text-primary' : 'text-text-secondary'}
              `}>
                                {tab.count}
                            </span>
                        )}
                        {isActive && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" />
                        )}
                    </button>
                );
            })}
        </div>
    );
};
