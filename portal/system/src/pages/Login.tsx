import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { deriveLoginHash, computeResponse } from '../utils/crypto';
import { callRpc } from '../utils/rpc';
import { setSession } from '../utils/auth';
import { getRouterAddresses, getCurrentRouterIndex, setCurrentRouterIndex } from '../utils/routerManager';
import type { RouterInfo } from '../utils/routerManager';
import { FireworkBackground } from '../components/FireworkBackground';
import { useLang } from '../providers/LanguageProvider';

export default function Login() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [logs, setLogs] = useState<Array<{ type: string, msg: string, time: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fireworksEnabled, setFireworksEnabled] = useState(true);
  const [loginInitiated, setLoginInitiated] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    setLogs(prev => [...prev, { type, msg, time }]);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [logs]);

  const [showPassword, setShowPassword] = useState(false);
  const [routers, setRouters] = useState<RouterInfo[]>([]);
  const [selectedRouterIndex, setSelectedRouterIndex] = useState(0);

  useEffect(() => {
    setRouters(getRouterAddresses());
    setSelectedRouterIndex(getCurrentRouterIndex());
  }, []);

  const handleRouterChange = (index: number) => {
    setSelectedRouterIndex(index);
    setCurrentRouterIndex(index);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    setIsLoading(true);
    setLoginInitiated(true);
    setLogs([]); // Clear previous logs
    addLog(t('login.log_initiating', { username }));

    try {
      // Step 1: Request Login (Handshake)
      addLog(t('login.log_step1'), 'info');

      const reqStart = Date.now();
      // Changed to RPC call
      const { salt, iterations, challenge } = await callRpc<{ salt: string, iterations: number, challenge: string }>('admin.login.request', { username });
      const reqEnd = Date.now();

      addLog(t('login.log_server_responded', { ms: reqEnd - reqStart }), 'info');
      addLog(t('login.log_received_salt', { salt: salt.substring(0, 8) }), 'info');
      addLog(t('login.log_received_challenge', { challenge: challenge.substring(0, 8) }), 'info');
      addLog(t('login.log_iterations', { iterations }), 'info');

      // Step 2: Client-side computation
      addLog(t('login.log_step2'), 'info');

      await new Promise(r => setTimeout(r, 600));

      const loginHash = deriveLoginHash(password, username, salt, iterations);
      addLog(t('login.log_key_derived'), 'success');

      const responseSignature = computeResponse(challenge, loginHash);
      addLog(t('login.log_signature_generated', { signature: responseSignature.substring(0, 8) }), 'success');

      // Step 3: Verify
      addLog(t('login.log_step3'), 'info');

      // Changed to RPC call
      const verifyRes = await callRpc<{ success: boolean, token: string }>('admin.login.verify', {
        username,
        challenge,
        response: responseSignature
      });

      if (verifyRes.success) {
        addLog(t('login.log_access_granted'), 'success');
        addLog(t('login.log_session_token', { token: verifyRes.token.substring(0, 10) }), 'success');

        // Store Session and Redirect
        setSession(verifyRes.token);
        setTimeout(() => {
          navigate('/dashboard');
        }, 1000);
      } else {
        addLog(t('login.log_auth_failed'), 'error');
      }

    } catch (err: any) {
      console.error(err);
      addLog(t('login.log_error', { message: err.message }), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <FireworkBackground enabled={fireworksEnabled && !isLoading && !loginInitiated} />
      <div className="w-[400px] border border-border p-6 relative z-10 bg-bg-primary/80 backdrop-blur-sm shadow-2xl">
        {/* Header */}
        <div className="border-b border-border mb-6 pb-3 flex justify-between items-center">
          <div className="text-lg font-bold text-accent tracking-widest uppercase">{t('login.title')}</div>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setFireworksEnabled(!fireworksEnabled)}
              disabled={isLoading}
              title={fireworksEnabled ? t('login.disable_fireworks') : t('login.enable_fireworks')}
              className={`text-[9px] px-1.5 py-0.5 border transition-all duration-300 ${fireworksEnabled
                ? 'border-accent text-accent hover:bg-accent/10'
                : 'border-white/10 text-white/20 hover:border-white/30'
                }`}
            >
              FX: {fireworksEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Gateway Configuration */}
        <div className="mb-5 pb-4 border-b border-border">
          <label className="block text-xs mb-2 opacity-80 uppercase">
            {t('login.gateway_config')}
          </label>
          <select
            value={selectedRouterIndex}
            onChange={(e) => handleRouterChange(Number(e.target.value))}
            disabled={isLoading}
            className="w-full font-mono text-xs p-2.5 bg-bg-primary border border-accent/40 text-white rounded-none mt-1.5 focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all outline-none"
          >
            {routers.map((router, idx) => (
              <option key={idx} value={idx}>
                {router.name} - {router.url}
              </option>
            ))}
          </select>
        </div>

        {/* Login Form */}
        <form onSubmit={handleLogin} data-testid="login-form">
          <div className="mb-4 flex flex-col">
            <label className="text-xs mb-2 opacity-80 uppercase">{t('login.identity')}</label>
            <input
              type="text"
              data-testid="login-username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={isLoading}
              autoFocus
              className="bg-bg-primary border border-accent/40 text-text-primary p-2.5 rounded-none w-full text-[13px] transition-all focus:border-accent focus:shadow-[0_0_0_1px_rgba(56,139,253,0.3)] outline-none"
            />
          </div>

          <div className="mb-4 flex flex-col">
            <label className="text-xs mb-2 opacity-80 uppercase flex justify-between">
              <span>{t('login.credential')}</span>
              <span
                onClick={() => setShowPassword(!showPassword)}
                className="cursor-pointer text-[10px] opacity-60 underline"
              >
                {showPassword ? t('login.hide') : t('login.show')}
              </span>
            </label>
            <input
              type={showPassword ? "text" : "password"}
              data-testid="login-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onFocus={() => setFireworksEnabled(false)}
              onBlur={() => setFireworksEnabled(true)}
              disabled={isLoading}
              className="bg-bg-primary border border-accent/40 text-text-primary p-2.5 rounded-none w-full text-[13px] transition-all focus:border-accent focus:shadow-[0_0_0_1px_rgba(56,139,253,0.3)] outline-none"
            />
          </div>

          <button
            type="submit"
            data-testid="login-submit"
            disabled={isLoading}
            className="w-full mt-3 bg-accent-dim text-accent border border-accent/40 rounded-none p-2.5 font-bold uppercase tracking-wider text-[13px] transition-all hover:bg-[#1f6feb] hover:text-white hover:border-[#388bfd] disabled:bg-transparent disabled:border-border disabled:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? t('login.executing_protocol') : t('login.initiate_handshake')}
          </button>
        </form>

        {/* Status Log */}
        <div className="mt-6 border-t border-border pt-3 text-xs h-[100px] overflow-y-auto text-text-primary font-mono">
          {logs.map((log, i) => (
            <div key={i} className={`mb-1 ${log.type === 'error' ? 'text-error' : log.type === 'success' ? 'text-success' : ''}`}>
              [{log.time}] {log.msg}
            </div>
          ))}
          {logs.length === 0 && <div className="mb-1">{t('login.system_ready')}</div>}
          <div ref={messagesEndRef} />
        </div>
      </div>
    </>
  );
}
