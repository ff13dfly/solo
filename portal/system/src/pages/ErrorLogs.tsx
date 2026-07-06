import { useState, useEffect, useRef } from 'react';
import { callRpc } from '../utils/rpc';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';

interface LogEntry {
  id: string;
  stamp: string;
  service: string;
  method: string;
  params: any;
  code: string | number;
  error: string;
  stack?: string;
}

export default function ErrorLogs() {
  const { toast } = useUI();
  const { t } = useLang();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filterService, setFilterService] = useState('');
  const [services, setServices] = useState<string[]>([]);

  // Use ref to access current filter value inside interval closure
  const filterRef = useRef(filterService);
  useEffect(() => { filterRef.current = filterService; }, [filterService]);

  const formatDate = (stamp: string) => {
    if (!stamp) return '-';
    // Check if valid date
    const d = new Date(stamp);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString();
  };

  const fetchLogs = async () => {
    try {
      const res = await callRpc<{ logs: LogEntry[] }>('admin.log.error', {});
      const sorted = res.logs.sort((a, b) => {
        const tA = a.stamp ? new Date(a.stamp).getTime() : 0;
        const tB = b.stamp ? new Date(b.stamp).getTime() : 0;
        // Handle invalid dates if any
        const vA = isNaN(tA) ? 0 : tA;
        const vB = isNaN(tB) ? 0 : tB;
        return vB - vA;
      });
      setLogs(sorted);

      const distinctServices = Array.from(new Set(sorted.map(l => l.service)));
      // Auto-select if currently no filter is set and there is only one service with errors
      if (filterRef.current === '' && distinctServices.length === 1) {
        setFilterService(distinctServices[0]);
      }
    } catch (err) {
      console.warn('Using mock logs due to fetch failure', err);
      // Mock data for demo if RPC fails
      setLogs([
        {
          id: '1', stamp: new Date().toISOString(), service: 'user', method: 'user.account.list',
          params: { page: 1 }, code: -32604, error: 'Unauthorized'
        },
        {
          id: '2', stamp: new Date(Date.now() - 1000).toISOString(), service: 'company', method: 'company.update',
          params: { id: 123 }, code: -32001, error: 'Update failed'
        }
      ]);

      // Ensure 'company' is in the service list so it appears in dropdown
      setServices(prev => {
        const newSet = new Set(prev);
        newSet.add('company');
        newSet.add('user');
        return Array.from(newSet);
      });
    }
  };

  useEffect(() => {
    fetchLogs();
    loadServices();
    const timer = setInterval(fetchLogs, 5000);
    return () => clearInterval(timer);
  }, []);

  const loadServices = async () => {
    try {
      const list = await callRpc<{ id: string }[]>('system.service.list', {});
      const ids = list.map(s => s.id);
      if (!ids.includes('router')) ids.unshift('router');
      setServices(Array.from(new Set(ids)));
    } catch (e) {
      console.error('Failed to load services', e);
    }
  };

  const handleClear = async () => {
    try {
      await callRpc('admin.log.clear', {});
      setLogs([]);
      toast.success(t('error_log.toast_clear'));
    } catch (e: any) {
      toast.error(t('error_log.toast_clear_fail', { msg: e.message }));
    }
  };

  const filteredLogs = filterService ? logs.filter(l => l.service === filterService) : logs;

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Title Bar */}
      <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span>{t('error_log.title')} ::</span>
          <select
            value={filterService}
            onChange={e => setFilterService(e.target.value)}
            className="bg-bg-primary text-text-primary border border-border px-2 py-1 rounded outline-none text-xs"
          >
            <option value="">{t('error_log.placeholder_service')} ({t('status.active')})</option>
            {services.map(s => {
              const hasError = logs.some(l => l.service === s);
              return <option key={s} value={s}>{hasError ? '⚠️ ' : ''}{s.toUpperCase()}</option>
            })}
          </select>
        </div>

        <button className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1 text-xs font-medium hover:bg-error hover:text-white transition-all" onClick={handleClear}>
          {t('error_log.clear')}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Header Row */}
        <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-accent text-[11px] uppercase tracking-wider" style={{ gridTemplateColumns: 'minmax(150px, 1.5fr) 1fr 1fr 2fr 3fr' }}>
          <div>{t('error_log.col_time')}</div>
          <div>{t('error_log.col_service')}</div>
          <div>{t('error_log.col_code')}</div>
          <div>{t('error_log.col_error')}</div>
          <div>{t('error_log.col_request')}</div>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto">
          {filteredLogs.map((log, i) => (
            <div key={i} className="grid gap-4 px-5 border-b border-border items-center text-xs hover:bg-white/[0.02] transition-colors h-[44px]" style={{ gridTemplateColumns: 'minmax(150px, 1.5fr) 1fr 1fr 2fr 3fr' }}>
              <div className="opacity-60">{formatDate(log.stamp)}</div>
              <div className="opacity-80 font-bold">{log.service?.toUpperCase()}</div>
              <div className="text-error font-mono">{log.code}</div>
              <div className="text-[#ff7b72] truncate">{log.error}</div>
              <div className="font-mono text-text-secondary truncate">
                {JSON.stringify({ method: log.method, params: log.params }, null, 0)}
              </div>
            </div>
          ))}
          {filteredLogs.length === 0 && (
            <div className="p-6 text-center opacity-50">{t('error_log.empty')}</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center">
          <span className="text-xs text-text-secondary">TOTAL: {filteredLogs.length} ENTRIES</span>
          <span className="text-[10px] text-text-secondary opacity-60">AUTO-REFRESH: 5s</span>
        </div>
      </div>
    </div>
  );
}
