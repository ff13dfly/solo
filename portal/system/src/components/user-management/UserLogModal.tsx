import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';

interface UserLogModalProps {
  userId: string;
  userName: string;
  onClose: () => void;
}

interface LogRecord {
  prompts: string;
  method: string;
  stamp: number;
  answer: any;
  status: string;
}

export default function UserLogModal({ userId, userName, onClose }: UserLogModalProps) {
  const { toast } = useUI();
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());

  const getMonthStr = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}${m}`;
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const month = getMonthStr(currentDate);
      const result = await callRpc<LogRecord[]>('system.log.interaction', {
        userId,
        month,
        limit: 100
      });
      const sorted = (result || []).sort((a, b) => new Date(b.stamp).getTime() - new Date(a.stamp).getTime());
      setLogs(sorted);
    } catch (err: any) {
      toast.error('Failed to load logs: ' + err.message);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [currentDate, userId]);

  const handlePrevMonth = () => {
    const newDate = new Date(currentDate);
    newDate.setMonth(newDate.getMonth() - 1);
    setCurrentDate(newDate);
  };

  const handleNextMonth = () => {
    const newDate = new Date(currentDate);
    newDate.setMonth(newDate.getMonth() + 1);
    setCurrentDate(newDate);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-bg-secondary rounded-lg p-6 w-[800px] h-[600px] flex flex-col shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
      >
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="m-0 text-base">Interaction Logs: {userName}</h3>
            <div className="text-[11px] opacity-60">ID: {userId}</div>
          </div>

          <div className="flex items-center gap-4">
            {/* Month Switcher */}
            <div className="flex items-center bg-black/20 rounded">
              <button
                onClick={handlePrevMonth}
                className="border-none bg-transparent p-1 px-2 cursor-pointer text-inherit text-xs hover:bg-white/10 rounded transition-colors"
              >
                ◀
              </button>
              <span className="px-2 text-[13px] font-semibold min-w-[80px] text-center">
                {getMonthStr(currentDate)}
              </span>
              <button
                onClick={handleNextMonth}
                className="border-none bg-transparent p-1 px-2 cursor-pointer text-inherit text-xs hover:bg-white/10 rounded transition-colors"
              >
                ▶
              </button>
            </div>

            <button
              onClick={onClose}
              className="bg-transparent border-none cursor-pointer text-lg opacity-60 hover:opacity-100 transition-opacity"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-black/10 rounded p-3">
          {loading ? (
            <div className="p-5 text-center opacity-60">Loading...</div>
          ) : logs.length === 0 ? (
            <div className="p-10 text-center opacity-40">No logs found for this month</div>
          ) : (
            <div className="flex flex-col gap-3">
              {logs.map((log, i) => (
                <div key={i} className={`bg-bg-primary rounded-md p-3 border-l-[3px] ${log.status === 'FALLBACK' ? 'border-l-error' : 'border-l-success'
                  }`}>
                  <div className="flex justify-between mb-2 text-[11px] opacity-70">
                    <span className="font-mono">{log.method}</span>
                    <span>{new Date(log.stamp).toLocaleString()}</span>
                  </div>

                  <div className="mb-2">
                    <div className="text-[10px] opacity-50 mb-0.5">PROMPT</div>
                    <div className="text-[13px] whitespace-pre-wrap">{log.prompts}</div>
                  </div>

                  <div>
                    <div className="text-[10px] opacity-50 mb-0.5">ANSWER</div>
                    <div className="text-xs font-mono bg-black/20 p-2 rounded whitespace-pre-wrap max-h-[100px] overflow-y-auto">
                      {typeof log.answer === 'object' ? JSON.stringify(log.answer, null, 2) : String(log.answer)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
