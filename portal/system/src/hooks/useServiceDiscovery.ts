import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';

export interface Service {
  id: string;
  url: string;
  status: string;
  available: boolean;
  version?: string;
  entities?: Record<string, any>;
  methods?: any[];
}

export interface Capability {
  method: string;
  service: string;
  description: string;
  params: any[];
  returns?: string[];
  ai?: boolean;
  limit?: { window: number; max: number; by: 'user' | 'ip' };
}

export function useServiceDiscovery() {
  const [services, setServices] = useState<Service[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [systemMethods, setSystemMethods] = useState<string[]>([]);
  const [servicePublicMethods, setServicePublicMethods] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      // 1. Fetch Services
      const servicesList = await callRpc<Service[]>('system.service.list');
      setServices(servicesList);

      // 2. Fetch Capabilities (All)
      const capsMap = await callRpc<Record<string, any>>('system.capability.list', { all: true });

      const capsArray = Object.entries(capsMap || {}).map(([method, details]) => ({
        method,
        service: details.service,
        description: details.desc || details.description || '',
        params: details.params || [],
        returns: details.returns || [],
        ai: details.ai,
        limit: details.limit
      }));
      setCapabilities(capsArray);

      // 3. Categorize Methods
      const internal: string[] = [];
      const external: string[] = [];

      Object.entries(capsMap || {}).forEach(([method, details]) => {
        if (details.internal) {
          internal.push(method);
        } else if (details.public) {
          external.push(method);
        }
      });

      setSystemMethods(internal.sort());
      setServicePublicMethods(external.sort());
    } catch (err) {
      console.error('Failed to fetch service discovery data:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateServiceStatus = (serviceId: string, statusData: any) => {
    setServices(prev => prev.map(s => {
      if (s.id === serviceId) {
        return {
          ...s,
          available: statusData.status === 'online',
          entities: statusData.entities || s.entities,
          methods: statusData.methods || s.methods
        };
      }
      return s;
    }));
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  return {
    services,
    capabilities,
    systemMethods,
    servicePublicMethods,
    loading,
    refresh: fetchData,
    updateServiceStatus
  };
}
