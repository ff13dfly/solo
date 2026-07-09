import { useState } from 'react';
import { useLang } from '../providers/LanguageProvider';
import SourcesTab from './ingress/SourcesTab';
import DeliveriesTab from './ingress/DeliveriesTab';
import { OUTCOMES } from './ingress/utils';
import type { Tab } from './ingress/types';

export default function IngressManagement() {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>('sources');
  const [outcome, setOutcome] = useState('');
  const [sourcesCreateTrigger, setSourcesCreateTrigger] = useState(0);
  const [deliveriesRefreshCount, setDeliveriesRefreshCount] = useState(0);

  const TABS: { id: Tab; label: string }[] = [
    { id: 'sources',    label: t('ingress_mgmt.tab_sources') },
    { id: 'deliveries', label: t('ingress_mgmt.tab_deliveries') },
  ];

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header with Tabs & Actions */}
      <div className="px-4 h-[60px] border-b border-border bg-white/[0.03] flex justify-between items-center shrink-0 gap-4">
        <div className="flex h-full items-center gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`h-full px-4 flex items-center border-b-2 font-mono text-xs uppercase tracking-wider transition-all font-bold
                ${tab === t.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {tab === 'sources' && (
            <button
              onClick={() => setSourcesCreateTrigger(c => c + 1)}
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
            >
              {t('ingress_mgmt.btn_new_source') || '+ New Source'}
            </button>
          )}
          {tab === 'deliveries' && (
            <div className="flex items-center gap-2">
              <select
                value={outcome}
                onChange={e => setOutcome(e.target.value)}
                className="bg-bg-primary border border-border rounded-md px-2 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent transition-colors font-mono"
              >
                {OUTCOMES.map(o => (
                  <option key={o} value={o}>
                    {o ? t(`ingress_mgmt.outcome_${o}`) : t('ingress_mgmt.outcome_all')}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setDeliveriesRefreshCount(c => c + 1)}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
              >
                {t('ingress_mgmt.btn_refresh') || 'Refresh'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {tab === 'sources'    && <SourcesTab createTrigger={sourcesCreateTrigger} />}
        {tab === 'deliveries' && <DeliveriesTab outcome={outcome} refreshTrigger={deliveriesRefreshCount} />}
      </div>
    </div>
  );
}
