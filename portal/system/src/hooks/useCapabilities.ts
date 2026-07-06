import { useState, useCallback } from 'react';
import { callRpc } from '../utils/rpc';

export interface Capability {
  method: string;
  service: string;
  params: { name: string; type: string; optional?: boolean }[];
  returns?: string[];
}

export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchCapabilities = useCallback(async () => {
    if (capabilities.length > 0) return;
    setLoading(true);
    try {
      const capsMap = await callRpc<Record<string, any>>('system.capability.list');
      const capsArray = Object.entries(capsMap || {}).map(([method, details]) => ({
        method,
        service: details.service,
        params: details.params || [],
        returns: details.returns || []
      }));
      setCapabilities(capsArray);
    } catch (e) {
      console.error('Failed to fetch capabilities:', e);
    } finally {
      setLoading(false);
    }
  }, [capabilities.length]);

  const getServiceList = useCallback(() => {
    const services = new Set<string>();
    capabilities.forEach(cap => services.add(cap.service));
    return Array.from(services).sort();
  }, [capabilities]);

  const getMethodsForService = useCallback((service: string) => {
    return capabilities.filter(cap => cap.service === service);
  }, [capabilities]);

  const getMethodParams = useCallback((methodName: string) => {
    const cap = capabilities.find(c => c.method === methodName);
    return cap?.params || [];
  }, [capabilities]);

  const getMethodReturns = useCallback((methodName: string) => {
    const cap = capabilities.find(c => c.method === methodName);
    return cap?.returns || [];
  }, [capabilities]);

  const fetchCategoryKeys = useCallback(async () => {
    try {
      // system.category.list returns [{ key, owner, ... }]
      return await callRpc<{key: string, owner: string, desc?: string}[]>('system.category.list');
    } catch (e) {
      console.error('Failed to fetch category keys:', e);
      return [];
    }
  }, []);

  const fetchCategoryItems = useCallback(async (owner: string, key: string) => {
    try {
      // {owner}.category.get returns { items: [...] }
      const res = await callRpc<{items: {id: string, label: any}[]}>(`${owner}.category.get`, { key });
      return res.items || [];
    } catch (e) {
      console.error(`Failed to fetch items for category ${key}:`, e);
      return [];
    }
  }, []);

  return {
    capabilities,
    loading,
    fetchCapabilities,
    getServiceList,
    getMethodsForService,
    getMethodParams,
    getMethodReturns,
    fetchCategoryKeys,
    fetchCategoryItems
  };
}
