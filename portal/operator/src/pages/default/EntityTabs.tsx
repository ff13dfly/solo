import type { ReactNode } from 'react';
import { CategoryManager } from './CategoryManager';
import { stripPrefix } from './utils';

interface ExtraTab {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface EntityTabsProps {
  entityNames: string[];
  activeEntity: string;
  setActiveEntity: (name: string) => void;
  serviceId: string;
  extraTabs?: ExtraTab[];
}

export function EntityTabs({
  entityNames,
  activeEntity,
  setActiveEntity,
  serviceId,
  extraTabs = [],
}: EntityTabsProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0', flexShrink: 0 }}>
      {/* Entity tabs */}
      <div style={{ display: 'flex', gap: '16px', overflowX: 'auto' }}>
        {entityNames.map(name => (
          <button
            key={name}
            onClick={() => setActiveEntity(name)}
            className={`tab-btn${activeEntity === name ? ' active' : ''}`}
          >
            {stripPrefix(name, serviceId).toUpperCase()}
          </button>
        ))}
      </div>

      {/* Right side: extra text tabs + category manager */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {extraTabs.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: '#e2e8f0', margin: '0 8px' }} />
            {extraTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveEntity(tab.id)}
                className={`tab-btn${activeEntity === tab.id ? ' active' : ''}`}
              >
                {tab.label}
              </button>
            ))}
          </>
        )}
        <CategoryManager serviceId={serviceId} />
      </div>
    </div>
  );
}
