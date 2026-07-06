import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../../providers/LanguageProvider';
import { useUI } from '../../providers/UIProvider';
import { callRpc } from '../../utils/rpc';
import { clearSession } from '../../utils/auth';
import { TabbedLayout } from '../../components/shared/TabbedLayout';
import type { TabItem } from '../../components/shared/TabbedLayout';
import type { ServiceListItem } from './types';

interface BasicPanelProps {
  services: ServiceListItem[];
  blacklistCount: number;
}

export const BasicPanel: React.FC<BasicPanelProps> = ({ services, blacklistCount }) => {
  const { t } = useLang();
  const { confirm, toast } = useUI();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');
  const [jsonContent, setJsonContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [lockCountdown, setLockCountdown] = useState<number | null>(null);
  const [locking, setLocking] = useState(false);

  // Load limits config when tab switches
  useEffect(() => {
    if (activeTab !== 'limits') return;
    setLoading(true);
    setJsonContent('');
    setMessage(null);
    callRpc<any>('setting.limit.get')
      .then(result => setJsonContent(JSON.stringify(result || {}, null, 2)))
      .catch((err: any) => {
        if (err.code === -32601) {
          setMessage({ type: 'error', text: t('settings.feature_not_supported') });
        } else {
          setMessage({ type: 'error', text: err.message });
        }
      })
      .finally(() => setLoading(false));
  }, [activeTab]);

  const handleSave = async () => {
    let parsed;
    try { parsed = JSON.parse(jsonContent); }
    catch { setMessage({ type: 'error', text: t('settings.validation_error') }); return; }
    setLoading(true);
    try {
      await callRpc('setting.limit.update', { rules: parsed });
      setMessage({ type: 'success', text: t('settings.toast_success') });
    } catch (err: any) {
      setMessage({ type: 'error', text: t('settings.toast_fail').replace('{msg}', err.message) });
    } finally {
      setLoading(false);
    }
  };

  const onlineCount = services.filter(s => s.status === 'online').length;

  useEffect(() => {
    if (lockCountdown === null) return;
    if (lockCountdown <= 0) {
      clearSession();
      navigate('/login');
      return;
    }
    const t = setTimeout(() => setLockCountdown(lockCountdown - 1), 1000);
    return () => clearTimeout(t);
  }, [lockCountdown, navigate]);

  const handleLock = async () => {
    const ok = await confirm({
      message: 'Lock administrator service AND end your session?\n\n' +
        '• administrator HTTP port will close — no one can log in.\n' +
        '• Your current session expires in 60 seconds.\n' +
        '• To unlock, run `bash deploy/admin-up.sh` in the server terminal, then log in again.',
      isDangerous: true,
    });
    if (!ok) return;
    setLocking(true);
    try {
      const res = await callRpc<{ ok: boolean; tokenExpiresIn: number }>('admin.self.lock');
      toast.success('Administrator locked. Session ending in ' + res.tokenExpiresIn + 's');
      setLockCountdown(res.tokenExpiresIn || 60);
    } catch (err: any) {
      toast.error('Lock failed: ' + (err.message || 'unknown error'));
    } finally {
      setLocking(false);
    }
  };

  const tabs: TabItem[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'limits', label: t('settings.tab_limits') },
    { id: 'security', label: 'Security' },
  ];

  return (
    <TabbedLayout
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => { setActiveTab(id); setMessage(null); }}
      headerStyle={{ padding: '0 20px', marginTop: '0' }}
    >
      <div className="p-5 flex-1 flex flex-col overflow-y-auto">
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-6">
            <div>
              <div className="font-bold text-[15px] mb-1">System Overview</div>
              <div className="text-text-secondary text-[12px]">Global system configuration and status summary.</div>
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              {[
                { label: 'Total Services', value: services.length },
                { label: 'Online', value: onlineCount, color: '#22c55e' },
                { label: 'Offline', value: services.length - onlineCount, color: services.length - onlineCount > 0 ? '#ef4444' : undefined },
                { label: 'Blacklisted Methods', value: blacklistCount },
              ].map(stat => (
                <div key={stat.label} style={{
                  padding: '10px 16px', border: '1px solid var(--border-color)', borderRadius: '6px',
                  minWidth: '100px', textAlign: 'center',
                }}>
                  <div className="font-bold" style={{ fontSize: '20px', color: stat.color || 'inherit' }}>{stat.value}</div>
                  <div className="text-text-secondary" style={{ fontSize: '11px', marginTop: '2px' }}>{stat.label}</div>
                </div>
              ))}
            </div>

            <div className="text-text-secondary text-[12px] border border-border rounded-md p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              Select a service from the left sidebar to configure its permissions, task policies, and methods individually.
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="flex flex-col gap-5">
            <div>
              <div className="font-bold text-[15px] mb-1">Just-in-time Admin Access</div>
              <div className="text-text-secondary text-[12px]">
                Close the administrator HTTP port and shorten your current session, in one step.
                Use this when you finish administrative work to remove both the login surface and
                the long-lived admin token from your environment.
              </div>
            </div>

            <div className="border border-error/40 rounded-md p-4" style={{ background: 'rgba(239,68,68,0.05)' }}>
              <div className="font-bold text-[13px] text-error mb-2">Lock & End Session</div>
              <ul className="text-[12px] text-text-secondary mb-4 list-disc pl-5 leading-relaxed">
                <li>administrator service stops listening — no one (including you) can log in.</li>
                <li>Your session token TTL drops to 60 seconds.</li>
                <li>Re-enabling admin login requires running <code className="bg-black/30 px-1 rounded">bash deploy/admin-up.sh</code> in the server terminal.</li>
              </ul>
              <button
                onClick={handleLock}
                disabled={locking || lockCountdown !== null}
                className="bg-error/10 border border-error/40 text-error rounded-md px-5 py-2 text-xs font-medium hover:bg-error hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {locking ? 'LOCKING...' : lockCountdown !== null ? `SESSION ENDS IN ${lockCountdown}s` : 'LOCK & END SESSION'}
              </button>
              {lockCountdown !== null && (
                <div className="mt-3 text-[11px] text-text-secondary">
                  Redirecting to login page when countdown ends. To regain admin access, run the unlock script and log back in.
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'limits' && (
          <div className="flex flex-col h-full">
            <p className="text-text-secondary mb-4">{t('settings.desc_limits')}</p>
            <div className="flex-1 flex flex-col">
              <label className="block mb-2 font-bold">{t('settings.json_label_limits')}</label>
              <textarea
                value={jsonContent}
                onChange={(e) => setJsonContent(e.target.value)}
                className="w-full flex-1 min-h-[400px] font-mono text-[13px] bg-bg-primary text-text-primary border border-border rounded-md p-3 leading-relaxed resize-none outline-none focus:border-accent transition-colors"
                spellCheck={false}
              />
              <div className="mt-1 text-[11px] text-text-secondary text-right">JSON Format</div>
            </div>
            <div className="mt-5 mb-5 flex gap-4 items-center">
              <button
                onClick={handleSave}
                disabled={loading}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-6 py-2 text-xs font-medium hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'SAVING...' : t('settings.btn_save')}
              </button>
              {message && (
                <span className={`text-[13px] px-2 py-1 rounded border ${message.type === 'success' ? 'text-success bg-success/10 border-success/30' : 'text-error bg-error/10 border-error/30'}`}>
                  {message.text}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </TabbedLayout>
  );
};
