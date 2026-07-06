import { useState } from 'react';
import type { Action, TaskAction, WorkflowAction } from './types';
import { DelBtn } from './types';

function ParamsField({ label, value, onChange }: { label: string; value: any; onChange: (v: any) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [err, setErr] = useState(false);
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '40px', flexShrink: 0, paddingTop: '5px' }}>{label}</span>
      <textarea value={text} rows={3} onChange={e => {
        setText(e.target.value);
        try { onChange(JSON.parse(e.target.value)); setErr(false); } catch { setErr(true); }
      }} style={{ flex: 1, fontSize: '11px', fontFamily: 'var(--font-mono)', resize: 'vertical', lineHeight: 1.5,
        borderColor: err ? '#fca5a5' : undefined, background: err ? '#fff7f7' : undefined }} />
    </div>
  );
}

export function ActionEditor({ action, onChange, onDelete }: {
  action: Action; onChange: (a: Action) => void; onDelete: () => void;
}) {
  const isWorkflow = action.type === 'workflow';

  return (
    <div style={{ background: '#fff', border: '1px solid var(--border-color)', borderRadius: '7px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {/* type toggle + delete */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        {(['task', 'workflow'] as const).map(t => (
          <button key={t} onClick={() => {
            if (t === 'task') onChange({ type: 'task', service: '', method: '', params: { sourceId: { var: 'instance.sourceId' } } });
            else onChange({ type: 'workflow', workflowId: '', input: { instanceId: { var: 'instance.id' }, sourceId: { var: 'instance.sourceId' } }, on_complete: { event: '', meta_patch: {} } });
          }} style={{
            padding: '2px 10px', fontSize: '10px', fontWeight: 700, borderRadius: '4px', cursor: 'pointer', border: '1px solid',
            background: action.type === t ? '#f1f5f9' : 'transparent',
            color: action.type === t ? 'var(--text-primary)' : 'var(--text-secondary)',
            borderColor: action.type === t ? '#cbd5e1' : 'var(--border-color)',
          }}>{t}</button>
        ))}
        <div style={{ flex: 1 }} />
        <DelBtn onClick={onDelete} />
      </div>

      {!isWorkflow ? (
        <>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '40px', flexShrink: 0 }}>method</span>
            <input value={(action as TaskAction).method} onChange={e => onChange({ ...action as TaskAction, method: e.target.value })}
              placeholder="erp.order.sync" style={{ flex: 1, fontSize: '12px', fontFamily: 'var(--font-mono)' }} />
          </div>
          <ParamsField label="params" value={(action as TaskAction).params}
            onChange={v => onChange({ ...action as TaskAction, params: v })} />
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '40px', flexShrink: 0 }}>id</span>
            <input value={(action as WorkflowAction).workflowId} onChange={e => onChange({ ...action as WorkflowAction, workflowId: e.target.value })}
              placeholder="erp-sync-on-deposit" style={{ flex: 1, fontSize: '12px', fontFamily: 'var(--font-mono)' }} />
          </div>
          <ParamsField label="input" value={(action as WorkflowAction).input}
            onChange={v => onChange({ ...action as WorkflowAction, input: v })} />
          <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>ON_COMPLETE</span>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '40px', flexShrink: 0 }}>event</span>
              <input value={(action as WorkflowAction).on_complete.event}
                onChange={e => onChange({ ...action as WorkflowAction, on_complete: { ...(action as WorkflowAction).on_complete, event: e.target.value } })}
                placeholder="erp_synced" style={{ flex: 1, fontSize: '12px', fontFamily: 'var(--font-mono)' }} />
            </div>
            <ParamsField label="patch" value={(action as WorkflowAction).on_complete.meta_patch}
              onChange={v => onChange({ ...action as WorkflowAction, on_complete: { ...(action as WorkflowAction).on_complete, meta_patch: v } })} />
          </div>
        </>
      )}
    </div>
  );
}
