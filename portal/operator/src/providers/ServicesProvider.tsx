import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { callRpc } from '../utils/rpc';
import { getCurrentRouterUrl } from '../utils/routerManager';
import { getSession } from '../utils/auth';

export interface EntityField {
  type: string;
  description?: string;
  required?: boolean;
}

export interface EntityDefinition {
  description?: string;
  softDelete?: boolean;
  fields: Record<string, EntityField>;
}

export interface Service {
  id: string;
  url: string;
  status: string;
  available: boolean;
  version?: string;
  entities?: Record<string, EntityDefinition>;
  methods?: any[];
}

interface ServicesContextType {
  services: Service[];
  loading: boolean;
  error: string | null;
  refreshServices: () => Promise<void>;
}

const ServicesContext = createContext<ServicesContextType | undefined>(undefined);

export const ServicesProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const [lastFetchKey, setLastFetchKey] = useState('');

  const fetchServices = async () => {
    const token = getSession();
    if (!token) {
        setLoading(false);
        setServices([]);
        return;
    }

    try {
      setLoading(true);
      const list = await callRpc<Service[]>('system.service.list');
      setServices(list);
      setError(null);
      setLastFetchKey(`${getCurrentRouterUrl()}_${token.substring(0, 10)}`);
    } catch (err: any) {
      console.error('Failed to fetch services:', err);
      setError(err.message);
      // Don't clear services on error if we already have some, 
      // but if it's an auth error we might want to.
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch when location changes (e.g. after login) or router URL changes
  useEffect(() => {
    const currentUrl = getCurrentRouterUrl();
    const token = getSession();
    const currentKey = `${currentUrl}_${token?.substring(0, 10) || 'none'}`;

    if (currentKey !== lastFetchKey) {
      fetchServices();
    }
  }, [location.pathname, lastFetchKey]);

  return (
    <ServicesContext.Provider value={{ services, loading, error, refreshServices: fetchServices }}>
      {children}
    </ServicesContext.Provider>
  );
};

export const useServices = () => {
  const context = useContext(ServicesContext);
  if (context === undefined) {
    throw new Error('useServices must be used within a ServicesProvider');
  }
  return context;
};
