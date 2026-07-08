import { useState } from 'react';
import { useLang } from '../providers/LanguageProvider';
import SchedulesTab from './events/SchedulesTab';
import RunsTab from './events/RunsTab';
import StreamTab from './events/StreamTab';
import FormatTab from './events/FormatTab';
import type { Tab } from './events/types';

export default function EventManagement() {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>('runs');

  const TABS: { id: Tab; label: string }[] = [
    { id: 'schedules', label: t('event_mgmt.tab_schedules') },
    { id: 'runs',      label: t('event_mgmt.tab_runs') },
    { id: 'stream',    label: t('event_mgmt.tab_stream') },
    { id: 'format',    label: t('event_mgmt.tab_format') },
  ];

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex items-center shrink-0">
        <span>{t('event_mgmt.header')}</span>
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
        {tab === 'schedules' && <SchedulesTab />}
        {tab === 'runs'      && <RunsTab />}
        {tab === 'stream'    && <StreamTab />}
        {tab === 'format'    && <FormatTab />}
      </div>
    </div>
  );
}
