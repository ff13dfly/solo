import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/**
 * Signing-key setup/management (VERSION.md §3.2).
 *
 * An approver needs an Ed25519 signing key to sign off high-risk workflows. This
 * lets them provision (or re-provision) it: a password encrypts a fresh keypair
 * (user.key.generate); the password is never stored. Re-provisioning retires the
 * old public key (old signatures stay verifiable). uid defaults to the caller's
 * own session, so no uid input is needed. No browser dialogs (CLAUDE.md §8).
 */
interface Props {
  onClose: () => void;
}

export default function SigningKeyModal({ onClose }: Props) {
  const { toast } = useUI();
  const { t } = useLang();
  const [status, setStatus] = useState<{ hasKey: boolean; publicKey: string | null } | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await callRpc<any>('user.key.status', {})); }
    catch { setStatus({ hasKey: false, publicKey: null }); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const generate = async () => {
    if (password.trim().length < 8) { setPwError(t('approval.key_password_ph')); return; }
    setPwError('');
    setBusy(true);
    try {
      await callRpc('user.key.generate', { password });
      toast.success(t('approval.key_generated'));
      setPassword('');
      await refresh();
    } catch (e: any) {
      toast.error(e.message || t('approval.key_gen_failed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999] backdrop-blur-sm" onClick={onClose}>
      <div className="w-[480px] bg-bg-primary border border-border rounded-lg shadow-[0_12px_48px_rgba(0,0,0,0.6)]" onClick={e => e.stopPropagation()} data-test="signing-key-modal">
        <div className="px-5 py-3 border-b border-border flex justify-between items-center bg-white/[0.03]">
          <div className="font-mono text-[13px] uppercase tracking-wider text-accent">{t('approval.key_title')}</div>
          <button className="text-text-secondary hover:text-text-primary" onClick={onClose}>✕</button>
        </div>

        <div className="p-5 flex flex-col gap-3 text-[13px]">
          <div data-test="key-status" className={`px-3 py-2 border rounded text-[12px] ${status?.hasKey ? 'border-success/40 text-success' : 'border-warning/40 text-warning'}`}>
            {status === null ? t('approval.loading') : status.hasKey ? t('approval.key_have') : t('approval.key_none')}
          </div>

          {status?.hasKey && status.publicKey && (
            <div className="text-[11px] text-text-secondary font-mono break-all">
              {t('approval.key_pubkey')}: {status.publicKey}
            </div>
          )}

          <div className="text-[11px] text-text-secondary">{t('approval.key_gen_hint')}</div>
          <Input type="password" value={password} error={pwError} placeholder={t('approval.key_password_ph')}
                 onChange={(e) => setPassword(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') generate(); }} />
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('approval.key_close')}</Button>
          <Button variant="primary" data-test="key-generate" onClick={generate} isLoading={busy}>
            {status?.hasKey ? t('approval.key_reprovision') : t('approval.key_setup')}
          </Button>
        </div>
      </div>
    </div>
  );
}
