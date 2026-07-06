import { useState } from 'react';
import type { WorkflowStep } from './types';
import CategoryParamEditor from './CategoryParamEditor';
import GenericObjectEditor from './GenericObjectEditor';

interface ParamFieldProps {
  param: { name: string; type: string };
  value: any;
  onChange: (key: string, value: any) => void;
  onExclude: (key: string) => void;
  allSteps: WorkflowStep[];
  currentStepId: string;
}

export default function StepParamField({ 
  param, 
  value, 
  onChange, 
  onExclude, 
  allSteps, 
  currentStepId 
}: ParamFieldProps) {
  // Mode: manual input or piping reference
  const [isPiping, setIsPiping] = useState((typeof value === 'string' && value.startsWith('$step.')));
  
  // Styles
  const inputStyle = {
    width: '100%',
    height: '32px',
    padding: '0 8px',
    background: '#1c2128',
    border: '1px solid #444',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px',
    flex: 1,
    boxSizing: 'border-box' as const
  };
  
  const selectStyle = {
    width: '100%',
    height: '32px',
    padding: '0 8px',
    background: '#1c2128',
    border: '1px solid #444',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px',
    cursor: 'pointer',
    flex: 1,
    boxSizing: 'border-box' as const
  };

  const toggleButtonStyle = {
    background: isPiping ? 'rgba(245, 158, 11, 0.2)' : 'transparent',
    border: `1px solid ${isPiping ? '#f59e0b' : '#444'}`,
    borderRadius: '4px',
    color: isPiping ? '#f59e0b' : '#666',
    cursor: 'pointer',
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    padding: '0',
    transition: 'all 0.2s',
    boxSizing: 'border-box' as const
  };

  const currentIdx = allSteps.findIndex(s => s.id === currentStepId);
  const availableSteps = currentIdx === -1 ? allSteps : allSteps.slice(0, currentIdx);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 28px 1fr 24px', gap: '8px', alignItems: 'center' }}>
      <div style={{ fontSize: '11px', textAlign: 'right', opacity: 0.8 }}>
        <span style={{ fontFamily: 'monospace' }}>{param.name}</span>
        <span style={{ fontSize: '9px', opacity: 0.5, marginLeft: '4px' }}>({param.type})</span>
      </div>

      {/* Toggle Button Slot (Column 2) */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        {availableSteps.length > 0 && param.type !== 'object' && (
          <button 
            onClick={() => setIsPiping(!isPiping)}
            style={toggleButtonStyle}
            title={isPiping ? "Switch to manual input" : "Switch to data piping"}
          >
            {isPiping ? "🔗" : "⌨️"}
          </button>
        )}
      </div>
      
      {/* Editor Slot (Column 3) */}
      <div>
        {param.name === 'categories' && param.type === 'object' ? (
          <CategoryParamEditor 
            value={typeof value === 'object' ? value : {}}
            onChange={(val) => onChange(param.name, val)}
          />
        ) : param.type === 'object' ? (
          <GenericObjectEditor 
            value={typeof value === 'object' ? value : {}}
            onChange={(val) => onChange(param.name, val)}
          />
        ) : (
          isPiping && availableSteps.length > 0 ? (
            <select
              value={value?.startsWith('$step.') ? value : ""}
              onChange={(e) => {
                if (e.target.value) onChange(param.name, e.target.value);
              }}
              style={selectStyle}
            >
              <option value="" disabled>-- Select Step Reference --</option>
              {availableSteps.map((s, idx) => (
                <optgroup key={s.id} label={`#${idx+1} ${s.method}`}>
                  <option value={`$step.${s.id}.result.id`}>Result: ID</option>
                  <option value={`$step.${s.id}.result`}>Result: Full Object</option>
                </optgroup>
              ))}
            </select>
          ) : (
            <input
              value={value || ''}
              onChange={e => onChange(param.name, e.target.value)}
              placeholder={`Value for ${param.name}`}
              style={inputStyle}
            />
          )
        )}
      </div>
      
      <button
        onClick={() => onExclude(param.name)}
        style={{
          background: 'none',
          border: 'none',
          color: '#ef4444',
          cursor: 'pointer',
          fontSize: '14px',
          padding: '0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          opacity: 0.6
        }}
        onMouseOver={e => e.currentTarget.style.opacity = '1'}
        onMouseOut={e => e.currentTarget.style.opacity = '0.6'}
        title="Remove parameter"
      >
        ×
      </button>
    </div>
  );
}

