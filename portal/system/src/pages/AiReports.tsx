import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';

// system.report 收集的 AI 需求/缺口工单（router/handlers/report.js）。
// triage 纪律见 docs/feedback/README.md：这里标状态，有价值的沉淀成 markdown。
interface AiReport {
  id: string;
  type: string;
  method: string | null;
  message: string;
  context: any;
  count: number;
  status: 'NEW' | 'REVIEWED' | 'RESOLVED';
  createdAt: string;
  lastSeenAt: string;
}

const TYPES = ['missing_capability', 'bad_returns', 'unclear_description', 'chain_failure', 'other'];
const STATUSES = ['NEW', 'REVIEWED', 'RESOLVED'];

const typeBadge = (type: string) => {
  const base = 'text-[10px] px-1.5 py-0.5 border rounded font-mono';
  switch (type) {
    case 'missing_capability': return `${base} border-error/40 text-error bg-error/10`;
    case 'chain_failure':      return `${base} border-warning/40 text-warning bg-warning/10`;
    case 'bad_returns':        return `${base} border-accent/40 text-accent bg-accent/10`;
    default:                   return `${base} border-border text-text-secondary bg-white/[0.03]`;
  }
};

const statusBadge = (status: string) => {
  const base = 'text-[10px] px-1.5 py-0.5 border rounded font-mono';
  switch (status) {
    case 'NEW':      return `${base} border-error/40 text-error bg-error/10`;
    case 'REVIEWED': return `${base} border-warning/40 text-warning bg-warning/10`;
    case 'RESOLVED': return `${base} border-success/40 text-success bg-success/10`;
    default:         return `${base} border-border text-text-secondary`;
  }
};

export default function AiReports() {
  const { toast } = useUI();
  const { t } = useLang();
  const [items, setItems] = useState<AiReport[]>([]);
  const [total, setTotal] = useState(0);
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('NEW');
  const [expanded, setExpanded] = useState<string | null>(null);

  const formatDate = (stamp: string) => {
    if (!stamp) return '-';
    const d = new Date(stamp);
    return isNaN(d.getTime()) ? '-' : d.toLocaleString();
  };

  const fetchReports = async (type: string, status: string) => {
    try {
      const res = await callRpc<{ items: AiReport[]; total: number }>('system.report.list', {
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        page: 1,
        pageSize: 200,
      });
      // count 高的上浮（多少任务撞过同一堵墙 = 优先级信号），同 count 按最近活跃
      const sorted = [...res.items].sort((a, b) =>
        (b.count - a.count) || (new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()));
      setItems(sorted);
      setTotal(res.total);
    } catch (e: any) {
      toast.error(t('ai_reports.toast_fetch_fail') + ': ' + e.message);
    }
  };

  useEffect(() => {
    fetchReports(filterType, filterStatus);
  }, [filterType, filterStatus]);

  const setStatus = async (report: AiReport, status: string) => {
    try {
      await callRpc('system.report.update', { reportId: report.id, status });
      toast.success(`${report.id} → ${status}`);
      fetchReports(filterType, filterStatus);
    } catch (e: any) {
      toast.error(t('ai_reports.toast_update_fail') + ': ' + e.message);
    }
  };

  const GRID = 'minmax(140px, 1fr) 110px 1.2fr 3fr 60px 90px 150px';

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Title Bar */}
      <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span>{t('ai_reports.title')} ::</span>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="bg-bg-primary text-text-primary border border-border px-2 py-1 rounded outline-none text-xs"
          >
            <option value="">{t('ai_reports.all_statuses')}</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="bg-bg-primary text-text-primary border border-border px-2 py-1 rounded outline-none text-xs"
          >
            <option value="">{t('ai_reports.all_types')}</option>
            {TYPES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <span className="text-[10px] text-text-secondary opacity-60 font-normal">system.report → triage: docs/feedback/README.md</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Header Row */}
        <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-accent text-[11px] uppercase tracking-wider" style={{ gridTemplateColumns: GRID }}>
          <div>{t('ai_reports.col_time')}</div>
          <div>{t('ai_reports.col_type')}</div>
          <div>{t('ai_reports.col_method')}</div>
          <div>{t('ai_reports.col_message')}</div>
          <div>{t('ai_reports.col_count')}</div>
          <div>{t('ai_reports.col_status')}</div>
          <div>{t('ai_reports.col_actions')}</div>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto">
          {items.map(r => (
            <div key={r.id} className="border-b border-border hover:bg-white/[0.02] transition-colors">
              <div
                className="grid gap-4 px-5 items-center text-xs h-[44px] cursor-pointer"
                style={{ gridTemplateColumns: GRID }}
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                <div className="opacity-60">{formatDate(r.lastSeenAt)}</div>
                <div><span className={typeBadge(r.type)}>{r.type.replace('_', ' ')}</span></div>
                <div className="font-mono text-text-secondary truncate">{r.method || '-'}</div>
                <div className="truncate">{r.message}</div>
                <div className={`font-mono font-bold ${r.count > 1 ? 'text-warning' : 'opacity-60'}`}>×{r.count}</div>
                <div><span className={statusBadge(r.status)}>{r.status}</span></div>
                <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                  {r.status !== 'REVIEWED' && r.status !== 'RESOLVED' && (
                    <button
                      className="border border-warning/40 text-warning rounded px-2 py-0.5 text-[10px] hover:bg-warning hover:text-black transition-all"
                      onClick={() => setStatus(r, 'REVIEWED')}
                    >{t('ai_reports.mark_reviewed')}</button>
                  )}
                  {r.status !== 'RESOLVED' && (
                    <button
                      className="border border-success/40 text-success rounded px-2 py-0.5 text-[10px] hover:bg-success hover:text-black transition-all"
                      onClick={() => setStatus(r, 'RESOLVED')}
                    >{t('ai_reports.mark_resolved')}</button>
                  )}
                </div>
              </div>
              {expanded === r.id && (
                <div className="px-5 pb-3 text-xs space-y-1">
                  <div className="whitespace-pre-wrap break-words text-text-primary">{r.message}</div>
                  {r.context && (
                    <pre className="font-mono text-[10px] text-text-secondary bg-bg-secondary border border-border rounded p-2 overflow-x-auto">
                      {JSON.stringify(r.context, null, 2)}
                    </pre>
                  )}
                  <div className="text-[10px] text-text-secondary opacity-60">
                    id: {r.id} · first seen: {formatDate(r.createdAt)} · last seen: {formatDate(r.lastSeenAt)}
                  </div>
                </div>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <div className="p-6 text-center opacity-50">{t('ai_reports.empty')}</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center">
          <span className="text-xs text-text-secondary">TOTAL: {total} REPORTS</span>
          <span className="text-[10px] text-text-secondary opacity-60">{t('ai_reports.footer_hint')}</span>
        </div>
      </div>
    </div>
  );
}
