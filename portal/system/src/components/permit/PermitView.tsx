import type { Permit } from '../../types';

/**
 * Read-only permit renderer — the viewing counterpart of PermitEditorModal, in the
 * SAME visual language (service cards, accent service names, method chips), so a
 * permit looks identical whether you're editing it (User/Bot pages) or inspecting
 * it (sentinel PERMIT modal). Replaces ad-hoc raw-JSON dumps.
 */
export default function PermitView({ permit }: { permit: Permit | null | undefined }) {
  if (!permit) {
    return <div className="text-[12px] text-text-secondary italic opacity-60">(no permit)</div>;
  }

  const services = Object.entries(permit.services || {});
  const constraints = Object.entries(permit.constraints || {});

  return (
    <div className="flex flex-col gap-3" data-test="permit-view">
      {permit.allow_all && (
        <div className="p-3 rounded-md border bg-green-500/10 border-green-500/30">
          <div className="font-semibold text-[13px]">Administrator Access (allow_all)</div>
          <div className="text-[11px] opacity-60">Skips per-method checks — every service method is allowed.</div>
        </div>
      )}

      {!permit.allow_all && services.length === 0 && (
        <div className="text-[12px] text-text-secondary italic opacity-60">
          Empty permit — no service methods granted.
        </div>
      )}

      {!permit.allow_all && services.map(([serviceId, methods]) => {
        const isAll = methods.includes('*');
        return (
          <div key={serviceId} className="p-3 bg-white/[0.02] rounded-lg border border-white/[0.06] flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <div className="font-extrabold text-accent uppercase text-[12px] tracking-wide">{serviceId}</div>
              {isAll && (
                <span className="text-[10px] px-1.5 py-0.5 border rounded border-accent/30 text-accent bg-accent/10 font-semibold">ALL (*)</span>
              )}
            </div>
            {!isAll && (
              <div className="flex flex-wrap gap-1.5">
                {methods.length === 0 ? (
                  <span className="text-[11px] text-text-secondary italic opacity-60">(no methods)</span>
                ) : (
                  methods.map(m => (
                    <span key={m} title={m}
                      className="text-[10px] px-2 py-1 rounded-md border bg-white/[0.02] border-white/[0.06] text-text-secondary font-mono">
                      {m.startsWith(`${serviceId}.`) ? m.substring(serviceId.length + 1) : m}
                    </span>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {constraints.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="font-semibold opacity-80 text-[12px]">数据级字段约束 (Field Constraints)</div>
          {constraints.map(([method, rule]) => (
            <div key={method} className="flex items-center gap-2 text-[11px]">
              <code className="font-mono text-text-secondary">{method}</code>
              <span className={`text-[9px] px-1.5 py-0.5 border rounded ${rule.show
                ? 'border-accent/30 text-accent bg-accent/10'
                : 'border-warning/30 text-warning bg-warning/10'}`}>
                {rule.show ? 'show' : 'hide'}
              </span>
              <span className="font-mono text-[10px] text-text-secondary truncate">
                {(rule.show || rule.hide || []).join(', ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
