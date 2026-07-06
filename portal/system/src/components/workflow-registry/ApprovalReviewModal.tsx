import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/**
 * Approval review + sign-off (VERSION.md §3.3 — 盲签禁令).
 *
 * Shows EXACTLY what an approver is signing — the footprint (every step/resolver
 * method), event subscriptions (what can trigger it), input schema, the derived
 * risk level, and a diff against the previously-approved version — before any
 * signature. LOW-risk → one-click approve (C1 fast lane). HIGH-risk → the operator
 * types their password, which signs the definition digest (user.key.sign) and
 * submits it to the multi-sig gate. No browser dialogs (CLAUDE.md §8).
 */

interface Props {
  workflowId: string;
  onClose: () => void;
  onDone: () => void;   // refresh the list after a terminal action
}

type Phase = 'loading' | 'review' | 'sign' | 'working';

export default function ApprovalReviewModal({ workflowId, onClose, onDone }: Props) {
  const { toast } = useUI();
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>('loading');
  const [wf, setWf] = useState<any>(null);
  const [prev, setPrev] = useState<any>(null);   // previous version snapshot (for diff)
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [progress, setProgress] = useState<{ signed: number; required: number } | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const doc = await callRpc<any>('orchestrator.workflow.get', { id: workflowId });
      setWf(doc);
      if ((doc.version || 1) > 1) {
        try { setPrev(await callRpc<any>('orchestrator.workflow.version', { id: workflowId, version: (doc.version || 1) - 1 })); }
        catch { /* no prior snapshot — treat as initial */ }
      }
      setPhase('review');
    } catch (e: any) {
      toast.error(e.message || t('approval.toast_load_failed'));
      onClose();
    }
  }, [workflowId, toast, onClose, t]);

  useEffect(() => { load(); }, [load]);

  const footprint: string[] = wf ? [
    ...(wf.steps || []).map((s: any) => (s.method && s.method.startsWith(`${s.service}.`)) ? s.method : `${s.service}.${s.method}`),
    ...Object.values(wf.resolvers || {}).map((r: any) => r && r.method).filter(Boolean),
  ] : [];

  const isHigh = wf?.risk_level === 'HIGH';

  const changedFields = (() => {
    if (!prev) return null;
    const keys = ['steps', 'event_subscriptions', 'input_schema'];
    return keys.filter(k => JSON.stringify(wf?.[k] || null) !== JSON.stringify(prev?.[k] || null));
  })();

  // ── actions ────────────────────────────────────────────────────────────────
  const approveLow = async () => {
    setPhase('working');
    try {
      await callRpc('orchestrator.workflow.approve', { id: workflowId });
      toast.success(t('approval.toast_approved_active'));
      onDone(); onClose();
    } catch (e: any) {
      setPhase('review');
      toast.error(e.message?.includes('submitter') ? t('approval.toast_self') : (e.message || t('approval.toast_approve_failed')));
    }
  };

  const signAndApprove = async () => {
    if (!password.trim()) { setPwError(t('approval.err_password_required')); return; }
    setPwError('');
    setPhase('working');
    try {
      const need = await callRpc<any>('orchestrator.workflow.approve', { id: workflowId });
      if (need.status !== 'NEEDS_SIGNATURE') {
        toast.success(t('approval.toast_approved_active')); onDone(); onClose(); return;
      }
      let signature: string;
      try {
        const signed = await callRpc<any>('user.key.sign', { digest: need.digest, password });
        signature = signed.signature;
      } catch (e: any) {
        if (String(e.message || '').match(/not found|generate one first/i)) {
          await callRpc('user.key.generate', { password });
          const signed = await callRpc<any>('user.key.sign', { digest: need.digest, password });
          signature = signed.signature;
        } else if (String(e.message || '').match(/password|signature/i)) {
          setPhase('sign'); setPwError(t('approval.err_bad_password')); return;
        } else { throw e; }
      }
      const res = await callRpc<any>('orchestrator.workflow.approve', { id: workflowId, signature });
      if (res.success) {
        toast.success(res.effective_at ? t('approval.toast_cooling') : t('approval.toast_approved_active'));
        onDone(); onClose();
      } else {
        setProgress({ signed: res.signed, required: res.required });
        setPhase('review');
        toast.info(t('approval.toast_progress', { signed: res.signed, required: res.required }));
      }
    } catch (e: any) {
      setPhase('review');
      toast.error(e.message?.includes('submitter') ? t('approval.toast_self_sign') : (e.message || t('approval.toast_sign_failed')));
    } finally {
      setPassword('');
    }
  };

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999] backdrop-blur-sm" onClick={onClose}>
      <div className="w-[760px] max-h-[85vh] flex flex-col bg-bg-primary border border-border rounded-lg shadow-[0_12px_48px_rgba(0,0,0,0.6)]" onClick={e => e.stopPropagation()} data-test="approval-review-modal">
        <div className="px-5 py-3 border-b border-border flex justify-between items-center bg-white/[0.03]">
          <div className="font-mono text-[13px] uppercase tracking-wider text-accent">{t('approval.title')}</div>
          <button className="text-text-secondary hover:text-text-primary" onClick={onClose}>✕</button>
        </div>

        {phase === 'loading' && <div className="p-8 text-center text-text-secondary">{t('approval.loading')}</div>}

        {wf && phase !== 'loading' && (
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4 text-[13px]">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-base text-text-primary">{wf.name}</div>
                <div className="text-[11px] text-text-secondary font-mono">{wf.id} · v{wf.version} · {t('approval.submitted_by', { who: wf.submittedBy || '—' })}</div>
              </div>
              <span data-test="risk-badge" className={`text-[11px] px-2 py-1 border rounded font-mono ${isHigh ? 'text-warning border-warning' : 'text-success border-success'}`}>
                {isHigh ? t('approval.risk_high') : t('approval.risk_low')}
              </span>
            </div>

            {isHigh && Array.isArray(wf.risk_reasons) && wf.risk_reasons.length > 0 && (
              <div className="text-[11px] text-warning font-mono border border-warning/40 rounded px-3 py-2">
                {wf.risk_reasons.slice(0, 6).map((r: string, i: number) => <div key={i}>• {r}</div>)}
              </div>
            )}

            {changedFields !== null && (
              <div data-test="diff-section" className="text-[11px] font-mono border border-border rounded px-3 py-2">
                <span className="text-text-secondary">{t('approval.changed_since', { v: (wf.version || 1) - 1 })} </span>
                {changedFields.length === 0
                  ? <span className="text-success">{t('approval.no_change')}</span>
                  : <span className="text-warning">{changedFields.join(', ')}</span>}
              </div>
            )}

            <div data-test="footprint-section">
              <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">{t('approval.footprint', { n: footprint.length })}</div>
              <div className="flex flex-col gap-1 font-mono text-[12px]">
                {footprint.length === 0 && <span className="text-text-secondary">{t('approval.no_methods')}</span>}
                {footprint.map((m, i) => <div key={i} className="px-2 py-1 bg-bg-secondary border border-border rounded">{m}</div>)}
              </div>
            </div>

            <div data-test="subscriptions-section">
              <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">{t('approval.subscriptions')}</div>
              {(wf.event_subscriptions || []).length === 0
                ? <div className="text-text-secondary text-[12px]">{t('approval.no_subs')}</div>
                : (wf.event_subscriptions || []).map((s: any, i: number) => (
                    <div key={i} className="font-mono text-[12px] px-2 py-1 bg-bg-secondary border border-border rounded">
                      {s.stream}{s.filter ? ` · ${JSON.stringify(s.filter)}` : ''}
                    </div>
                  ))}
            </div>

            <div data-test="input-schema-section">
              <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">{t('approval.input_schema')}</div>
              {(wf.input_schema || []).length === 0
                ? <div className="text-text-secondary text-[12px]">{t('approval.no_schema')}</div>
                : (wf.input_schema || []).map((f: any, i: number) => (
                    <div key={i} className="font-mono text-[12px] text-text-secondary">
                      {f.name}{f.required ? '*' : ''}{f.type ? `: ${f.type}` : ''}{f.pattern ? ` /${f.pattern}/` : ''}
                    </div>
                  ))}
            </div>

            {isHigh && phase === 'sign' && (
              <div className="border-t border-border pt-3" data-test="password-section">
                <div className="text-[11px] uppercase tracking-wider text-text-secondary mb-1">{t('approval.sign_label')}</div>
                <div className="text-[11px] text-text-secondary mb-2">{t('approval.sign_hint')}</div>
                <Input type="password" value={password} error={pwError} placeholder={t('approval.password_ph')}
                       onChange={(e) => setPassword(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') signAndApprove(); }} />
              </div>
            )}

            {progress && (
              <div className="text-[12px] text-warning font-mono">{t('approval.signatures', { signed: progress.signed, required: progress.required })}</div>
            )}
          </div>
        )}

        {wf && phase !== 'loading' && (
          <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={phase === 'working'}>{t('approval.cancel')}</Button>
            {!isHigh && (
              <Button variant="success" data-test="approve-low" onClick={approveLow} isLoading={phase === 'working'}>{t('approval.approve')}</Button>
            )}
            {isHigh && phase !== 'sign' && (
              <Button variant="danger" data-test="approve-high" onClick={() => setPhase('sign')} disabled={phase === 'working'}>{t('approval.approve_sign')}</Button>
            )}
            {isHigh && phase === 'sign' && (
              <Button variant="danger" data-test="sign-submit" onClick={signAndApprove} isLoading={(phase as Phase) === 'working'}>{t('approval.sign_submit')}</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
