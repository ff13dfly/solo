import { useState } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import type { ServiceInfo } from '../../types';

interface BotCreateModalProps {
  onClose: () => void;
  onSuccess: () => void;
  servicesAvailableForCreate: ServiceInfo[];
}

const BOT_UID_PREFIX = 'system.';

export default function BotCreateModal({ onClose, onSuccess, servicesAvailableForCreate }: BotCreateModalProps) {
  const { toast } = useUI();
  const { t } = useLang();
  const [newUid, setNewUid] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const uid = newUid.trim();
    if (!uid) return toast.error(t('bot_mgmt.selectAService'));
    const fullUid = BOT_UID_PREFIX + uid;
    setCreating(true);
    try {
      await callRpc('user.bot.create', {
        uid: fullUid,
        desc: newDesc.trim(),
        permit: { allow_all: false, services: {} },
      });
      toast.success(t('bot_mgmt.botCreated', { uid: fullUid }));
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || t('bot_mgmt.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={() => !creating && onClose()}
      title={t('bot_mgmt.createBotAccount')}
      size="md"
      footer={
        <div className="flex gap-2 justify-end w-full font-sans">
          <Button onClick={onClose} variant="secondary" disabled={creating}>
            {t('bot_mgmt.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={creating || !newUid || servicesAvailableForCreate.length === 0}>
            {creating ? t('bot_mgmt.creating') : t('bot_mgmt.create')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 font-sans">
        {servicesAvailableForCreate.length === 0 ? (
          <div className="text-[12px] text-text-secondary border border-border rounded-md p-4 bg-white/[0.02] text-center">
            {t('bot_mgmt.allServicesHaveBot')}
          </div>
        ) : (
          <>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">
                {t('bot_mgmt.serviceLabel')}
              </label>
              <select
                value={newUid}
                onChange={(e) => setNewUid(e.target.value)}
                className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                disabled={creating}
              >
                <option value="">{t('bot_mgmt.selectServiceOption')}</option>
                {servicesAvailableForCreate.map(s => (
                  <option key={s.id} value={s.id}>
                    {BOT_UID_PREFIX}{s.id}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-[10px] text-text-secondary">
                {t('bot_mgmt.onlyServicesWithoutBot')}
              </div>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">
                {t('bot_mgmt.descriptionLabel')}
              </label>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder={t('bot_mgmt.descriptionPlaceholder')}
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors font-mono"
                disabled={creating}
              />
            </div>

            <div className="text-[11px] text-text-secondary border border-border rounded-md p-3 bg-white/[0.02] leading-relaxed">
              {t('bot_mgmt.emptyPermitBeforeStrong')}
              <strong>{t('bot_mgmt.permit')}</strong>
              {t('bot_mgmt.emptyPermitAfterStrong')}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
