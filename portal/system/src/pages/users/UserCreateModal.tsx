import { useState } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { generateSalt } from '../../utils/crypto';
import CryptoJS from 'crypto-js';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';

interface UserCreateModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function UserCreateModal({ onClose, onSuccess }: UserCreateModalProps) {
  const { toast } = useUI();
  const [newOpName, setNewOpName] = useState('');
  const [newOpPassword, setNewOpPassword] = useState('');
  const [createOpLoading, setCreateOpLoading] = useState(false);
  const [createOpError, setCreateOpError] = useState('');

  const handleCreateOperator = async () => {
    const name = newOpName.trim().toLowerCase();
    if (!name || !newOpPassword) return;
    setCreateOpLoading(true);
    setCreateOpError('');
    try {
      const salt = generateSalt();
      // operator portal login uses SHA256(password+salt) — must match
      const hash = CryptoJS.SHA256(newOpPassword + salt).toString();
      const { uid } = await callRpc<{ uid: string }>('user.register', { name, salt, hash });
      await callRpc('user.account.update', { uid, categories: { POWER: 'operator' } });
      await callRpc('user.permit.update', { uid, permit: { allow_all: true, services: {} } });
      toast.success(`Operator "${name}" created`);
      onSuccess();
      onClose();
    } catch (err: any) {
      setCreateOpError(err.message || 'Create failed');
    } finally {
      setCreateOpLoading(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="CREATE OPERATOR USER"
      size="sm"
      footer={
        <div className="flex gap-2 items-center w-full font-sans">
          {createOpError && <span className="text-error text-xs mr-auto">{createOpError}</span>}
          <Button variant="ghost" onClick={onClose} disabled={createOpLoading}>CANCEL</Button>
          <Button
            onClick={handleCreateOperator}
            disabled={createOpLoading || !newOpName.trim() || !newOpPassword}
          >
            {createOpLoading ? 'CREATING…' : 'CREATE'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 py-1">
        <p className="text-xs text-text-secondary leading-relaxed font-sans">
          创建一个可登录 Operator Portal 的用户账号（POWER = operator）。凭证仅显示一次，创建后请妥善保管。
        </p>
        <div className="flex flex-col gap-1 font-sans">
          <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">Username *</label>
          <input
            autoFocus
            value={newOpName}
            onChange={e => setNewOpName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateOperator()}
            placeholder="e.g. ops_alice"
            className="bg-bg-primary border border-border rounded-md px-3 py-2 text-sm text-text-primary outline-none focus:border-accent transition-colors font-mono"
            disabled={createOpLoading}
          />
        </div>
        <div className="flex flex-col gap-1 font-sans">
          <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">Password *</label>
          <input
            type="password"
            value={newOpPassword}
            onChange={e => setNewOpPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateOperator()}
            placeholder="••••••••"
            className="bg-bg-primary border border-border rounded-md px-3 py-2 text-sm text-text-primary outline-none focus:border-accent transition-colors font-mono"
            disabled={createOpLoading}
          />
        </div>
      </div>
    </Modal>
  );
}
