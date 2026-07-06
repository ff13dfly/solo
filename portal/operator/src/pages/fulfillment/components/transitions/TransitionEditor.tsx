import { useState } from 'react';
import type { Transition, Action, MetaField, StateMeta } from './types';
import { SYSTEM_STATES, Row } from './types';
import { ConditionEditor } from './ConditionEditor';
import { ActionEditor } from './ActionEditor';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button } from '../../../../components/ui';

type TransitionTab = 'trigger' | 'condition' | 'actions';

export function TransitionEditor({ transition, onChange, metaFields, states, stateMeta }: {
  transition: Transition; onChange: (t: Transition) => void;
  metaFields: MetaField[]; states: string[]; stateMeta?: Record<string, StateMeta>;
}) {
  const { t } = useLang();
  const tr = t; // alias: the tab .map() below shadows `t` with the tab string
  const [tab, setTab] = useState<TransitionTab>('trigger');
  const base = (states.length ? states : []).filter(s => !SYSTEM_STATES.includes(s));
  const extra = [transition.from, transition.to].filter(s => s && !SYSTEM_STATES.includes(s) && !base.includes(s));
  const stateList = extra.length ? [...base, ...extra] : base;
  const stateLabel = (s: string) => stateMeta?.[s]?.label?.zh ? `${stateMeta[s].label.zh} (${s})` : s;
  const actions = transition.actions ?? [];

  const addAction = () => onChange({ ...transition, actions: [...actions, { type: 'workflow', workflowId: '', input: { instanceId: { var: 'instance.id' }, sourceId: { var: 'instance.sourceId' } }, on_complete: { event: '', meta_patch: {} } }] });
  const updAction = (i: number, a: Action) => onChange({ ...transition, actions: actions.map((x, idx) => idx === i ? a : x) });
  const delAction = (i: number) => onChange({ ...transition, actions: actions.filter((_, idx) => idx !== i) });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', padding: '0 16px', flexShrink: 0 }}>
        {(['trigger', 'condition', 'actions'] as TransitionTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`tab-btn${tab === t ? ' active' : ''}`}>
            {t === 'trigger' ? tr('fulfillment.tab_trigger') : t === 'condition' ? tr('fulfillment.tab_condition') : tr('fulfillment.tab_actions')}
            {t === 'condition' && transition.condition && <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block', marginLeft: '6px' }} />}
            {t === 'actions' && actions.length > 0 && <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '4px' }}>{actions.length}</span>}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {tab === 'trigger' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <Row label="event">
              <input value={transition.event} onChange={e => onChange({ ...transition, event: e.target.value })}
                placeholder={t('fulfillment.transitionEditor.eventPlaceholder')} style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
            </Row>
            <Row label="from">
              <select value={transition.from} onChange={e => onChange({ ...transition, from: e.target.value })} style={{ flex: 1, fontSize: '11px' }}>
                {stateList.map(s => <option key={s} value={s}>{stateLabel(s)}</option>)}
              </select>
              <span style={{ fontSize: '12px', color: '#cbd5e1', flexShrink: 0 }}>→</span>
              <select value={transition.to} onChange={e => onChange({ ...transition, to: e.target.value })} style={{ flex: 1, fontSize: '11px' }}>
                {stateList.map(s => <option key={s} value={s}>{stateLabel(s)}</option>)}
              </select>
            </Row>
          </div>
        )}

        {tab === 'condition' && (
          <ConditionEditor key={`${transition.from}-${transition.to}-${transition.event}`}
            condition={transition.condition ?? null}
            onChange={c => onChange({ ...transition, condition: c })}
            metaFields={metaFields} />
        )}

        {tab === 'actions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {actions.length === 0
              ? <div style={{ padding: '14px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: '7px', color: '#94a3b8', fontSize: '12px', background: '#fafafa' }}>{t('fulfillment.transitionEditor.noDownstreamActions')}</div>
              : actions.map((a, i) => <ActionEditor key={i} action={a} onChange={u => updAction(i, u)} onDelete={() => delAction(i)} />)
            }
            <Button variant="secondary" size="sm" onClick={addAction} style={{ alignSelf: 'flex-start' }}>+ {t('common.add')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
