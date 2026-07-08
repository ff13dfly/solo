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

  const tabs = [
    { id: 'streams',   path: '/nexus/streams',   label: t('nexusHub.tab_streams') || 'Streams' },
    { id: 'sentinels', path: '/nexus/sentinels', label: t('nexusHub.tab_sentinels') || 'Sentinels' },
    { id: 'events',    path: '/nexus/events',    label: t('nexusHub.tab_events') || 'Event Bus' },
    { id: 'control',   path: '/nexus/control',   label: t('nexusHub.tab_control') || 'Control' },
  ];
  const active = tabs.find(tb => location.pathname.startsWith(tb.path))?.id || 'streams';

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar + the one-line mental model */}
      <div className="border-b border-border bg-bg-primary shrink-0">
        <div className="flex items-center gap-1 px-4 pt-3">
          {tabs.map(tb => (
            <button
              key={tb.id}
              onClick={() => navigate(tb.path)}
              className={`font-mono text-xs uppercase tracking-wide px-4 py-2 border-b-2 transition-all
                ${active === tb.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <div className="px-5 pb-2 pt-1 text-[10px] text-text-secondary tracking-wide">
          {t('nexusHub.subtitle_flow') ||
            'Events flow on the bus → Sentinels subscribe & react (AI) → Control runs the plane'}
        </div>
      </div>

      {/* Active sub-view — same flex-1 container Dashboard used to give each page */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Routes>
          <Route path="streams" element={<NexusStreamCatalog />} />
          <Route path="sentinels" element={<NexusManagement />} />
          <Route path="events" element={<EventManagement />} />
          <Route path="control" element={<AutomationControl />} />
          <Route index element={<Navigate to="/nexus/streams" replace />} />
          <Route path="*" element={<Navigate to="/nexus/streams" replace />} />
        </Routes>
      </div>
    </div>
  );
}
