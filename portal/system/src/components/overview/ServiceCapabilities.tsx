import React from 'react';
import { CapabilityGroup } from './CapabilityGroup';
import { EntityPopover } from './EntityPopover';
import { Card } from '../ui/Card';

interface Service {
  id: string;
  url: string;
  available: boolean;
  version?: string;
  entities?: Record<string, any>;
}

interface Capability {
  method: string;
  service: string;
  description: string;
  params: any[];
  returns?: string[];
  ai?: boolean;
}

interface EventEntry {
  stream: string;
  type: string;
  trigger?: string;
  description?: string;
  mechanism?: string;
  consumer?: string;
}

interface ServiceCapabilitiesProps {
  loading: boolean;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  uniqueServices: string[];
  activeServiceDetails?: Service;
  capabilities: Capability[];
  displayedCaps: Capability[];
  activeEntityPopover: string | null;
  setActiveEntityPopover: (entity: string | null) => void;
  isChecking: boolean;
  serviceEvents?: { emits: EventEntry[]; subscribes: EventEntry[] } | null;
  t: (key: string) => string;
}

// ── Events popover (absolutely positioned, no layout shift) ──────────────────
const EventsPopover: React.FC<{
  kind: 'emits' | 'subscribes';
  entries: EventEntry[];
}> = ({ kind, entries }) => {
  return (
    <div
      className="absolute top-[calc(100%+12px)] right-0 w-96 bg-bg-primary border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.5)] z-[100] p-4 flex flex-col gap-3 animate-[fadeInDown_0.2s_ease-out]"
      onClick={e => e.stopPropagation()}
    >
      <div className="absolute -top-1.5 right-5 w-2.5 h-2.5 bg-bg-primary border-l border-t border-border rotate-45" />
      <div className="text-sm font-semibold text-[#ff7b72] border-b border-[#21262d] pb-2 mb-1">
        {kind === 'emits' ? '↑ EMITS' : '↓ SUBSCRIBES'}
      </div>
      <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto">
        {entries.map((entry, i) => (
          <div
            key={i}
            className="rounded-md px-3 py-3 border border-[rgba(255,123,114,0.2)] bg-[rgba(255,123,114,0.04)]"
          >
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <span className="font-mono text-[13px] font-semibold text-[#ff7b72] break-all">{entry.stream}</span>
              {(entry.mechanism || entry.consumer) && (
                <span className="text-[11px] px-2 py-0.5 rounded bg-white/5 text-text-secondary border border-border font-mono shrink-0">
                  {entry.mechanism || entry.consumer}
                </span>
              )}
            </div>
            <div className="text-[12px] text-text-secondary mt-1.5 opacity-80">· {entry.type}</div>
            {entry.trigger && (
              <div className="mt-1.5 text-[12px] text-text-secondary">
                <span className="opacity-50">trigger: </span>{entry.trigger}
              </div>
            )}
            {entry.description && (
              <div className="mt-1 text-[11px] text-text-secondary opacity-60 leading-relaxed">{entry.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Main component ───────────────────────────────────────────────────────────
export const ServiceCapabilities: React.FC<ServiceCapabilitiesProps> = ({
  loading, activeTab, setActiveTab, uniqueServices,
  activeServiceDetails, capabilities, displayedCaps,
  activeEntityPopover, setActiveEntityPopover,
  isChecking, serviceEvents, t
}) => {
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [activeInfoTab, setActiveInfoTab] = React.useState<'entities' | 'events'>('entities');
  const [activeEventPopover, setActiveEventPopover] = React.useState<'emits' | 'subscribes' | null>(null);

  const hasEntities = !!(activeServiceDetails?.entities && Object.keys(activeServiceDetails.entities).length > 0);
  const hasEvents = !!(serviceEvents && (serviceEvents.emits.length > 0 || serviceEvents.subscribes.length > 0));

  // Reset info tab when switching service
  React.useEffect(() => {
    setActiveInfoTab(hasEntities ? 'entities' : 'events');
    setActiveEventPopover(null);
    setActiveEntityPopover(null);
  }, [activeTab]);

  // If current tab's data disappears after refresh, fall back
  React.useEffect(() => {
    if (activeInfoTab === 'entities' && !hasEntities && hasEvents) setActiveInfoTab('events');
    if (activeInfoTab === 'events' && !hasEvents && hasEntities) setActiveInfoTab('entities');
  }, [hasEntities, hasEvents]);

  const closeAll = () => {
    setActiveEventPopover(null);
    setActiveEntityPopover(null);
  };

  const groupCapabilities = () => {
    const grouped: Record<string, Capability[]> = {};
    displayedCaps.forEach((cap: Capability) => {
      const parts = cap.method.split('.');
      const prefix = parts.length >= 3 ? parts.slice(0, 2).join('.') : 'basic';
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push(cap);
    });
    return grouped;
  };

  const grouped = groupCapabilities();

  return (
    <Card
      title={
        <div className="flex items-center gap-3">
          <span className="text-xl">📦</span>
          <span>{t('overview.capabilities_title')}</span>
          <span className="px-2 py-0.5 rounded-full bg-[#d299ff]/15 text-[#d299ff] border border-[#d299ff]/40 text-[10px] font-medium tracking-wide">DYNAMICALLY LOADED</span>
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
        <div className="flex min-h-0" onClick={closeAll}>
          {/* ── Left: vertical service tab list ── */}
          <div className="flex flex-col border-r border-border bg-bg-secondary/50 overflow-y-auto" style={{ width: 160, flexShrink: 0 }}>
            {uniqueServices.map(svc => {
              const isActive = activeTab === svc;
              const count = capabilities.filter((c: Capability) => c.service === svc).length;
              return (
                <button
                  key={svc}
                  onClick={e => { e.stopPropagation(); setActiveTab(svc); }}
                  className={`
                    relative w-full text-left px-4 py-3 text-xs font-medium transition-colors outline-none border-none cursor-pointer
                    ${isActive
                      ? 'text-text-primary bg-white/5'
                      : 'text-text-secondary hover:text-text-primary hover:bg-white/5'}
                  `}
                >
                  {isActive && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
                  <div>{svc.toUpperCase()}</div>
                  <div className={`mt-0.5 text-[10px] ${isActive ? 'text-text-primary' : 'text-text-secondary'} opacity-60`}>
                    {count} methods
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Right: service detail + methods ── */}
          <div className="flex flex-col flex-1 min-w-0">
            {activeServiceDetails && (
              <div className="px-6 py-4 border-b border-border bg-bg-secondary/50">
                <div className="flex justify-between items-start flex-wrap gap-4">

                  {/* Left: service name + URL */}
                  <div>
                    <h2 className="flex items-center gap-3 text-lg font-semibold text-text-primary m-0 mb-2">
                      {activeServiceDetails.id.toUpperCase()}
                      {!isChecking && (
                        <span className={`
                          text-xs px-2 py-0.5 rounded-full font-medium border
                          ${activeServiceDetails.available
                            ? 'bg-green-500/15 text-green-500 border-green-500/40'
                            : 'bg-red-500/15 text-red-500 border-red-500/40'}
                        `}>
                          {activeServiceDetails.available ? 'ONLINE' : 'OFFLINE'}
                        </span>
                      )}
                    </h2>
                    <div className="flex gap-6 text-[13px] text-text-secondary">
                      <div className="flex items-center gap-1.5">
                        <span className="opacity-70">URL:</span>
                        <span className="font-mono text-accent">{activeServiceDetails.url || 'N/A'}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="opacity-70">VERSION:</span>
                        <span>{activeServiceDetails.version || 'unknown'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Right: ENTITIES / EVENTS tabs + pills */}
                  {(hasEntities || hasEvents) && (
                    <div className="flex flex-col items-end gap-2" onClick={e => e.stopPropagation()}>

                      {/* Tab buttons */}
                      <div className="flex gap-0 border border-border rounded-md overflow-hidden">
                        {hasEntities && (
                          <button
                            onClick={() => { setActiveInfoTab('entities'); setActiveEventPopover(null); setActiveEntityPopover(null); }}
                            className={`
                              px-3 py-1 text-[11px] font-semibold tracking-wider transition-colors outline-none border-none cursor-pointer
                              ${activeInfoTab === 'entities'
                                ? 'bg-[#79c0ff]/15 text-[#79c0ff]'
                                : 'bg-transparent text-text-secondary hover:text-text-primary hover:bg-white/5'}
                            `}
                          >
                            ENTITIES
                          </button>
                        )}
                        {hasEvents && (
                          <button
                            onClick={() => { setActiveInfoTab('events'); setActiveEntityPopover(null); setActiveEventPopover(null); }}
                            className={`
                              px-3 py-1 text-[11px] font-semibold tracking-wider transition-colors outline-none border-none cursor-pointer
                              ${hasEntities ? 'border-l border-border' : ''}
                              ${activeInfoTab === 'events'
                                ? 'bg-[#79c0ff]/15 text-[#79c0ff]'
                                : 'bg-transparent text-text-secondary hover:text-text-primary hover:bg-white/5'}
                            `}
                          >
                            EVENTS
                          </button>
                        )}
                      </div>

                      {/* Pills: both tabs always in DOM, overlapped via CSS grid — prevents height shift on switch */}
                      <div className="grid justify-items-end">
                        {/* ENTITIES pills */}
                        {hasEntities && (
                          <div className={`row-start-1 col-start-1 flex gap-2 flex-wrap justify-end ${activeInfoTab === 'entities' ? '' : 'invisible pointer-events-none'}`}>
                            {Object.entries(activeServiceDetails.entities!).map(([entityName, def]: [string, any]) => (
                              <div key={entityName} className="relative">
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    setActiveEntityPopover(activeEntityPopover === entityName ? null : entityName);
                                  }}
                                  className={`
                                    text-[11px] px-3 py-1 rounded-full font-semibold uppercase cursor-pointer transition-all outline-none border
                                    ${activeEntityPopover === entityName
                                      ? 'bg-[#ff7b72]/20 text-[#ff7b72] border-[#ff7b72]/60 shadow-[0_0_12px_rgba(255,123,114,0.3)]'
                                      : 'bg-[#ff7b72]/10 text-[#ff7b72] border-[#ff7b72]/40 hover:bg-[#ff7b72]/20'}
                                  `}
                                >
                                  {entityName}
                                </button>
                                {activeEntityPopover === entityName && def.fields && (
                                  <EntityPopover entityName={entityName} def={def} />
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* EVENTS pills */}
                        {hasEvents && serviceEvents && (
                          <div className={`row-start-1 col-start-1 flex gap-2 flex-wrap justify-end ${activeInfoTab === 'events' ? '' : 'invisible pointer-events-none'}`}>
                            {serviceEvents.emits.length > 0 && (
                              <div className="relative">
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    setActiveEventPopover(activeEventPopover === 'emits' ? null : 'emits');
                                  }}
                                  className={`
                                    text-[11px] px-3 py-1 rounded-full font-semibold uppercase cursor-pointer transition-all outline-none border flex items-center gap-1
                                    ${activeEventPopover === 'emits'
                                      ? 'bg-[#ff7b72]/20 text-[#ff7b72] border-[#ff7b72]/60 shadow-[0_0_12px_rgba(255,123,114,0.3)]'
                                      : 'bg-[#ff7b72]/10 text-[#ff7b72] border-[#ff7b72]/40 hover:bg-[#ff7b72]/20'}
                                  `}
                                >
                                  <span>↑</span>
                                  <span>{serviceEvents.emits.length} emit{serviceEvents.emits.length !== 1 ? 's' : ''}</span>
                                </button>
                                {activeEventPopover === 'emits' && (
                                  <EventsPopover kind="emits" entries={serviceEvents.emits} />
                                )}
                              </div>
                            )}
                            {serviceEvents.subscribes.length > 0 && (
                              <div className="relative">
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    setActiveEventPopover(activeEventPopover === 'subscribes' ? null : 'subscribes');
                                  }}
                                  className={`
                                    text-[11px] px-3 py-1 rounded-full font-semibold uppercase cursor-pointer transition-all outline-none border flex items-center gap-1
                                    ${activeEventPopover === 'subscribes'
                                      ? 'bg-[#ff7b72]/20 text-[#ff7b72] border-[#ff7b72]/60 shadow-[0_0_12px_rgba(255,123,114,0.3)]'
                                      : 'bg-[#ff7b72]/10 text-[#ff7b72] border-[#ff7b72]/40 hover:bg-[#ff7b72]/20'}
                                  `}
                                >
                                  <span>↓</span>
                                  <span>{serviceEvents.subscribes.length} sub{serviceEvents.subscribes.length !== 1 ? 's' : ''}</span>
                                </button>
                                {activeEventPopover === 'subscribes' && (
                                  <EventsPopover kind="subscribes" entries={serviceEvents.subscribes} />
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="p-6 bg-transparent">
              {loading ? (
                <div className="text-center py-10 text-text-secondary">LOADING...</div>
              ) : displayedCaps.length === 0 ? (
                <div className="text-center py-10 text-text-secondary">
                  {uniqueServices.length === 0 ? 'No services available' : 'Select a service to view capabilities.'}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {Object.entries(grouped)
                    .sort(([a], [b]) => {
                      if (a === 'basic') return -1;
                      if (b === 'basic') return 1;
                      return a.localeCompare(b);
                    })
                    .map(([prefix, caps]) => (
                      <CapabilityGroup
                        key={`${activeTab}-${prefix}`}
                        prefix={prefix}
                        capabilities={caps}
                        initialExpanded={prefix === 'basic'}
                      />
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
