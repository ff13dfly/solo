import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { callRpc } from '../utils/rpc';
import { setSession, setSessionUser, clearSession } from '../utils/auth';
import { deriveLoginHash, computeResponse } from '../utils/crypto';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { Button } from '../components/ui';
import { getRouterAddresses, getCurrentRouterIndex, setCurrentRouterIndex } from '../utils/routerManager';
import type { RouterInfo } from '../utils/routerManager';

export default function Login() {
  const { toast } = useUI();
  const { t } = useLang();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();


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
    setLoading(true);

    try {
      // 1. Request Challenge (using user service)
      const checkParams = { name: username };
      const challengeRes = await callRpc<{
        challenge: string;
        salt: string;
        iterations: number;
      }>('user.login.request', checkParams);

      const { challenge, salt, iterations } = challengeRes;

      // 2. Compute Response
      const loginHash = deriveLoginHash(password, username, salt, iterations);
      const response = computeResponse(challenge, loginHash);

      // 3. Verify (using user service)
      const verifyRes = await callRpc<{ success: boolean; token: string; uid: string; categories?: Record<string, string> }>('user.login.verify', {
        name: username,
        challenge,
        response,
        deviceId: 'web_op_' + Date.now()
      });

      if (!verifyRes.success) {
        toast.error(t('login.fail'));
        return;
      }

      // 4. Set session first so subsequent API calls have auth token
      setSession(verifyRes.token);
      setSessionUser(username.trim().toLowerCase());

      // 5. Role Validation - Check if user has operator tier (case-insensitive key lookup).
      // Tier (categories.POWER) is surfaced by user.login.verify itself — no separate
      // user.profile call (that method is permit-gated; a fresh operator has no such grant).
      const categories = verifyRes.categories || {};
      // Account power tier (admin/operator/normal) — gates operator-portal access.
      const userRole = categories['POWER'] || categories['power'] || '';

      if (userRole.toLowerCase() !== 'operator') {
        // Clear session if role check fails
        clearSession();
        toast.error(t('login.role_denied') || 'Access denied: Operator role required');
        return;
      }

      // 6. Success - navigate
      toast.success(t('login.success'));
      navigate('/');

    } catch (err: any) {
      toast.error(err.message || t('login.fail'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-header">
        <div className="auth-title">{t('login.title')}</div>
        <div className="auth-status-indicator">{t('login.secure')}</div>
      </div>

      {/* Gateway Configuration - Always visible at top */}
      <div className="form-group">
        <label className="form-label">{t('login.gateway_config')}</label>
        <select
          value={selectedRouterIndex}
          onChange={(e) => handleRouterChange(Number(e.target.value))}
          disabled={loading}
        >
          {routers.map((router, idx) => {
            // Helper to translate default router names
            let displayName = router.name;
            if (router.name === 'Production') displayName = t('login.router_prod');
            else if (router.name === 'Local (SSL)') displayName = t('login.router_local_ssl');
            else if (router.name === 'Local (HTTP)') displayName = t('login.router_local_http');

            return (
              <option key={idx} value={idx}>
                {displayName} - {router.url}
              </option>
            );
          })}
        </select>
      </div>

      <form onSubmit={handleLogin} className="auth-form" data-testid="login-form">
        <div className="form-group">
          <label className="form-label">{t('login.username_label')}</label>
          <input
            type="text"
            data-testid="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            autoFocus
            placeholder={t('login.username_placeholder')}
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t('login.password_label')}</label>
          <input
            type="password"
            data-testid="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            placeholder={t('login.password_placeholder')}
          />
        </div>

        <Button type="submit" data-testid="login-submit" variant="primary" loading={loading} style={{ width: '100%' }} disabled={loading || !username || !password}>
          {loading ? t('login.authenticating') : t('login.submit')}
        </Button>
      </form>
    </div>
  );
}
