import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';
import { useLang } from '../providers/LanguageProvider';
import { useUI } from '../providers/UIProvider';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { PERMIT_CONFIG } from '../config/permit';
import CategoryManager from '../components/CategoryManager';
import UserLogModal from '../components/user-management/UserLogModal';
import PermitEditorModal from '../components/permit/PermitEditorModal';
import { formatDate } from '../utils/format';
import { generateSalt } from '../utils/crypto';
import CryptoJS from 'crypto-js';

import type { User, Permit, CategoryConfig, CategoryItem, ServiceInfo } from '../types';

import { useUsers } from '../hooks/useUsers';

export default function UserManagement() {
  const { t, lang } = useLang();
  const { toast, confirm } = useUI();

  const [page, setPage] = useState(1);
  const [searchKeyword, setSearchKeyword] = useState('');

  const {
    users,
    total,
    pageSize,
    loading,
    error: fetchError,
    refresh: fetchUsers,
    updateUserInfo
  } = useUsers({ page, searchKeyword });

  const [error, setError] = useState('');
  const [isServiceError, setIsServiceError] = useState(false);
  const [serviceUrl, setServiceUrl] = useState('');

  // Category State
  const [categories, setCategories] = useState<CategoryConfig[]>([]);
  const [categoryMap, setCategoryMap] = useState<Record<string, CategoryItem[]>>({});

  // Power tier editing state
  const [editingUser, setEditingUser] = useState<string | null>(null);

  // Category Modal State
  const [showCatModal, setShowCatModal] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<CategoryConfig | null>(null);

  const [showPermitModal, setShowPermitModal] = useState(false);
  const [selectedUserPermit, setSelectedUserPermit] = useState<{ id: string; name: string; permit: Permit | null } | null>(null);
  const [availableServices, setAvailableServices] = useState<ServiceInfo[]>([]);

  // Create Operator Modal State
  const [showCreateOperator, setShowCreateOperator] = useState(false);
  const [newOpName, setNewOpName] = useState('');
  const [newOpPassword, setNewOpPassword] = useState('');
  const [createOpLoading, setCreateOpLoading] = useState(false);
  const [createOpError, setCreateOpError] = useState('');

  // Log Modal State
  const [showLogModal, setShowLogModal] = useState(false);
  const [selectedLogUser, setSelectedLogUser] = useState<{ id: string; name: string } | null>(null);

  // Raw Modal State
  const [showRawModal, setShowRawModal] = useState(false);
  const [selectedRawData, setSelectedRawData] = useState<any>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(key);
      setTimeout(() => setCopiedField(null), 1200);
    }).catch(() => toast.error('Copy failed'));
  };

  const fetchCategories = async () => {
    try {
      const result = await callRpc<CategoryConfig[] | { categories: CategoryConfig[] }>('user.category.list', {});

      let catList: CategoryConfig[] = [];
      if (Array.isArray(result)) {
        catList = result;
      } else if (result && 'categories' in result && Array.isArray(result.categories)) {
        catList = result.categories;
      }

      setCategories(catList);

      const map: Record<string, CategoryItem[]> = {};
      for (const cat of catList) {
        if (cat.items && Array.isArray(cat.items)) {
          map[cat.key] = cat.items;
        }
      }
      setCategoryMap(map);
    } catch (e) {
      console.warn('Failed to load categories', e);
    }
  };

  const fetchAvailableServices = async () => {
    try {
      const result = await callRpc<ServiceInfo[]>('system.service.list', {});
      const filtered = result.filter(s => !PERMIT_CONFIG.restrictedServices.includes(s.id));
      setAvailableServices(filtered);
    } catch (e) {
      console.warn('Failed to load available services', e);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchCategories();
    fetchAvailableServices();
  }, [page]);

  const handleRoleChange = async (uid: string, newRole: string) => {
    try {
      await callRpc('user.account.update', {
        uid,
        categories: { POWER: newRole }
      });
      updateUserInfo(uid, {
        categories: { POWER: newRole }
      });
      setEditingUser(null);
    } catch (err: any) {
      toast.error('Failed to update power: ' + err.message);
    }
  };

  const openCategoryModal = (cat: CategoryConfig) => {
    setSelectedCategory(cat);
    setShowCatModal(true);
  };

  const handleLogClick = (user: User) => {
    setSelectedLogUser({ id: user.id, name: user.name });
    setShowLogModal(true);
  };

  const handleStatusChange = async (user: User) => {
    const isDeleted = user.status === 'DELETED';
    const method = isDeleted ? 'user.account.restore' : 'user.account.remove';
    const actionLabel = isDeleted ? t('user.btn_restore') : t('user.btn_disable');

    const confirmed = await confirm({
      message: t('operator.confirm_' + (isDeleted ? 'enable' : 'disable'), { name: user.name }),
      isDangerous: !isDeleted
    });

    if (!confirmed) return;

    try {
      await callRpc(method, { id: user.id });
      toast.success(t('operator.toast_status_success', { name: user.name, action: actionLabel }));
      fetchUsers();
    } catch (err: any) {
      toast.error(err.message || 'Action failed');
    }
  };

  // 主动吊销:删掉该 uid 的全部 live session(泄露应急 / 强制下线)。需重新登录。
  const handleRevokeSessions = async (user: { id: string; name: string }) => {
    const confirmed = await confirm({
      message: `吊销「${user.name}」的全部登录会话?该用户/Bot 当前所有 token 立即失效,需重新登录。`,
      isDangerous: true,
    });
    if (!confirmed) return;
    try {
      const res = await callRpc<{ uid: string; revoked: number }>('user.token.revoke', { uid: user.id });
      toast.success(`已吊销 ${res?.revoked ?? 0} 个会话`);
    } catch (err: any) {
      toast.error(err.message || 'Revoke failed');
    }
  };

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
      setShowCreateOperator(false);
      setNewOpName('');
      setNewOpPassword('');
      fetchUsers();
    } catch (err: any) {
      setCreateOpError(err.message || 'Create failed');
    } finally {
      setCreateOpLoading(false);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  const getItemLabel = (item: CategoryItem): string => {
    if (typeof item.label === 'object') {
      return (item.label as Record<string, string>)[lang] || (item.label as Record<string, string>).en || item.id;
    }
    return String(item.label);
  };

  const renderRoleCell = (user: User) => {
    const currentRole = user.categories?.POWER || 'normal';
    const roleItems = categoryMap['POWER'] || [];

    const isEditing = editingUser === user.id;

    if (roleItems.length === 0) return <span>{currentRole}</span>;

    const currentItem = roleItems.find(i => i.id === currentRole);
    const currentLabel = currentItem ? getItemLabel(currentItem) : currentRole;

    return (
      <div
        onClick={(e) => {
          e.stopPropagation();
          setEditingUser(user.id);
        }}
        className="cursor-pointer relative"
      >
        {isEditing ? (
          <select
            autoFocus
            value={currentRole}
            onChange={(e) => {
              handleRoleChange(user.id, e.target.value);
            }}
            onBlur={() => setEditingUser(null)}
            onClick={(e) => e.stopPropagation()}
            className="text-[11px] p-0.5 rounded border border-[#ccc] bg-bg-primary text-text-primary outline-none"
          >
            {roleItems.map((item) => (
              <option key={item.id} value={item.id}>{getItemLabel(item)}</option>
            ))}
          </select>
        ) : (
          <span className={`border-b border-dashed border-[#ccc] ${currentRole === 'operator' ? 'text-accent' : ''}`}>
            {currentLabel}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Title Bar */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span>{t('user.title')}</span>
          {/* Category Management Buttons */}
          <div className="flex gap-2">
            {categories.map(cat => (
              <button
                key={cat.key}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 h-6 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all opacity-80"
                onClick={() => openCategoryModal(cat)}
              >
                {cat.key}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-3 items-center bg-white/[0.03] px-3 py-1 rounded-md border border-white/5">
          {/* Create Operator */}
          <button
            className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
            onClick={() => { setShowCreateOperator(true); setCreateOpError(''); }}
          >
            + Operator
          </button>
          {/* Search */}
          <div className="relative flex items-center">
            <span className="absolute left-2 text-[10px] opacity-50">🔍</span>
            <input
              className="w-48 bg-bg-primary rounded-full border border-border py-1 pl-7 pr-6 text-text-primary text-[12px] outline-none focus:border-accent transition-colors"
              placeholder={t('user.search_placeholder') || 'Search users (Enter)'}
              value={searchKeyword}
              onChange={(e) => {
                const val = e.target.value;
                setSearchKeyword(val);
                if (val === '') fetchUsers('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && fetchUsers()}
            />
            {searchKeyword && (
              <button
                onClick={() => { setSearchKeyword(''); fetchUsers(''); }}
                className="absolute right-2 flex items-center justify-center w-4 h-4 rounded-full bg-text-disabled text-bg-primary text-[10px] hover:bg-text-secondary transition-colors"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {error && (
          <div className={`p-4 ${isServiceError ? 'bg-orange-500/10' : 'bg-transparent'}`}>
            <div className="mb-2 text-error">Error: {error}</div>
            {isServiceError && serviceUrl && (
              <div className="p-3 bg-orange-500/15 rounded-md border border-orange-500/30 text-[13px] flex items-center gap-3">
                <span className="text-orange-500">⚠️ 服务未注册，请在 <strong className="text-accent">Service Registry</strong> 添加:</span>
                <code className="bg-black/30 px-2 py-1 rounded text-white">{serviceUrl}</code>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-0.5 text-[11px] hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => { navigator.clipboard.writeText(serviceUrl); toast.success('已复制'); }}
                >
                  COPY
                </button>
              </div>
            )}
          </div>
        )}

        {/* Header Row */}
        <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10 grid-cols-[1.5fr_3fr_1.5fr_2fr_1fr_1.5fr]">
          <div>{t('user.col_uid')}</div>
          <div>ACTIONS</div>
          <div>{t('user.col_categories') || '分类'}</div>
          <div>{t('user.col_name')}</div>
          <div>{t('user.col_devices')}</div>
          <div>{t('user.col_active')}</div>
        </div>

        {/* Data Rows */}
        <div className="flex-1 overflow-y-auto">
          {users.map(user => (
            <div key={user.id} className="grid gap-4 px-5 border-b border-border hover:bg-white/[0.02] items-center text-sm transition-colors grid-cols-[1.5fr_3fr_1.5fr_2fr_1fr_1.5fr] h-[52px]">
              <div
                className="font-mono text-[11px] text-accent truncate cursor-pointer hover:underline flex items-center gap-1"
                title={user.id}
                onClick={() => handleCopy(user.id, `uid-${user.id}`)}
              >
                <span className="truncate">{user.id}</span>
                {copiedField === `uid-${user.id}` && <span className="text-success text-[10px] shrink-0">✓</span>}
              </div>

              {/* ACTIONS Column */}
              <div className="flex gap-2 items-center">
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-4 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => {
                    setSelectedRawData(user);
                    setShowRawModal(true);
                  }}
                >
                  RAW
                </button>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-4 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => {
                    setSelectedUserPermit({ id: user.id, name: user.name, permit: JSON.parse(JSON.stringify(user.permit || { allow_all: false, services: {} })) });
                    setShowPermitModal(true);
                  }}
                >
                  PERMIT
                </button>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-4 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => handleLogClick(user)}
                >
                  LOG
                </button>
                <button
                  className="bg-error/10 border border-error/40 text-error rounded-md px-4 py-1.5 text-[11px] font-medium hover:bg-error hover:text-white transition-all"
                  onClick={() => handleRevokeSessions(user)}
                  title="吊销该用户/Bot 的全部登录会话"
                >
                  REVOKE
                </button>
                <button
                  className={`rounded-md px-4 py-1.5 text-[11px] font-medium transition-all ${user.status === 'DELETED' ? 'bg-accent-dim border border-accent/40 text-accent hover:bg-[#1f6feb] hover:text-white' : 'bg-error/10 border border-error/40 text-error hover:bg-error hover:text-white'}`}
                  onClick={() => handleStatusChange(user)}
                >
                  {user.status === 'DELETED' ? t('user.btn_restore') : t('user.btn_disable')}
                </button>
              </div>

              {/* CATEGORIES Column */}
              <div className="text-[11px]">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="opacity-50">Power:</span>
                    {renderRoleCell(user)}
                  </div>
                  {user.categories && Object.keys(user.categories).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(user.categories)
                        .filter(([k]) => !['POWER', 'ROLE', 'role'].includes(k))
                        .map(([k, v]) => {
                          const items = categoryMap[k.toUpperCase()] || [];
                          const item = items.find(i => i.id === v);
                          const label = item ? getItemLabel(item) : v;
                          return (
                            <span key={k} className="bg-white/5 px-1.5 py-0.5 rounded text-[10px]">
                              {k}:{label}
                            </span>
                          );
                        })}
                    </div>
                  )}
                </div>
              </div>

              {/* USERNAME Column */}
              <div
                className="font-medium text-accent text-[12px] truncate cursor-pointer hover:underline flex items-center gap-1"
                onClick={() => handleCopy(user.name, `name-${user.id}`)}
              >
                <span className="truncate">{user.name}</span>
                {copiedField === `name-${user.id}` && <span className="text-success text-[10px] shrink-0">✓</span>}
              </div>

              {/* DEVICES Column */}
              <div>
                <span className="bg-white/5 border border-border rounded-xl px-2 py-0.5 text-[11px] text-text-secondary cursor-help hover:border-accent hover:text-accent transition-colors" title={Object.keys(user.devices || {}).join(', ')}>
                  {t('user.device_active', { count: Object.keys(user.devices || {}).length })}
                </span>
              </div>

              {/* ACTIVE Column */}
              <div className="text-[11px] text-accent">{formatDate(user.last)}</div>
            </div>
          ))}

          {!loading && users.length === 0 && (
            <div className="p-6 text-center opacity-50">{t('user.empty')}</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center">
          <span className="text-xs text-text-secondary">TOTAL: {total} · PAGE {page} OF {totalPages || 1}</span>
          <div className="flex items-center gap-2">
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              PREV
            </button>
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={page >= totalPages || loading}
              onClick={() => setPage(page + 1)}
            >
              NEXT
            </button>
          </div>
        </div>
      </div>

      {/* Category Management Modal */}
      {showCatModal && selectedCategory && (
        <CategoryManager
          category={selectedCategory}
          onClose={() => setShowCatModal(false)}
          onUpdate={fetchCategories}
        />
      )}

      {/* Permit Modal */}
      {showPermitModal && selectedUserPermit && (
        <PermitEditorModal
          userId={selectedUserPermit.id}
          userName={selectedUserPermit.name}
          initialPermit={selectedUserPermit.permit}
          availableServices={availableServices}
          onClose={() => setShowPermitModal(false)}
          onSaveSuccess={(updatedPermit) => {
            if (selectedUserPermit) {
              updateUserInfo(selectedUserPermit.id, { permit: updatedPermit });
            }
          }}
        />
      )}

      {/* Log View Modal */}
      {showLogModal && selectedLogUser && (
        <UserLogModal
          userId={selectedLogUser.id}
          userName={selectedLogUser.name}
          onClose={() => setShowLogModal(false)}
        />
      )}

      {/* Create Operator Modal */}
      <Modal
        isOpen={showCreateOperator}
        onClose={() => setShowCreateOperator(false)}
        title="CREATE OPERATOR USER"
        size="sm"
        footer={
          <div className="flex gap-2 items-center w-full">
            {createOpError && <span className="text-error text-xs mr-auto">{createOpError}</span>}
            <Button variant="ghost" onClick={() => setShowCreateOperator(false)}>CANCEL</Button>
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
          <p className="text-xs text-text-secondary leading-relaxed">
            创建一个可登录 Operator Portal 的用户账号（POWER = operator）。凭证仅显示一次，创建后请妥善保管。
          </p>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">Username *</label>
            <input
              autoFocus
              value={newOpName}
              onChange={e => setNewOpName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateOperator()}
              placeholder="e.g. ops_alice"
              className="bg-bg-primary border border-border rounded-md px-3 py-2 text-sm text-text-primary outline-none focus:border-accent transition-colors"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">Password *</label>
            <input
              type="password"
              value={newOpPassword}
              onChange={e => setNewOpPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateOperator()}
              placeholder="••••••••"
              className="bg-bg-primary border border-border rounded-md px-3 py-2 text-sm text-text-primary outline-none focus:border-accent transition-colors"
            />
          </div>
        </div>
      </Modal>

      {/* Raw JSON Modal */}
      <Modal
        isOpen={showRawModal}
        onClose={() => setShowRawModal(false)}
        title={`RAW USER DATA: ${selectedRawData?.name || ''}`}
        size="lg"
        footer={<Button onClick={() => setShowRawModal(false)}>CLOSE</Button>}
      >
        <pre className="bg-bg-primary p-4 rounded-md text-xs font-mono overflow-auto border border-border text-text-secondary h-[60vh]">
          {selectedRawData && JSON.stringify(selectedRawData, null, 2)}
        </pre>
      </Modal>
    </div>
  );
}
