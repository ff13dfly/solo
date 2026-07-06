
interface OptionalParamsProps {
  options: { name: string; type: string }[];
  onAdd: (key: string) => void;
}

export default function StepOptionalParams({ options, onAdd }: OptionalParamsProps) {
  if (options.length === 0) return null;

  return (
    <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
      <label style={{ fontSize: '10px', opacity: 0.5, display: 'block', marginBottom: '8px' }}>可选参数 (点击添加)</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {options.map(p => (
          <button
            key={p.name}
            onClick={() => onAdd(p.name)}
            style={{
              padding: '4px 8px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px dashed #444',
              borderRadius: '4px',
              color: '#c9d1d9',
              fontSize: '11px',
              cursor: 'pointer',
              opacity: 0.6,
              transition: 'all 0.2s'
            }}
            onMouseOver={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = '#f59e0b'; }}
            onMouseOut={e => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.borderColor = '#444'; }}
          >
            + {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
