import { useState } from 'react';
import type { MetaField } from './types';
import { CONDITION_OP_VALUES, buildConditionOps, buildFieldGroups } from './types';
import { useLang } from '../../../../providers/LanguageProvider';
import { Button, IconButton } from '../../../../components/ui';

// ─── JsonLogic helpers ────────────────────────────────────────────────────────

interface CondRule { field: string; op: string; valueType: 'literal' | 'var'; value: string; }
interface CondState { combinator: 'and' | 'or'; rules: CondRule[]; }

function parseVal(v: string): any {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v); return isNaN(n) ? v : n;
}

function toJL(c: CondState): any {
  if (!c.rules.length) return null;
  const ex = c.rules.map(r => r.op === '!!'
    ? { '!!': [{ var: r.field }] }
    : { [r.op]: [{ var: r.field }, r.valueType === 'var' ? { var: r.value } : parseVal(r.value)] }
  );
  return ex.length === 1 ? ex[0] : { [c.combinator]: ex };
}

function fromJL(logic: any): CondState | null {
  if (!logic) return { combinator: 'and', rules: [] };
  const ops = CONDITION_OP_VALUES;
  if (logic['!!']?.[0]?.var)
    return { combinator: 'and', rules: [{ field: logic['!!'][0].var, op: '!!', valueType: 'literal', value: '' }] };
  for (const op of ops) {
    if (op === '!!') continue;
    if (logic[op]?.length === 2 && logic[op][0]?.var) {
      const [l, r] = logic[op];
      const isVar = typeof r === 'object' && r?.var;
      return { combinator: 'and', rules: [{ field: l.var, op, valueType: isVar ? 'var' : 'literal', value: isVar ? r.var : String(r) }] };
    }
  }
  for (const comb of ['and', 'or'] as const) {
    if (!logic[comb]) continue;
    const rules: CondRule[] = [];
    for (const expr of logic[comb]) {
      if (expr['!!']?.[0]?.var) { rules.push({ field: expr['!!'][0].var, op: '!!', valueType: 'literal', value: '' }); continue; }
      let hit = false;
      for (const op of ops) {
        if (op === '!!' || !expr[op] || !expr[op][0]?.var) continue;
        const [l, r] = expr[op]; const isVar = typeof r === 'object' && r?.var;
        rules.push({ field: l.var, op, valueType: isVar ? 'var' : 'literal', value: isVar ? r.var : String(r) });
        hit = true; break;
      }
      if (!hit) return null;
    }
    return { combinator: comb, rules };
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConditionEditor({ condition, onChange, metaFields = [] }: {
  condition: any; onChange: (c: any) => void; metaFields?: MetaField[];
}) {
  const { t } = useLang();
  const conditionOps = buildConditionOps(t);
  const fieldGroups = buildFieldGroups(metaFields, t);
  const allFields = fieldGroups.flatMap(g => g.fields);
  const parsed = fromJL(condition);
  const [cond, setCond] = useState<CondState>(parsed ?? { combinator: 'and', rules: [] });
  const [showRaw, setShowRaw] = useState(parsed === null);
  const [rawText, setRawText] = useState(condition ? JSON.stringify(condition, null, 2) : '');
  const [rawErr, setRawErr] = useState<string | null>(null);

  // Draft state for the "add" form
  const [draft, setDraft] = useState<CondRule>({ field: allFields[0]?.value ?? 'instance.state', op: '==', valueType: 'literal', value: '' });

  const applyRaw = (val: string) => {
    if (!val.trim()) { setRawErr(null); onChange(null); return; }
    try { const p = JSON.parse(val); setRawErr(null); onChange(p); const r = fromJL(p); if (r) setCond(r); }
    catch { setRawErr(t('fulfillment.condition.jsonError')); }
  };
  const upd = (next: CondState) => { setCond(next); const l = toJL(next); onChange(l); setRawText(l ? JSON.stringify(l, null, 2) : ''); };
  const commitDraft = () => {
    if (draft.op !== '!!' && !draft.value.trim()) return;
    upd({ ...cond, rules: [...cond.rules, { ...draft }] });
    setDraft({ field: allFields[0]?.value ?? 'instance.state', op: '==', valueType: 'literal', value: '' });
  };
  const delRule = (i: number) => upd({ ...cond, rules: cond.rules.filter((_, idx) => idx !== i) });

  const fieldLabel = (val: string) => allFields.find(f => f.value === val)?.label ?? val;
  const opLabel = (val: string) => conditionOps.find(o => o.value === val)?.label ?? val;

  if (showRaw) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea value={rawText} onChange={e => { setRawText(e.target.value); applyRaw(e.target.value); }}
        placeholder={t('fulfillment.condition.rawPlaceholder')} rows={6}
        style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '12px', resize: 'vertical', lineHeight: 1.6,
          borderColor: rawErr ? '#fca5a5' : undefined, background: rawErr ? '#fff7f7' : undefined }} />
      {rawErr && <div style={{ fontSize: '11px', color: '#ef4444' }}>{rawErr}</div>}
      <Button variant="secondary" size="sm" style={{ alignSelf: 'flex-start' }}
        onClick={() => { const r = fromJL(condition); if (r) { setCond(r); setShowRaw(false); } }}>← {t('fulfillment.condition.visualEdit')}</Button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
      {/* ── Top: Add new condition ── */}
      <div style={{ background: '#fafafa', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('fulfillment.condition.addCondition')}</div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch' }}>
          {/* Left: field — amber card */}
          <div style={{ flex: 1, background: '#fffbeb', border: '1px dashed #fde68a', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('fulfillment.condition.field')}</span>
            <select value={draft.field} onChange={e => setDraft({ ...draft, field: e.target.value })}
              style={{ fontSize: '12px', minWidth: 0, padding: '5px 6px', background: '#fff', border: '1px solid #fde68a', borderRadius: '5px' }}>
              {fieldGroups.map(g => (
                <optgroup key={g.category} label={g.label}>
                  {g.fields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          {/* Center: operator */}
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <select value={draft.op} onChange={e => setDraft({ ...draft, op: e.target.value })}
              style={{ width: '68px', fontSize: '12px', padding: '5px 4px', background: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: '5px', fontWeight: 600, textAlign: 'center' }}>
              {conditionOps.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* Right: value — blue card */}
          {draft.op !== '!!' ? (
            <div style={{ flex: 1, background: '#eff6ff', border: '1px dashed #bfdbfe', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, color: '#1e40af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('fulfillment.condition.compareValue')}</span>
                <button onClick={() => setDraft({ ...draft, valueType: draft.valueType === 'literal' ? 'var' : 'literal' })}
                  style={{ fontSize: '9px', padding: '2px 8px', borderRadius: '3px', cursor: 'pointer', border: '1px solid', fontWeight: 700,
                    background: draft.valueType === 'var' ? '#fdf4ff' : '#fff',
                    color: draft.valueType === 'var' ? '#7c3aed' : '#64748b',
                    borderColor: draft.valueType === 'var' ? '#e9d5ff' : '#bfdbfe' }}>
                  {draft.valueType === 'var' ? t('fulfillment.condition.variable') : t('fulfillment.condition.literal')}
                </button>
              </div>
              <input value={draft.value} onChange={e => setDraft({ ...draft, value: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); } }}
                placeholder={draft.valueType === 'var' ? 'instance.meta.xxx' : '100'}
                style={{ fontSize: '12px', minWidth: 0, padding: '5px 6px', background: '#fff', border: '1px solid #bfdbfe', borderRadius: '5px',
                  fontFamily: draft.valueType === 'var' ? 'var(--font-mono)' : undefined }} />
            </div>
          ) : (
            <div style={{ flex: 1 }} />
          )}
        </div>
        {/* Add button — below the 3 columns */}
        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" size="sm" onClick={commitDraft}>+ {t('fulfillment.condition.addCondition')}</Button>
        </div>
      </div>

      {/* ── Divider ── */}
      <div style={{ borderTop: '1px solid var(--border-color)', margin: '14px 0' }} />

      {/* ── Bottom: Existing conditions list ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {t('fulfillment.condition.existing')} <span style={{ fontWeight: 400, textTransform: 'none' }}>({cond.rules.length})</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {cond.rules.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {(['and', 'or'] as const).map(c => (
                <button key={c} onClick={() => upd({ ...cond, combinator: c })} style={{
                  padding: '2px 10px', fontSize: '10px', fontWeight: 600, borderRadius: '4px', cursor: 'pointer', border: '1px solid',
                  background: cond.combinator === c ? 'var(--accent-surface)' : 'transparent',
                  color: cond.combinator === c ? 'var(--accent-color)' : 'var(--text-secondary)',
                  borderColor: cond.combinator === c ? '#dbeafe' : 'var(--border-color)',
                }}>{c === 'and' ? t('fulfillment.condition.matchAll') : t('fulfillment.condition.matchAny')}</button>
              ))}
            </div>
          )}
          <Button variant="secondary" size="sm" onClick={() => setShowRaw(true)}>{t('fulfillment.raw_json')}</Button>
        </div>
      </div>

      {cond.rules.length === 0
        ? <div style={{ padding: '20px 14px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: '7px', color: 'var(--text-secondary)', fontSize: '12px', background: '#fafafa' }}>
            {t('fulfillment.condition.emptyState')}
          </div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {cond.rules.map((rule, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: '#fff', border: '1px solid var(--border-color)', borderRadius: '7px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#92400e', background: '#fffbeb', padding: '2px 8px', borderRadius: '4px', border: '1px solid #fde68a' }}>
                  {fieldLabel(rule.field)}
                </span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  {opLabel(rule.op)}
                </span>
                {rule.op !== '!!' && (
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#1e40af', background: '#eff6ff', padding: '2px 8px', borderRadius: '4px', border: '1px solid #bfdbfe',
                    fontFamily: rule.valueType === 'var' ? 'var(--font-mono)' : undefined }}>
                    {rule.valueType === 'var' ? <span style={{ color: '#7c3aed' }}>{rule.value}</span> : rule.value}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <IconButton variant="danger" size="sm" onClick={() => delRule(i)}>✕</IconButton>
              </div>
            ))}
          </div>
      }
    </div>
  );
}
