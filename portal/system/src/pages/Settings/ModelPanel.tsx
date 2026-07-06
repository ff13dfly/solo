import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';

/**
 * AI model selection panel — the portal consumer of agent.model.list/set/reset.
 * Replaces the old redis-cli-only SYSTEM:CONFIG:AI_MODELS workflow: an admin can now
 * pick a per-capability model here. Effective immediately (agent busts its cache on write).
 * Feedback is inline (no system dialogs — CLAUDE.md §8).
 */
interface ModelRow {
  capability: string;
  effective: string | null;
  default: string | null;
  override?: string | null;
}

export function ModelPanel() {
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await callRpc<{ models: ModelRow[] }>('agent.model.list');
      setRows(res?.models || []);
    } catch (e) {
      setError((e as Error)?.message || 'Failed to load model config (is the agent service up?)');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const draftFor = (r: ModelRow) => (r.capability in drafts ? drafts[r.capability] : (r.effective ?? ''));
  const dirty = (r: ModelRow) => r.capability in drafts && drafts[r.capability] !== (r.effective ?? '');

  const onEdit = (cap: string, value: string) => {
    setDrafts(prev => ({ ...prev, [cap]: value }));
    setJustSaved(prev => (prev[cap] ? { ...prev, [cap]: false } : prev));
  };

  const save = async (cap: string) => {
    setBusy(cap);
    setError(null);
    try {
      const raw = drafts[cap] ?? '';
      await callRpc('agent.model.set', { capability: cap, model: raw.trim() === '' ? null : raw.trim() });
      setDrafts(prev => { const n = { ...prev }; delete n[cap]; return n; });
      setJustSaved(prev => ({ ...prev, [cap]: true }));
      await load();
    } catch (e) {
      setError((e as Error)?.message || `Failed to set ${cap}`);
    } finally {
      setBusy(null);
    }
  };

  const reset = async (cap: string) => {
    setBusy(cap);
    setError(null);
    try {
      await callRpc('agent.model.reset', { capability: cap });
      setDrafts(prev => { const n = { ...prev }; delete n[cap]; return n; });
      setJustSaved(prev => ({ ...prev, [cap]: false }));
      await load();
    } catch (e) {
      setError((e as Error)?.message || `Failed to reset ${cap}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <div className="font-bold text-[14px]">AI Models</div>
          <div className="text-[11px] text-text-secondary mt-0.5">
            Per-capability model override. Blank = provider default. Takes effect immediately.
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="text-[11px] px-2 py-1 border border-border rounded hover:bg-white/[0.04]"
          style={{ cursor: 'pointer' }}
        >
          Reload
        </button>
      </div>

      {error && (
        <div className="mx-5 mt-3 px-3 py-2 text-[12px]" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', borderRadius: 4 }}>
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="text-[12px] text-text-secondary">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-[12px] text-text-secondary">No capabilities.</div>
        ) : (
          <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={{ padding: '6px 8px' }}>Capability</th>
                <th style={{ padding: '6px 8px' }}>Model (blank = default)</th>
                <th style={{ padding: '6px 8px' }}>Default</th>
                <th style={{ padding: '6px 8px', width: 140 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.capability} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '6px 8px' }} className="font-mono">{r.capability}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <input
                      value={draftFor(r)}
                      onChange={e => onEdit(r.capability, e.target.value)}
                      placeholder={r.default ?? '(provider default)'}
                      className="w-full px-2 py-1 font-mono"
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: `1px solid ${dirty(r) ? 'var(--accent)' : 'rgba(255,255,255,0.08)'}`,
                        borderRadius: 3, color: 'var(--text-primary)', fontSize: 12,
                      }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }} className="font-mono">
                    {r.default ?? '—'}
                    {r.override !== undefined && r.override !== null && (
                      <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--accent)' }}>overridden</span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {justSaved[r.capability] && !dirty(r) && (
                      <span style={{ marginRight: 8, fontSize: 11, color: '#22c55e' }}>✓ saved</span>
                    )}
                    <button
                      onClick={() => void save(r.capability)}
                      disabled={busy === r.capability || !dirty(r)}
                      className="text-[11px] px-2 py-1 border rounded"
                      style={{
                        cursor: busy === r.capability || !dirty(r) ? 'default' : 'pointer',
                        opacity: busy === r.capability || !dirty(r) ? 0.4 : 1,
                        borderColor: 'var(--accent)', color: 'var(--accent)', marginRight: 6,
                      }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => void reset(r.capability)}
                      disabled={busy === r.capability || r.override === undefined}
                      className="text-[11px] px-2 py-1 border border-border rounded hover:bg-white/[0.04]"
                      style={{ cursor: busy === r.capability || r.override === undefined ? 'default' : 'pointer', opacity: r.override === undefined ? 0.4 : 1 }}
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
