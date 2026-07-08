import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';
import { useLang } from '../../providers/LanguageProvider';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../utils/format';
import { permitAllows } from '../../components/permit/permit-utils';
import PermitView from '../../components/permit/PermitView';
import type { Permit } from '../../types';
import type { Sentinel } from './types';
import { declaredNeeds } from './utils';

interface SentinelPermitModalProps {
  sentinel: Sentinel;
  onClose: () => void;
}

export default function SentinelPermitModal({ sentinel, onClose }: SentinelPermitModalProps) {
  const { t } = useLang();
  const isBot = sentinel.identity?.mode === 'bot' || sentinel.authorityRole.startsWith('system.');
  const uid = isBot ? sentinel.authorityRole : 'system.nexus';
  // undefined = loading, null = bot account missing/unreadable
  const [permit, setPermit] = useState<Permit | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    callRpc<{ permit: Permit }>('user.bot.get', { uid })
      .then(r => setPermit(r?.permit ?? null))
      .catch(err => { setPermit(null); setLoadError(err.message || t('nexus_mgmt.bot_account_not_found')); });
  }, [uid, t]);

  const needs = declaredNeeds(sentinel);

  return (
    <Modal isOpen onClose={onClose} title={`${t('nexus_mgmt.permit_modal_title')}: ${sentinel.name}`} size="lg"
      footer={<Button onClick={onClose}>{t('nexus_mgmt.close')}</Button>}>
      <div className="flex flex-col gap-4" data-test="sentinel-permit-modal">
        {/* Identity line */}
        <div className="flex items-center gap-2 text-[12px] flex-wrap">
          <span className={`text-[10px] px-1.5 py-0.5 border rounded ${isBot
            ? 'border-accent/40 text-accent bg-accent/10'
            : 'border-border text-text-secondary bg-white/5'}`}>
            {isBot ? t('nexus_mgmt.bot_identity') : t('nexus_mgmt.shared_identity')}
          </span>
          <code className="font-mono text-[11px] text-accent">{uid}</code>
          {isBot && sentinel.identity?.expired && <span className="text-[10px] text-error">{t('nexus_mgmt.token_expired_hint')}</span>}
          {isBot && !sentinel.identity?.expired && sentinel.identity?.hasToken === true && (
            <span className="text-[10px] text-success">
              {sentinel.identity?.expiresAt
                ? t('nexus_mgmt.token_injected_with_expiry', { date: formatDate(sentinel.identity.expiresAt) })
                : t('nexus_mgmt.token_injected')}
            </span>
          )}
          {isBot && sentinel.identity?.hasToken === false && <span className="text-[10px] text-error">{t('nexus_mgmt.token_not_injected_hint')}</span>}
        </div>

        {!isBot && (
          <div className="text-[11px] text-text-secondary border border-border rounded-md p-3 bg-white/[0.02] leading-relaxed">
            {t('nexus_mgmt.shared_identity_note')}
          </div>
        )}

        {/* Declared needs vs grants — the pre-audit verdict */}
        <div>
          <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-2">{t('nexus_mgmt.declared_needs_granted')}</div>
          {needs.length === 0 ? (
            <div className="text-[12px] text-text-secondary">
              {t('nexus_mgmt.no_declared_needs')}
            </div>
          ) : permit === undefined ? (
            <div className="text-[12px] text-text-secondary opacity-60">{t('nexus_mgmt.loading_permit')}</div>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              {needs.map(m => {
                const ok = permitAllows(permit, m);
                return (
                  <div key={m} data-test="permit-need-row"
                    className="flex items-center justify-between px-3 py-2 border-b border-border last:border-b-0 text-[12px]">
                    <code className="font-mono text-[11px]">{m}</code>
                    <span className={ok ? 'text-success' : 'text-error'}>{ok ? t('nexus_mgmt.granted') : t('nexus_mgmt.missing')}</span>
                  </div>
                );
              })}
            </div>
          )}
          {permit === null && needs.length > 0 && (
            <div className="mt-2 text-[11px] text-error">
              {loadError
                ? t('nexus_mgmt.bot_account_missing_with_reason', { reason: loadError })
                : t('nexus_mgmt.bot_account_missing')}
            </div>
          )}
        </div>

        {/* Permit — same structured rendering as the editor (shared PermitView) */}
        <div>
          <div className="text-[11px] font-bold text-accent uppercase tracking-wider mb-2">{t('nexus_mgmt.permit_read_only')}</div>
          <div className="max-h-[32vh] overflow-y-auto">
            {permit === undefined
              ? <div className="text-[12px] text-text-secondary opacity-60">{t('nexus_mgmt.loading')}</div>
              : <PermitView permit={permit} />}
          </div>
          <div className="mt-1 text-[10px] text-text-secondary">
            {t('nexus_mgmt.edit_permit_hint')}
          </div>
        </div>
      </div>
    </Modal>
  );
}
