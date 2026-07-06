import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { callRpc } from '../utils/rpc';
import { getSession } from '../utils/auth';
import { getCurrentRouterUrl } from '../utils/routerManager';
import { STATIC_BASE } from '../displayConfig/base';
import { mergeManifest } from '../displayConfig/resolve';
import type { EntityDisplay } from '../displayConfig/types';

interface DisplayConfigContextType {
  /** Resolved manifest for a `${service}_${entity}` scope = static base ← administrator override. */
  getManifest: (scope: string) => EntityDisplay | null;
  /** The administrator override layer alone (for the config editor). */
  overrides: Record<string, EntityDisplay>;
  refresh: () => Promise<void>;
  loading: boolean;
}

const DisplayConfigContext = createContext<DisplayConfigContextType | null>(null);

export const DisplayConfigProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [overrides, setOverrides] = useState<Record<string, EntityDisplay>>({});
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const [lastKey, setLastKey] = useState('');
  const inFlight = useRef(false);

  const fetchAll = useCallback(async () => {
    const token = getSession();
    if (!token) { setLoading(false); setOverrides({}); return; }
    if (inFlight.current) return;   // coalesce overlapping triggers (focus + visibilitychange)
    inFlight.current = true;
    try {
      setLoading(true);
      const res = await callRpc<{ items: { scope: string; manifest: EntityDisplay }[] }>('setting.display.list');
      const map: Record<string, EntityDisplay> = {};
      for (const it of (res?.items || [])) {
        if (it && it.scope && it.manifest) map[it.scope] = it.manifest;
      }
      setOverrides(map);
      setLastKey(`${getCurrentRouterUrl()}_${token.substring(0, 10)}`);
    } catch (e) {
      // Resilience (Display Protocol §6): on fetch failure keep the static base only.
      console.warn('display config fetch failed; falling back to static base', e);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  // Re-fetch after login / router change, mirroring ServicesProvider.
  useEffect(() => {
    const key = `${getCurrentRouterUrl()}_${getSession()?.substring(0, 10) || 'none'}`;
    if (key !== lastKey) fetchAll();
  }, [location.pathname, lastKey, fetchAll]);

  // Pick up administrator-side edits (made in the system console) without a full reload: when the
  // operator tab regains visibility/focus, re-pull the manifest list. Display config is
  // deployment-level and changes rarely, so focus-refetch is sufficient — no realtime push channel.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && getSession()) fetchAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [fetchAll]);

  const getManifest = useCallback((scope: string): EntityDisplay | null => {
    return mergeManifest(STATIC_BASE[scope] || null, overrides[scope] || null);
  }, [overrides]);

  return (
    <DisplayConfigContext.Provider value={{ getManifest, overrides, refresh: fetchAll, loading }}>
      {children}
    </DisplayConfigContext.Provider>
  );
};

export const useDisplayConfig = () => {
  const ctx = useContext(DisplayConfigContext);
  if (!ctx) throw new Error('useDisplayConfig must be used within DisplayConfigProvider');
  return ctx;
};
