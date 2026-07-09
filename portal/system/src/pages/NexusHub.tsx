import { useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import NexusStreamCatalog from './NexusStreamCatalog';
import NexusManagement from './NexusManagement';
import EventManagement from './EventManagement';
import AutomationControl from './automation';
import { useLang } from '../providers/LanguageProvider';

/**
 * NexusHub — single home for the `nexus` service surface.
 *
 * Event Bus, Sentinels and Automation Control were three separate top-level
 * nav entries, yet they are all the SAME backend service (`nexus.*`). Splitting
 * one service across three menu rows hid the actual logic. This hub folds them
 * under one section with sub-tabs so the flow reads top-to-bottom:
 *
 *     events flow on the bus  →  Sentinels subscribe & react (AI)  →  Control runs the plane
 *
 * Pure navigation merge — each sub-view is the existing page component rendered
 * unchanged. Sub-routes (/nexus/sentinels|events|control) keep deep-linking;
 * Dashboard redirects the legacy /events and /automation paths here.
 */
export default function NexusHub() {
  const { t } = useLang();
  const location = useLocation();
  const navigate = useNavigate();

  const [streamsRefreshCount, setStreamsRefreshCount] = useState(0);
  const [controlRefreshCount, setControlRefreshCount] = useState(0);
  const [sentinelsCreateTrigger, setSentinelsCreateTrigger] = useState(0);

  const tabs = [
    { id: 'streams',   path: '/nexus/streams',   label: t('nexusHub.tab_streams') || 'Streams' },
    { id: 'sentinels', path: '/nexus/sentinels', label: t('nexusHub.tab_sentinels') || 'Sentinels' },
    { id: 'events',    path: '/nexus/events',    label: t('nexusHub.tab_events') || 'Event Bus' },
    { id: 'control',   path: '/nexus/control',   label: t('nexusHub.tab_control') || 'Control' },
  ];
  const active = tabs.find(tb => location.pathname.startsWith(tb.path))?.id || 'streams';

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Header with Tabs & Dynamic Actions */}
      <div className="px-4 h-[60px] border-b border-border bg-white/[0.03] flex justify-between items-center shrink-0 gap-4">
        <div className="flex h-full items-center gap-1">
          {tabs.map(tb => (
            <button
              key={tb.id}
              onClick={() => navigate(tb.path)}
              className={`h-full px-4 flex items-center border-b-2 font-mono text-xs uppercase tracking-wider transition-all font-bold
                ${active === tb.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            {active === 'streams' && (
              <button
                onClick={() => setStreamsRefreshCount(c => c + 1)}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
              >
                {t('nexus_catalog.refresh') || 'Refresh'}
              </button>
            )}
            {active === 'sentinels' && (
              <button
                onClick={() => setSentinelsCreateTrigger(c => c + 1)}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
              >
                {t('nexus_mgmt.new_sentinel') || 'New Sentinel'}
              </button>
            )}
            {active === 'control' && (
              <button
                onClick={() => setControlRefreshCount(c => c + 1)}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
              >
                ↻ {t('automation.refresh') || 'Refresh'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Active sub-view — same flex-1 container Dashboard used to give each page */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Routes>
          <Route path="streams" element={<NexusStreamCatalog refreshTrigger={streamsRefreshCount} />} />
          <Route path="sentinels" element={<NexusManagement createTrigger={sentinelsCreateTrigger} />} />
          <Route path="events" element={<EventManagement />} />
          <Route path="control" element={<AutomationControl refreshTrigger={controlRefreshCount} />} />
          <Route index element={<Navigate to="/nexus/streams" replace />} />
          <Route path="*" element={<Navigate to="/nexus/streams" replace />} />
        </Routes>
      </div>
    </div>
  );
}
