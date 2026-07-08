import { useState } from 'react';
import { useLang } from '../providers/LanguageProvider';
import SourcesTab from './ingress/SourcesTab';
import DeliveriesTab from './ingress/DeliveriesTab';
import type { Tab } from './ingress/types';

export default function IngressManagement() {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>('sources');

  const TABS: { id: Tab; label: string }[] = [
    { id: 'sources',    label: t('ingress_mgmt.tab_sources') },
    { id: 'deliveries', label: t('ingress_mgmt.tab_deliveries') },
  ];

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex items-center shrink-0">
        <span>{t('ingress_mgmt.header')}</span>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-border shrink-0 bg-bg-secondary">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 h-10 text-[11px] font-mono uppercase tracking-wider transition-colors border-b-2
              ${tab === t.id
                ? 'border-accent text-accent bg-bg-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-white/[0.02]'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {tab === 'sources'    && <SourcesTab />}
        {tab === 'deliveries' && <DeliveriesTab />}
      </div>
    </div>
  );
}
