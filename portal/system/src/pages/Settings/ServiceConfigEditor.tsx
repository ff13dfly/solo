import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';
import { useToast } from '../../components/shared/useToast';
import { ToastContainer } from '../../components/shared/Toast';

interface SchemaKey {
  key: string;
  default: boolean | number | string;
  type: 'boolean' | 'number' | 'string';
}

interface IndexEntry {
  index: string;
  prefix: string;
  fields: string[];
}

interface IndexSchema {
  service: string;
  indexedAt: string;
  redisearch: IndexEntry[];
}

interface ServiceConfigEditorProps {
  serviceId: string;
}

export const ServiceConfigEditor: React.FC<ServiceConfigEditorProps> = ({ serviceId }) => {
  const [schema, setSchema] = useState<SchemaKey[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [indexSchema, setIndexSchema] = useState<IndexSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const { toasts, show: showToast } = useToast();

  useEffect(() => {
    setLoading(true);
    setSchema(null);
    setOverrides({});
    setEditValues({});
    setIndexSchema(null);

    Promise.all([
      callRpc<{ keys: SchemaKey[] } | null>('setting.config.schema', { service: serviceId }).catch(() => null),
      callRpc<Record<string, string>>('setting.config.get', { service: serviceId }).catch(() => ({})),
      callRpc<IndexSchema | null>('setting.index.schema', { service: serviceId }).catch(() => null),
    ]).then(([schemaResult, overridesResult, indexResult]) => {
      const keys = schemaResult?.keys ?? null;
      const ovr = overridesResult || {};
      setSchema(keys);
      setOverrides(ovr);
      setIndexSchema(indexResult);
      const vals: Record<string, string> = { ...ovr };
      if (keys) {
        keys.forEach(k => { if (!(k.key in vals)) vals[k.key] = String(k.default); });
      }
      setEditValues(vals);
    }).finally(() => setLoading(false));
  }, [serviceId]);

  const handleSet = async (key: string, value: string) => {
    setSaving(key);
    try {
      await callRpc('setting.config.set', { service: serviceId, key, value });
      setOverrides(prev => ({ ...prev, [key]: value }));
      setEditValues(prev => ({ ...prev, [key]: value }));
      showToast('success', `${key} = ${value}`);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setSaving(null);
    }
  };

  const handleDel = async (key: string, defaultVal: string) => {
    setSaving(key);
    try {
      await callRpc('setting.config.del', { service: serviceId, key });
      setOverrides(prev => { const n = { ...prev }; delete n[key]; return n; });
      setEditValues(prev => ({ ...prev, [key]: defaultVal }));
      showToast('success', `Reset: ${key}`);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setSaving(null);
    }
  };

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      const result = await callRpc<{ rebuilt: boolean; indexedAt: string }>(`${serviceId}.index.rebuild`, {});
      setIndexSchema(prev => prev ? { ...prev, indexedAt: result.indexedAt } : prev);
      showToast('success', `Index rebuilt`);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setRebuilding(false);
    }
  };

  const isOverridden = (key: string) => key in overrides;

  const renderValue = (key: string, type: SchemaKey['type'], defaultVal: SchemaKey['default']) => {
    const val = editValues[key] ?? String(defaultVal);

    if (type === 'boolean') {
      const checked = val === 'true';
      const busy = saving === key;
      return (
        <button
          onClick={() => handleSet(key, String(!checked))}
          disabled={busy}
          className={`relative w-10 h-5 rounded-full border transition-colors shrink-0 ${
            checked ? 'bg-accent border-accent' : 'bg-bg-primary border-border'
          } ${busy ? 'opacity-40' : ''}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'left-5' : 'left-0.5'}`} />
        </button>
      );
    }

    return (
      <div className="flex gap-1.5 flex-1">
        <input
          type={type === 'number' ? 'number' : 'text'}
          className="bg-bg-secondary border border-border text-text-primary font-mono text-xs px-2 py-1 outline-none focus:border-accent flex-1 min-w-0"
          value={val}
          onChange={e => setEditValues(prev => ({ ...prev, [key]: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter') handleSet(key, editValues[key] ?? ''); }}
        />
        <button
          className="service-btn small"
          disabled={saving === key}
          onClick={() => handleSet(key, editValues[key] ?? '')}
        >
          {saving === key ? '...' : 'Set'}
        </button>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <ToastContainer toasts={toasts} />

      {/* Config Schema */}
      {loading ? (
        <div className="text-xs text-text-secondary font-mono">Loading...</div>
      ) : !schema ? (
        <div className="text-xs text-text-secondary font-mono opacity-60">
          No schema published — service has not called cfg.publish() yet.
        </div>
      ) : (
        <div className="border border-border">
          <div className="grid grid-cols-[1fr_60px_1fr_80px_auto] text-xs text-text-secondary font-mono px-3 py-1.5 border-b border-border bg-bg-primary uppercase tracking-wide gap-3">
            <span>Key</span>
            <span>Type</span>
            <span>Value</span>
            <span>Default</span>
            <span />
          </div>
          {schema.map(({ key, type, default: defaultVal }) => (
            <div key={key} className="grid grid-cols-[1fr_60px_1fr_80px_auto] items-center border-b border-border last:border-0 px-3 py-2 gap-3">
              <span className={`text-xs font-mono truncate ${isOverridden(key) ? 'text-accent' : 'text-text-secondary'}`}>
                {key}
                {isOverridden(key) && <span className="ml-1.5 text-accent/50 text-[10px]">overridden</span>}
              </span>
              <span className="text-xs font-mono text-text-secondary opacity-40">{type}</span>
              <div className="flex items-center">
                {renderValue(key, type, defaultVal)}
              </div>
              <span className="text-xs font-mono text-text-secondary opacity-40 truncate">{String(defaultVal)}</span>
              <div className="w-12 flex justify-end">
                {isOverridden(key) && type !== 'boolean' && (
                  <button
                    className="service-btn small danger"
                    disabled={saving === key}
                    onClick={() => handleDel(key, String(defaultVal))}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-text-secondary font-mono opacity-40">
        Changes take effect after service restart.
      </p>

      {/* RediSearch Index Schema */}
      {indexSchema && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary font-mono uppercase tracking-wide">RediSearch</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-secondary font-mono opacity-40">
                {new Date(indexSchema.indexedAt).toLocaleString()}
              </span>
              <button
                className="service-btn small"
                disabled={rebuilding}
                onClick={handleRebuild}
              >
                {rebuilding ? 'Rebuilding...' : 'Rebuild'}
              </button>
            </div>
          </div>
          <div className="border border-border">
            {indexSchema.redisearch.map((entry) => (
              <div key={entry.index} className="border-b border-border last:border-0 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-accent">{entry.index}</span>
                  <span className="text-xs font-mono text-text-secondary opacity-40">{entry.prefix}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {entry.fields.map(f => (
                    <span key={f} className="text-[10px] font-mono text-text-secondary bg-bg-secondary border border-border px-1.5 py-0.5">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
