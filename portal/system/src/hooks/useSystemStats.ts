import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';

export function useSystemStats() {
  const [stats, setStats] = useState({
    total: 0,
    online: 0,
    offline: 0,
    configured: 0,
    errorCount: 0,
    workflowCount: 0
  });
  const [userStats, setUserStats] = useState({ active: 0, total: 0 });
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    try {
      // 1. General Service Stats
      const services = await callRpc<any[]>('system.service.list');

      // 2. Error Stats
      let errorCount = 0;
      try {
        const errorRes = await callRpc<{ logs: any[] }>('admin.log.error');
        errorCount = errorRes?.logs?.length || 0;
      } catch (e) {
        console.warn('Failed to fetch error logs count', e);
      }

      // 3. Workflow Stats
      let workflowCount = 0;
      try {
        const workflows = await callRpc<any[]>('system.workflow.list');
        workflowCount = Array.isArray(workflows) ? workflows.length : 0;
      } catch (e) {
        console.warn('Failed to fetch workflow count', e);
      }

      if (Array.isArray(services)) {
        setStats({
          total: services.length,
          online: services.filter(s => s.status === 'online' || s.available).length,
          offline: services.filter(s => s.status === 'offline' && !s.available).length,
          configured: services.filter(s => s.status === 'configured').length,
          errorCount,
          workflowCount
        });
      }

      // 2. User Stats
      const userStatus = await callRpc<{ active: number, total: number }>('user.account.status');
      if (userStatus && userStatus.total !== undefined) {
        setUserStats({ active: userStatus.active, total: userStatus.total });
      }
    } catch (e) {
      console.warn('Failed to fetch system stats', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  return { stats, userStats, loading, refresh: fetchStats };
}
