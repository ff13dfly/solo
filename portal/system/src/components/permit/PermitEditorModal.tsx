import { useState } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { PERMIT_CONFIG } from '../../config/permit';
import { groupMethodsByPrefix } from './permit-utils';
import type { Permit } from '../../types';

interface RPCMethod {
  name: string;
  description?: string;
  params?: any[];
  returns?: any;
}

interface ServiceInfo {
  id: string;
  url: string;
  methods: RPCMethod[];
}

// Generic permit editor — the ONE editing surface for every principal kind
// (human users via user.permit.update, bots via the onSave override). Lives in
// components/permit/ next to PermitView so editing and inspecting share one home.
interface PermitEditorModalProps {
  userId: string;
  userName: string;
  initialPermit: Permit | null;
  availableServices: ServiceInfo[];
  onClose: () => void;
  onSaveSuccess: (updatedPermit: Permit) => void;
  /** Optional save override — when provided, replaces the default user.permit.update call.
   *  Used by bot management to route the save through user.bot.update. */
  onSave?: (permit: Permit) => Promise<void>;
  /** When true, the "Administrator Access" toggle is hidden (e.g. bot accounts forbid allow_all). */
  disallowAllowAll?: boolean;
  /** Optional title override (defaults to "Edit Permissions"). */
  title?: string;
}

export default function PermitEditorModal({
  userId,
  userName,
  initialPermit,
  availableServices,
  onClose,
  onSaveSuccess,
  onSave,
  disallowAllowAll,
  title,
}: PermitEditorModalProps) {
  const { toast } = useUI();
  const [permit, setPermit] = useState<Permit>(initialPermit || { allow_all: false, services: {} });
  const [isSaving, setIsSaving] = useState(false);

  // 数据级字段约束:用行编辑,保存时合进 permit。
  type ConstraintRow = { method: string; mode: 'hide' | 'show'; fields: string };
  const [constraintRows, setConstraintRows] = useState<ConstraintRow[]>(() =>
    Object.entries(initialPermit?.constraints || {}).map(([method, rule]) => ({
      method,
      mode: rule.show ? 'show' : 'hide',
      fields: (rule.show || rule.hide || []).join(', '),
    }))
  );
  const updateConstraintRow = (i: number, patch: Partial<ConstraintRow>) =>
    setConstraintRows(rows => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const buildConstraints = (): Permit['constraints'] => {
    const c: Record<string, { hide?: string[]; show?: string[] }> = {};
    for (const r of constraintRows) {
      const m = r.method.trim();
      const fields = r.fields.split(',').map(f => f.trim()).filter(Boolean);
      if (!m || !fields.length) continue;
      c[m] = r.mode === 'show' ? { show: fields } : { hide: fields };
    }
    return Object.keys(c).length ? c : undefined;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const constraints = buildConstraints();
      const finalPermit: Permit = { ...permit, services: permit.services || {} };
      if (constraints) finalPermit.constraints = constraints;
      else delete finalPermit.constraints;   // 清空了所有约束 → 移除字段
      if (onSave) {
        await onSave(finalPermit);
      } else {
        await callRpc('user.permit.update', { uid: userId, permit: finalPermit });
      }
      toast.success('Permissions saved successfully');
      onSaveSuccess(finalPermit);
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save permissions');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-secondary rounded-lg p-6 w-[650px] h-[600px] shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex flex-col"
      >
        <div className="flex justify-between items-center mb-5">
          <div>
            <h3 className="m-0 text-base">{title || 'Edit Permissions'}: {userName}</h3>
            <div className="text-[11px] opacity-50 font-mono">{userId}</div>
          </div>
          <button
            onClick={onClose}
            className="bg-transparent border-none cursor-pointer text-lg opacity-60 hover:opacity-100 transition-opacity"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1">
          {/* Global Admin Toggle (hidden for bot accounts — §7.3 forbids allow_all) */}
          {!disallowAllowAll && (
            <div className={`p-3 rounded-md mb-5 border flex items-center justify-between ${permit.allow_all
                ? 'bg-green-500/10 border-green-500/30'
                : 'bg-white/[0.03] border-white/10'
              }`}>
              <div>
                <div className="font-semibold text-[13px]">Administrator Access</div>
                <div className="text-[11px] opacity-60">Grant skip-all permissions for this user (allow_all)</div>
              </div>
              <div
                onClick={() => setPermit(prev => ({ ...prev, allow_all: !prev.allow_all }))}
                className={`w-11 h-[22px] rounded-[11px] relative cursor-pointer transition-colors ${permit.allow_all ? 'bg-green-500' : 'bg-gray-600'
                  }`}
              >
                <div className={`w-[18px] h-[18px] bg-white rounded-full absolute top-[2px] transition-[left] ${permit.allow_all ? 'left-6' : 'left-[2px]'
                  }`} />
              </div>
            </div>
          )}

          {(!permit.allow_all || disallowAllowAll) && (
            <>
              <div className="flex justify-between items-center mb-3">
                <div className="font-semibold opacity-80 text-[13px]">Service Permissions:</div>
                <select
                  className="text-[11px] px-2 py-1 h-auto bg-accent border-none text-white rounded cursor-pointer"
                  value=""
                  onChange={(e) => {
                    const svcId = e.target.value;
                    if (!svcId) return;
                    setPermit(prev => ({
                      ...prev,
                      services: { ...prev.services, [svcId]: ['*'] }
                    }));
                  }}
                >
                  <option value="">+ ADD SERVICE</option>
                  {availableServices
                    .filter(s => !permit.services[s.id])
                    .map(s => (
                      <option key={s.id} value={s.id}>{s.id}</option>
                    ))
                  }
                </select>
              </div>

              <div className="flex flex-col gap-3">
                {Object.entries(permit.services || {})
                  .filter(([serviceId]) => !PERMIT_CONFIG.restrictedServices.includes(serviceId))
                  .map(([serviceId, allowedMethods]) => {
                    const serviceInfo = availableServices.find(s => s.id === serviceId);
                    const isAll = allowedMethods.includes('*');

                    return (
                      <div key={serviceId} className="p-4 bg-white/[0.02] rounded-lg border border-white/[0.06] flex flex-col gap-4">
                        <div className="flex justify-between items-center h-6">
                          <div className="flex items-center gap-6">
                            <div className="font-extrabold text-accent uppercase text-[13px] tracking-wide">{serviceId}</div>

                            <label className={`flex items-center gap-2 cursor-pointer select-none text-[11px] font-semibold transition-all ${isAll ? 'opacity-100 text-accent' : 'opacity-60 text-text-secondary'
                              }`}>
                              <input
                                type="checkbox"
                                checked={isAll}
                                onChange={(e) => {
                                  const newServices = { ...permit.services };
                                  if (e.target.checked) {
                                    newServices[serviceId] = ['*'];
                                  } else {
                                    newServices[serviceId] = [];
                                  }
                                  setPermit(prev => ({ ...prev, services: newServices }));
                                }}
                                className="m-0 w-3.5 h-3.5 cursor-pointer"
                              />
                              <span>ALL (*)</span>
                            </label>
                          </div>

                          <button
                            onClick={() => {
                              const newServices = { ...permit.services };
                              delete newServices[serviceId];
                              setPermit(prev => ({ ...prev, services: newServices }));
                            }}
                            className="bg-transparent border-none text-error cursor-pointer text-[11px] opacity-50 font-semibold px-2 py-1 rounded hover:opacity-100 transition-opacity"
                          >
                            REMOVE
                          </button>
                        </div>

                        {!isAll && serviceInfo && (
                          <div className="flex flex-col gap-5">
                            {Object.entries(groupMethodsByPrefix(serviceInfo.methods, serviceId)).map(([groupName, methods]) => (
                              <div key={groupName}>
                                <div className="flex justify-between items-center pb-2 mb-3 border-b border-white/5 h-6">
                                  <span className="text-[11px] opacity-30 uppercase tracking-widest font-extrabold">{groupName}</span>

                                  <label className="flex items-center gap-2 cursor-pointer select-none text-[10px] font-semibold opacity-60">
                                    <input
                                      type="checkbox"
                                      checked={methods.every(m => allowedMethods.includes(m.name))}
                                      onChange={(e) => {
                                        const newServices = { ...permit.services };
                                        let currentMethods = [...(newServices[serviceId] || [])];
                                        const groupMethodNames = methods.map(m => m.name);

                                        if (e.target.checked) {
                                          const toAdd = groupMethodNames.filter(name => !currentMethods.includes(name));
                                          currentMethods = [...currentMethods, ...toAdd];
                                        } else {
                                          currentMethods = currentMethods.filter(name => !groupMethodNames.includes(name));
                                        }

                                        newServices[serviceId] = currentMethods;
                                        setPermit(prev => ({ ...prev, services: newServices }));
                                      }}
                                      className="m-0 w-[13px] h-[13px] cursor-pointer"
                                    />
                                    SELECT ALL
                                  </label>
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                  {methods.map(method => {
                                    const isChecked = allowedMethods.includes(method.name);
                                    return (
                                      <label
                                        key={method.name}
                                        className={`flex items-center gap-2 text-[11px] px-3 py-2 rounded-md border cursor-pointer transition-all select-none overflow-hidden ${isChecked
                                            ? 'bg-accent/10 border-accent/30 text-accent'
                                            : 'bg-white/[0.02] border-white/[0.04] text-text-secondary'
                                          }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={(e) => {
                                            const newServices = { ...permit.services };
                                            let methodsList = [...(newServices[serviceId] || [])];
                                            if (e.target.checked) {
                                              methodsList.push(method.name);
                                            } else {
                                              methodsList = methodsList.filter(m => m !== method.name);
                                            }
                                            newServices[serviceId] = methodsList;
                                            setPermit(prev => ({ ...prev, services: newServices }));
                                          }}
                                          className="cursor-pointer m-0 w-[13px] h-[13px]"
                                        />
                                        <span className="truncate">
                                          {method.name.startsWith(`${serviceId}.${groupName}.`)
                                            ? method.name.substring(serviceId.length + groupName.length + 2)
                                            : method.name.replace(`${serviceId}.`, '')
                                          }
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </>
          )}

          {/* 数据级字段约束 —— Router 透传 constraints,library/fieldmask 在返回前按约束遮蔽字段 */}
          <div className="mt-6">
            <div className="font-semibold opacity-80 text-[13px] mb-1">数据级字段约束 (Field Constraints)</div>
            <div className="text-[11px] opacity-50 mb-3 leading-relaxed">
              按方法控制返回字段:<span className="text-accent">hide</span> = 隐藏所列字段,<span className="text-accent">show</span> = 只返回所列字段(show 优先)。method 用 <span className="font-mono">服务.实体.动作</span>(如 <span className="font-mono">collection.payment.list</span>),<span className="font-mono">*</span> 对所有方法生效。
            </div>
            <div className="flex flex-col gap-2">
              {constraintRows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    placeholder="method 或 *"
                    value={r.method}
                    onChange={(e) => updateConstraintRow(i, { method: e.target.value })}
                    className="flex-1 text-[11px] px-2 py-1.5 bg-white/[0.03] border border-white/10 rounded font-mono text-text-primary"
                  />
                  <select
                    value={r.mode}
                    onChange={(e) => updateConstraintRow(i, { mode: e.target.value as 'hide' | 'show' })}
                    className="text-[11px] px-2 py-1.5 bg-accent border-none text-white rounded cursor-pointer"
                  >
                    <option value="hide">hide</option>
                    <option value="show">show</option>
                  </select>
                  <input
                    placeholder="字段,逗号分隔 (amount, cost)"
                    value={r.fields}
                    onChange={(e) => updateConstraintRow(i, { fields: e.target.value })}
                    className="flex-[1.5] text-[11px] px-2 py-1.5 bg-white/[0.03] border border-white/10 rounded font-mono text-text-primary"
                  />
                  <button
                    onClick={() => setConstraintRows(rows => rows.filter((_, j) => j !== i))}
                    className="bg-transparent border-none text-error cursor-pointer text-sm opacity-50 hover:opacity-100 transition-opacity px-1"
                    title="移除"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setConstraintRows(rows => [...rows, { method: '', mode: 'hide', fields: '' }])}
                className="self-start text-[11px] px-3 py-1.5 bg-accent/80 hover:bg-accent text-white rounded font-semibold transition-colors mt-1"
              >
                + ADD CONSTRAINT
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            className="flex-1 bg-accent text-white border-none font-semibold rounded-md py-2 px-4 text-xs hover:bg-[#1f6feb] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isSaving}
            onClick={handleSave}
          >
            {isSaving ? 'SAVING...' : 'SAVE CHANGES'}
          </button>
          <button
            className="flex-1 bg-white/5 border border-white/10 text-text-primary rounded-md py-2 px-4 text-xs hover:bg-white/10 transition-colors"
            onClick={onClose}
          >
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}
