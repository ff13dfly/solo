import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';
import { useLang } from '../providers/LanguageProvider';
import { StatsCards } from '../components/overview/StatsCards';
import { PublicMethods } from '../components/overview/PublicMethods';
import { ServiceCapabilities } from '../components/overview/ServiceCapabilities';
import { AutomationPanel } from '../components/overview/AutomationPanel';

import { useSystemStats } from '../hooks/useSystemStats';
import { useServiceDiscovery } from '../hooks/useServiceDiscovery';

export default function Overview() {
  const { t } = useLang();
  const {
    stats, userStats, loading: statsLoading
  } = useSystemStats();

  const {
    services: servicesList,
    capabilities,
    systemMethods,
    servicePublicMethods,
    loading: discoveryLoading,
    updateServiceStatus
  } = useServiceDiscovery();

  const [activeTab, setActiveTab] = useState<string>('');
  const [isChecking, setIsChecking] = useState(false);
  const [activeEntityPopover, setActiveEntityPopover] = useState<string | null>(null);
  const [serviceEvents, setServiceEvents] = useState<{ emits: any[]; subscribes: any[] } | null>(null);

  const loading = statsLoading || discoveryLoading;

  useEffect(() => {
    if (servicesList.length > 0 && !activeTab) {
      setActiveTab(servicesList[0].id);
    }
  }, [servicesList, activeTab, loading]); // Added loading dependency simply to ensure re-eval

  useEffect(() => {
    if (activeTab && activeTab !== 'all') {
      setIsChecking(true);
      setServiceEvents(null);
      callRpc('system.service.status', { serviceId: activeTab })
        .then((res: any) => {
          if (res && res.status) {
            updateServiceStatus(activeTab, res);
            if (res.events) setServiceEvents(res.events);
          }
        })
        .catch(console.error)
        .finally(() => {
          setTimeout(() => setIsChecking(false), 300);
        });
    }
  }, [activeTab]);

  const uniqueServices = Array.from(new Set(capabilities.map(c => c.service))).sort();

  // Improvement: Use the service's own methods array if available, 
  // otherwise fallback to filtering the global capabilities map.
  // This ensures common methods like 'ping' show up for every service.
  const activeServiceDetails = servicesList.find(s => s.id === activeTab);

  const displayedCaps = (activeServiceDetails?.methods && activeServiceDetails.methods.length > 0)
    ? activeServiceDetails.methods.map(m => ({
      method: m.name || m,
      service: activeTab,
      description: m.description || '',
      params: m.params || [],
      returns: m.returns || [],
      ai: !!m.ai,
      limit: m.limit
    }))
    : capabilities.filter(c => c.service === activeTab);

  return (
    <div className="h-full overflow-y-auto p-4" onClick={() => setActiveEntityPopover(null)}>
      <div className="max-w-[1920px] mx-auto grid grid-cols-1 xl:grid-cols-4 gap-4 items-start">
        {/* Main Content (3 cols on large screens) */}
        <div className="xl:col-span-3 flex flex-col gap-3 min-w-0 w-full">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <PublicMethods systemMethods={systemMethods} serviceMethods={servicePublicMethods} />
            <AutomationPanel />
          </div>
          <ServiceCapabilities
            loading={loading}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            uniqueServices={uniqueServices}
            activeServiceDetails={activeServiceDetails}
            capabilities={capabilities}
            displayedCaps={displayedCaps}
            activeEntityPopover={activeEntityPopover}
            setActiveEntityPopover={setActiveEntityPopover}
            isChecking={isChecking}
            serviceEvents={serviceEvents}
            t={t}
          />
        </div>

        {/* Sidebar (1 col on large screens) */}
        <div className="xl:col-span-1 w-full xl:min-w-[280px]">
          <div className="sticky top-4">
            <StatsCards stats={stats} userStats={userStats} loading={loading} t={t} />
          </div>
        </div>
      </div>
    </div>
  );
}
