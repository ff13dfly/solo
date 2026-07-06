
import { useState } from 'react';

interface GenericObjectEditorProps {
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
}

export default function GenericObjectEditor({ value, onChange }: GenericObjectEditorProps) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const handleAdd = () => {
    if (newKey) {
      onChange({
        ...value,
        [newKey]: newValue
      });
      setNewKey('');
      setNewValue('');
    }
  };

  const handleRemove = (keyToRemove: string) => {
    const next = { ...value };
    delete next[keyToRemove];
    onChange(next);
  };

  const handleChangeValue = (key: string, val: string) => {
    onChange({
        ...value,
        [key]: val
    });
  };

  const inputStyle = {
    padding: '4px 8px',
    background: '#1c2128',
    border: '1px solid #444',
    borderRadius: '4px',
    color: 'white',
    fontSize: '11px',
    width: '100%'
  };

  // Check if value is flat (only primitives) to decide if we can use this editor safely
  // For now, we assume users using this editor want string values.
  // We can treat non-string values as JSON stringified in the specific row?
  
  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
      {/* Existing Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: Object.keys(value || {}).length ? '8px' : '0' }}>
        {Object.entries(value || {}).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: '#aaa', fontSize: '11px', width: '30%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={k}>
              {k}
            </span>
            <input 
                 value={typeof v === 'object' ? JSON.stringify(v) : v}
                 onChange={e => handleChangeValue(k, e.target.value)}
                 style={{ ...inputStyle, flex: 1 }}
                 placeholder="Value"
            />
            <button 
              onClick={() => handleRemove(k)}
              style={{ border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer', opacity: 0.8 }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Add New Row */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', borderTop: '1px dashed #444', paddingTop: '8px' }}>
        <input
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          placeholder="New Key"
          style={{ ...inputStyle, width: '30%' }}
        />
        <input
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
          placeholder="New Value"
          style={{ ...inputStyle, flex: 1 }}
          onKeyDown={e => {
            if (e.key === 'Enter') handleAdd();
          }}
        />
        <button
          onClick={handleAdd}
          disabled={!newKey}
          style={{ 
            background: '#3b82f6', 
            color: 'white', 
            border: 'none', 
            borderRadius: '4px', 
            width: '24px', 
            height: '24px',
            cursor: 'pointer',
            opacity: !newKey ? 0.5 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}
