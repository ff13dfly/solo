import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { callRpc } from '../../utils/rpc';

interface IssueTokenModalProps {
  botUid: string;
  token: string;
  expiresAt: number;
  onClose: () => void;
}

// Derive service name from bot uid if it matches the system.* convention.
// Returns null for bots that don't map to a service relay.
function serviceNameFromUid(uid: string): string | null {
  if (!uid.startsWith('system.')) return null;
  const name = uid.slice('system.'.length);
  return name || null;
}

/**
 * One-shot reveal of a freshly-issued bot token.
 *
 * The token returned by user.bot.issue.token cannot be recovered after this
 * dialog closes — the server only stores the session payload, not the token
 * itself. The UI makes this single-use property explicit so the admin copies
 * it before navigating away.
 */
export default function IssueTokenModal({ botUid, token, expiresAt, onClose }: IssueTokenModalProps) {
  const { toast } = useUI();
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [deployError, setDeployError] = useState<string | null>(null);
  const [showCloseWarning, setShowCloseWarning] = useState(false);

  const targetService = serviceNameFromUid(botUid);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      toast.error(t('bot_mgmt.copyFailed'));
    }
  };

  const handleDeploy = async () => {
    if (!targetService) return;
    setDeploying(true);
    setDeployError(null);
    try {
      await callRpc(`${targetService}.token.set`, { token, expiresAt, sub: botUid });
      setDeployStatus('ok');
      toast.success(t('bot_mgmt.tokenDeployedTo', { service: targetService }));
    } catch (err: any) {
      setDeployStatus('error');
      setDeployError(err.message || t('bot_mgmt.deployFailed'));
      toast.error(err.message || t('bot_mgmt.deployFailed'));
    } finally {
      setDeploying(false);
    }
  };

  const handleClose = () => {
    if (!acknowledged) {
      setShowCloseWarning(true);
      return;
    }
    onClose();
  };

  const handleForceClose = () => {
    onClose();
  };

  const expiresIn = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000 / 3600));

  return (
    <Modal
      isOpen={true}
      onClose={handleClose}
      title={t('bot_mgmt.tokenIssuedTitle', { uid: botUid })}
      size="lg"
      footer={
        <>
          {targetService && (
            <Button
              onClick={handleDeploy}
              disabled={deploying || deployStatus === 'ok'}
              variant={deployStatus === 'ok' ? 'secondary' : 'primary'}
            >
              {deploying
                ? t('bot_mgmt.deploying')
                : deployStatus === 'ok'
                ? t('bot_mgmt.deployedTo', { service: targetService.toUpperCase() })
                : t('bot_mgmt.deployTo', { service: targetService.toUpperCase() })}
            </Button>
          )}
          <Button onClick={handleCopy}>
            {copied ? t('bot_mgmt.copied') : t('bot_mgmt.copyToken')}
          </Button>
          <Button
            onClick={handleClose}
            variant={acknowledged ? 'primary' : 'secondary'}
            disabled={!acknowledged}
          >
            {t('bot_mgmt.close')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="p-3 bg-error/10 border border-error/40 rounded-md">
          <div className="font-bold text-error text-[13px] mb-1">{t('bot_mgmt.oneTimeDisplay')}</div>
          <div className="text-[12px] text-text-secondary leading-relaxed">
            {t('bot_mgmt.oneTimeDisplayBody')}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('bot_mgmt.botSessionToken')}</div>
          <textarea
            readOnly
            value={token}
            className="w-full h-24 font-mono text-[12px] bg-bg-primary text-accent border border-border rounded-md p-3 resize-none outline-none focus:border-accent select-all"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
        </div>

        <div className="flex gap-6 text-[11px] text-text-secondary">
          <div>
            <span className="opacity-60">{t('bot_mgmt.expiresIn')}</span>{' '}
            <span className="text-accent font-mono">{expiresIn}h</span>
          </div>
          <div>
            <span className="opacity-60">{t('bot_mgmt.expiresAt')}</span>{' '}
            <span className="text-accent font-mono">{new Date(expiresAt).toISOString()}</span>
          </div>
        </div>

        {targetService && deployStatus !== 'idle' && (
          <div className={`p-3 rounded-md border text-[12px] leading-relaxed ${
            deployStatus === 'ok'
              ? 'bg-success/10 border-success/40 text-success'
              : 'bg-error/10 border-error/40 text-error'
          }`}>
            {deployStatus === 'ok'
              ? t('bot_mgmt.deployOkBody', { service: targetService })
              : t('bot_mgmt.deployErrorBody', { error: deployError ?? '' })}
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer text-[12px] mt-2">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => {
              setAcknowledged(e.target.checked);
              if (e.target.checked) setShowCloseWarning(false);
            }}
            className="cursor-pointer"
          />
          <span>{t('bot_mgmt.ackCopied')}</span>
        </label>

        {showCloseWarning && (
          <div className="p-3 bg-warning/10 border border-warning/50 rounded-md text-[12px]">
            <div className="font-bold text-warning mb-2">{t('bot_mgmt.notAcknowledged')}</div>
            <div className="text-text-secondary mb-3 leading-relaxed">
              {t('bot_mgmt.notAcknowledgedBody')}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setShowCloseWarning(false)} variant="secondary">
                {t('bot_mgmt.goBack')}
              </Button>
              <Button onClick={handleForceClose} variant="danger">
                {t('bot_mgmt.closeWithoutCopying')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
