import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { callRpc } from '../utils/rpc';
import { copyToClipboard } from '../utils/format';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { Button, IconButton } from '../components/ui';

/**
 * Users (external principals / passport) — authority.md.
 * External principals are managed here in the OPERATOR console, separate from internal
 * users/bots (system console) — mirroring the internal/external identity isolation.
 *
 * The list is the primary surface; the two config/onboard flows live behind toolbar
 * buttons that open modals (consistent with the rest of the operator).
 */
interface Principal {
  id: string;
  role: string;
  app?: string;
  name?: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt?: string;
}

function genDeviceToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

const label: React.CSSProperties = { display: 'block', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary, #64748b)', marginBottom: '4px' };
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: '13px', border: '1px solid #e2e8f0', borderRadius: '6px', outline: 'none', boxSizing: 'border-box' };

// ── Modal shell ────────────────────────────────────────────────────────────────
function Modal({ title, onClose, width = 560, closeOnOverlay = true, children }: {
  title: string; onClose: () => void; width?: number; closeOnOverlay?: boolean; children: React.ReactNode;
}) {
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => closeOnOverlay && onClose()}>
      <div style={{ background: '#fff', borderRadius: 12, width, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, color: '#1e293b' }}>{title}</span>
          <IconButton variant="ghost" onClick={onClose} style={{ fontSize: 18 }}>×</IconButton>
        </div>
        <div style={{ padding: 20, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>,
    document.body
  );
}

// ── Define-role modal (external role = method allow-list + owner field) ──────────
function RolesModal({ onClose }: { onClose: () => void }) {
  const { toast } = useUI();
  const { t } = useLang();
  const [role, setRole] = useState('');
  const [services, setServices] = useState('{\n  "collection": ["collection.payment.list", "collection.payment.get"]\n}');
  const [ownerField, setOwnerField] = useState('ownerId');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!role.trim()) return toast.error(t('passport.err_role_required'));
    let parsed: any;
    try { parsed = JSON.parse(services); } catch { return toast.error(t('passport.err_invalid_json')); }
    setSaving(true);
    try {
      await callRpc('user.role.set', { role: role.trim(), services: parsed, ownerField: ownerField.trim() || undefined, scope: 'external' });
      toast.success(`Role "${role}" saved`);
      onClose();
    } catch (e: any) { toast.error(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={t('passport.step1')} onClose={onClose} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
        <div><label style={label}>Role</label><input style={input} value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('passport.ph_role')} autoFocus /></div>
        <div><label style={label}>Owner field (row isolation)</label><input style={input} value={ownerField} onChange={(e) => setOwnerField(e.target.value)} placeholder={t('passport.ph_owner_field')} /></div>
      </div>
      <label style={label}>{t('passport.label_services')}</label>
      <textarea style={{ ...input, fontFamily: 'var(--font-mono, monospace)', minHeight: '120px', resize: 'vertical' }} value={services} onChange={(e) => setServices(e.target.value)} />
      <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={save} loading={saving}>{t('passport.btn_save_role')}</Button>
      </div>
    </Modal>
  );
}

// ── Onboard modal (binds role, issues a one-time device credential) ──────────────
function OnboardModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useUI();
  const { t } = useLang();
  const [oAnchor, setOAnchor] = useState('');
  const [oRole, setORole] = useState('');
  const [oApp, setOApp] = useState('');
  const [oName, setOName] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ anchor: string; deviceId: string; deviceToken: string } | null>(null);

  const onboard = async () => {
    if (!oAnchor.trim() || !oRole.trim()) return toast.error('Anchor and role are required');
    setBusy(true);
    const deviceToken = genDeviceToken();
    try {
      const r = await callRpc<{ anchor: string; deviceId: string }>('user.passport.register', {
        anchor: oAnchor.trim(), role: oRole.trim(), app: oApp.trim() || undefined, name: oName.trim() || undefined, deviceToken,
      });
      setIssued({ anchor: r.anchor, deviceId: r.deviceId, deviceToken });
      toast.success(`Onboarded "${r.anchor}"`);
      onDone();
    } catch (e: any) { toast.error(e.message || 'Onboard failed'); }
    finally { setBusy(false); }
  };

  const copyAll = async () => {
    if (!issued) return;
    const ok = await copyToClipboard(`anchor: ${issued.anchor}\ndeviceId: ${issued.deviceId}\ndeviceToken: ${issued.deviceToken}`);
    if (ok) toast.success(t('common.copied', { defaultValue: 'Copied' }));
  };

  // Once the one-time credential is shown, don't let an overlay click discard it silently.
  return (
    <Modal title={t('passport.step2')} onClose={onClose} width={620} closeOnOverlay={!issued}>
      {!issued ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div><label style={label}>Anchor (stable id)</label><input style={input} value={oAnchor} onChange={(e) => setOAnchor(e.target.value)} placeholder={t('passport.ph_anchor')} autoFocus /></div>
            <div><label style={label}>Role</label><input style={input} value={oRole} onChange={(e) => setORole(e.target.value)} placeholder={t('passport.ph_role')} /></div>
            <div><label style={label}>App (external app/tenant)</label><input style={input} value={oApp} onChange={(e) => setOApp(e.target.value)} placeholder={t('passport.ph_app')} /></div>
            <div><label style={label}>Name (optional)</label><input style={input} value={oName} onChange={(e) => setOName(e.target.value)} placeholder={t('passport.ph_name')} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={onboard} loading={busy}>{t('passport.btn_onboard')}</Button>
          </div>
        </>
      ) : (
        <div>
          <div style={{ padding: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', fontSize: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '8px', color: '#166534' }}>{t('passport.device_credential_note')}</div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)' }}>{t('passport.label_anchor')}{issued.anchor}</div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)' }}>{t('passport.label_device_id')}{issued.deviceId}</div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>{t('passport.label_device_token')}{issued.deviceToken}</div>
          </div>
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <Button variant="secondary" size="sm" onClick={copyAll}>{t('common.copy', { defaultValue: 'Copy' })}</Button>
            <Button variant="primary" size="sm" onClick={onClose}>{t('common.done', { defaultValue: 'Done' })}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Detail modal (read-only inspector — shows the full passport record) ──────────
// There is no backend `passport.update`; re-onboarding is the only mutation path (and
// it mints a fresh device), so this surface is deliberately read-only. It exists so an
// operator can SEE what a principal's record actually holds (role/app/name/meta/devices).
interface PassportFull extends Principal {
  meta?: Record<string, unknown>;
  updatedAt?: string;
  devices?: string[];
}
const kvKey: React.CSSProperties = { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary, #64748b)' };
const kvVal: React.CSSProperties = { fontSize: '13px', color: '#1e293b', fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' };

function DetailModal({ anchor, onClose }: { anchor: string; onClose: () => void }) {
  const { toast } = useUI();
  const { t } = useLang();
  const [rec, setRec] = useState<PassportFull | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await callRpc<PassportFull>('user.passport.get', { anchor });
        if (alive) setRec(r);
      } catch (e: any) { if (alive) setErr(e.message || t('passport.err_load')); }
    })();
    return () => { alive = false; };
  }, [anchor, t]);

  const copyRaw = async () => {
    if (!rec) return;
    const ok = await copyToClipboard(JSON.stringify(rec, null, 2));
    if (ok) toast.success(t('common.copied', { defaultValue: 'Copied' }));
  };

  const metaEmpty = !rec?.meta || Object.keys(rec.meta).length === 0;

  return (
    <Modal title={`${t('passport.detail_title')} · ${anchor}`} onClose={onClose} width={620}>
      {err ? (
        <div style={{ padding: '12px', background: '#fef2f2', border: '1px solid #fee2e2', color: '#b91c1c', borderRadius: '8px', fontSize: '13px' }}>⚠️ {err}</div>
      ) : !rec ? (
        <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: '12px', columnGap: '16px', alignItems: 'baseline' }}>
            <div style={kvKey}>{t('passport.col_anchor')}</div><div style={kvVal}>{rec.id}</div>
            <div style={kvKey}>{t('passport.col_role')}</div><div style={kvVal}>{rec.role}</div>
            <div style={kvKey}>{t('passport.col_app')}</div><div style={kvVal}>{rec.app || '—'}</div>
            <div style={kvKey}>{t('passport.col_name')}</div><div style={{ ...kvVal, fontFamily: 'inherit' }}>{rec.name || '—'}</div>
            <div style={kvKey}>{t('common.status')}</div>
            <div><span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: rec.status === 'ACTIVE' ? '#dcfce7' : '#fee2e2', color: rec.status === 'ACTIVE' ? '#166534' : '#991b1b' }}>{rec.status}</span></div>
            <div style={kvKey}>{t('passport.detail_created')}</div><div style={{ ...kvVal, fontFamily: 'inherit', color: '#64748b' }}>{rec.createdAt || '—'}</div>
            <div style={kvKey}>{t('passport.detail_updated')}</div><div style={{ ...kvVal, fontFamily: 'inherit', color: '#64748b' }}>{rec.updatedAt || '—'}</div>
          </div>

          <div style={{ marginTop: '20px' }}>
            <label style={label}>{t('passport.detail_devices')} ({rec.devices?.length || 0})</label>
            {rec.devices && rec.devices.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {rec.devices.map((d) => (
                  <code key={d} style={{ fontSize: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '6px 10px', color: '#334155', wordBreak: 'break-all' }}>{d}</code>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: '#94a3b8' }}>{t('passport.detail_no_devices')}</div>
            )}
          </div>

          <div style={{ marginTop: '20px' }}>
            <label style={label}>{t('passport.detail_meta')}</label>
            {metaEmpty
              ? <div style={{ fontSize: '12px', color: '#94a3b8' }}>{'{}'}</div>
              : <pre style={{ margin: 0, fontSize: '12px', background: '#0f172a', color: '#38bdf8', padding: '12px', borderRadius: '8px', overflowX: 'auto', fontFamily: 'var(--font-mono, monospace)' }}>{JSON.stringify(rec.meta, null, 2)}</pre>}
          </div>

          <div style={{ marginTop: '16px', fontSize: '11px', color: '#94a3b8', lineHeight: 1.5 }}>{t('passport.detail_hint')}</div>

          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <Button variant="secondary" size="sm" onClick={copyRaw}>{t('passport.detail_raw')}</Button>
            <Button variant="primary" size="sm" onClick={onClose}>{t('common.done', { defaultValue: 'Done' })}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────────
export default function PassportManagement() {
  const { toast, confirm } = useUI();
  const { t } = useLang();

  const [list, setList] = useState<Principal[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<'onboard' | 'roles' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);   // anchor under inspection

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await callRpc<{ items: Principal[] }>('user.passport.list');
      setList(r.items || []);
    } catch (e: any) {
      toast.error(e.message || t('passport.err_load'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchList(); }, [fetchList]);

  const handleDisable = async (p: Principal) => {
    const ok = await confirm({ title: t('passport.confirm_disable_title'), message: t('passport.confirm_disable_msg', { id: p.id }), confirmLabel: t('passport.btn_disable'), isDangerous: true });
    if (!ok) return;
    try {
      const r = await callRpc<{ revoked: number }>('user.passport.disable', { anchor: p.id });
      toast.success(`Disabled (${r.revoked} session(s) revoked)`);
      fetchList();
    } catch (e: any) { toast.error(e.message || 'Disable failed'); }
  };

  return (
    <div className="service-mgr-container">
      <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('passport.title')}</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button variant="primary" size="sm" onClick={() => setModal('onboard')}>+ {t('passport.action_onboard')}</Button>
            <Button variant="secondary" size="sm" onClick={() => setModal('roles')}>{t('passport.action_roles')}</Button>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary, #64748b)', margin: '0 4px' }}>
              {t('passport.list_title')}{loading ? '…' : `(${list.length})`}
            </span>
            <Button variant="secondary" size="sm" onClick={fetchList}>{t('common.refresh')}</Button>
          </div>
        </div>

        <div className="panel-content" style={{ flex: 1, padding: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary, #64748b)', padding: '12px 24px', borderBottom: '1px solid #f1f5f9' }}>
            {t('passport.description')}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary, #64748b)', fontSize: '11px', textTransform: 'uppercase', background: '#f8fafc' }}>
                <th style={{ padding: '12px 24px' }}>{t('passport.col_anchor')}</th><th style={{ padding: '12px 24px' }}>{t('passport.col_role')}</th><th style={{ padding: '12px 24px' }}>{t('passport.col_app')}</th><th style={{ padding: '12px 24px' }}>{t('passport.col_name')}</th><th style={{ padding: '12px 24px' }}>{t('common.status')}</th><th style={{ padding: '12px 24px' }} />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9', cursor: 'pointer' }} onClick={() => setDetail(p.id)}>
                  <td style={{ padding: '12px 24px', fontFamily: 'var(--font-mono, monospace)', color: 'var(--accent-color, #2563eb)' }}>{p.id}</td>
                  <td style={{ padding: '12px 24px' }}>{p.role}</td>
                  <td style={{ padding: '12px 24px' }}>{p.app || '—'}</td>
                  <td style={{ padding: '12px 24px' }}>{p.name || '—'}</td>
                  <td style={{ padding: '12px 24px' }}>
                    <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: p.status === 'ACTIVE' ? '#dcfce7' : '#fee2e2', color: p.status === 'ACTIVE' ? '#166534' : '#991b1b' }}>{p.status}</span>
                  </td>
                  <td style={{ padding: '12px 24px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'inline-flex', gap: '8px' }}>
                      <Button variant="secondary" size="sm" onClick={() => setDetail(p.id)}>{t('passport.btn_view')}</Button>
                      {p.status === 'ACTIVE' && <Button variant="danger" size="sm" onClick={() => handleDisable(p)}>{t('passport.btn_disable_row')}</Button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && list.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>{t('passport.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'onboard' && <OnboardModal onClose={() => setModal(null)} onDone={fetchList} />}
      {modal === 'roles' && <RolesModal onClose={() => setModal(null)} />}
      {detail && <DetailModal anchor={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
