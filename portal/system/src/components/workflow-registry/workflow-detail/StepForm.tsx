import { useState, useEffect, useRef } from 'react';
import type { WorkflowStep } from './types';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { useUI } from '../../../providers/UIProvider';
import StepParamField from './StepParamField';
import StepOptionalParams from './StepOptionalParams';

interface StepFormProps {
  initialData?: WorkflowStep | null;
  existingIds: string[];
  allSteps?: WorkflowStep[];
  onSave: (step: WorkflowStep) => void;
  onCancel: () => void;
}

export default function StepForm({ initialData, existingIds, allSteps = [], onSave, onCancel }: StepFormProps) {
  const { toast } = useUI();
  const { 
    capabilities, 
    loading: loadingCaps, 
    fetchCapabilities, 
    getServiceList, 
    getMethodsForService, 
    getMethodParams 
  } = useCapabilities();

  const [formState, setFormState] = useState({
    id: '',
    service: '',
    method: '',
    params: {} as Record<string, any>
  });

  // Load capabilities on mount
  useEffect(() => {
    fetchCapabilities();
  }, [fetchCapabilities]);

  const [excludedParams, setExcludedParams] = useState<Set<string>>(new Set());
  // Initialize form state
  useEffect(() => {
    if (initialData) {
      console.log('StepForm initializing with:', initialData);
      const fullMethod = initialData.method.startsWith(initialData.service + '.') 
        ? initialData.method 
        : `${initialData.service}.${initialData.method}`;
        
      setFormState({
        id: initialData.id,
        service: initialData.service,
        method: fullMethod,
        params: initialData.params ? JSON.parse(JSON.stringify(initialData.params)) : {}
      });
    } else {
      const newId = Math.random().toString(36).substring(2, 10).toLowerCase();
      setFormState({
        id: newId,
        service: '',
        method: '',
        params: {}
      });
      setExcludedParams(new Set());
    }
  }, [initialData]);

  // Auto-hide empty params logic
  // We track which Step ID we most recently calculated exclusions for, to prevent overwriting user edits.
  const autoHideRunRef = useRef<string | null>(null);

  useEffect(() => {
    // Only run if we have existing data and capabilities are loaded
    if (initialData && capabilities.length > 0) {
      // If we already ran auto-hide for this specific step ID, do not run again
      // ensuring we don't clobber the user's manual "restore param" actions.
      if (autoHideRunRef.current === initialData.id) return;

      const fullMethod = initialData.method.startsWith(initialData.service + '.') 
        ? initialData.method 
        : `${initialData.service}.${initialData.method}`;
        
      const caps = getMethodParams(fullMethod);

      if (caps && caps.length > 0) {
        // Calculate non-empty keys
        const nonEmptyKeys = new Set(
            Object.entries(initialData.params || {})
                .filter(([_, val]) => {
                    return val !== undefined && val !== null && val !== '' && 
                           !(typeof val === 'object' && Object.keys(val).length === 0);
                })
                .map(([key]) => key)
        );

        // Hide anything that is NOT in the non-empty active set
        const toHide = caps
            .filter(p => !nonEmptyKeys.has(p.name))
            .map(p => p.name);
        
        if (toHide.length > 0) {
          console.log(`Auto-hiding empty params for ${initialData.id}:`, toHide);
          setExcludedParams(new Set(toHide));
        } else {
          setExcludedParams(new Set());
        }
        
        // Mark as run for this ID
        autoHideRunRef.current = initialData.id;
      }
    } else if (!initialData) {
        // For new steps, we don't hide anything by default (or handle elsewhere)
        autoHideRunRef.current = null;
    }
  }, [initialData, capabilities, getMethodParams]);

  // Logic Helpers
  const generateParamsTemplate = (methodName: string) => {
    const caps = getMethodParams(methodName);
    if (caps.length === 0) return {};
    
    const template: Record<string, any> = {};
    const prefix = methodName.replace(/\./g, '_');

    caps.forEach(p => {
      // Default to unique $input reference (method_param)
      template[p.name] = `$input.${prefix}_${p.name}`; 
    });
    return template;
  };

  // Handlers
  const handleServiceChange = (service: string) => {
    setFormState(prev => ({
      ...prev,
      service,
      method: '',
      params: {}
    }));
    setExcludedParams(new Set());
  };

  const handleMethodChange = (method: string) => {
    const template = generateParamsTemplate(method);
    setFormState(prev => ({
      ...prev,
      method,
      params: template
    }));
    setExcludedParams(new Set());
  };

  const handleParamChange = (key: string, value: any) => {
    setFormState(prev => ({
      ...prev,
      params: {
        ...prev.params,
        [key]: value
      }
    }));
  };

  const handleExcludeParam = (key: string) => {
    setExcludedParams(prev => {
        const next = new Set(prev);
        next.add(key);
        return next;
    });
    setFormState(prev => {
        const nextParams = { ...prev.params };
        delete nextParams[key];
        return { ...prev, params: nextParams };
    });
  };

  const handleRestoreParam = (key: string) => {
    setExcludedParams(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
    });
    // Initialize with default value 
    const prefix = formState.method.replace(/\./g, '_');
    setFormState(prev => ({
        ...prev,
        params: { ...prev.params, [key]: prev.params[key] || `$input.${prefix}_${key}` }
    }));
  };

  const handleSubmit = () => {
    if (!formState.id.trim()) {
      toast.error('Step ID is required');
      return;
    }
    if (!formState.service) {
      toast.error('Service is required');
      return;
    }
    if (!formState.method) {
      toast.error('Method is required');
      return;
    }

    if (!initialData && existingIds.includes(formState.id)) {
      toast.error('Step ID already exists');
      return;
    }

    const shortMethod = formState.method.startsWith(formState.service + '.') 
      ? formState.method.slice(formState.service.length + 1) 
      : formState.method;

    const paramDefs = getMethodParams(formState.method);
    const finalParams = { ...formState.params };
    
    for (const def of paramDefs) {
        if (def.type === 'object' && typeof finalParams[def.name] === 'string') {
            try {
                if (!finalParams[def.name].trim()) {
                    finalParams[def.name] = {}; 
                } else {
                    finalParams[def.name] = JSON.parse(finalParams[def.name]);
                }
            } catch (e) {
                toast.error(`Invalid JSON for parameter: ${def.name}`);
                return;
            }
        }
    }

    const step: WorkflowStep = {
      id: formState.id,
      service: formState.service,
      method: shortMethod,
      params: finalParams
    };

    onSave(step);
  };

  const methodParams = getMethodParams(formState.method);

  // Styles
  const selectStyle = {
    width: '100%',
    padding: '8px',
    background: '#1c2128',
    border: '1px solid #444',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px',
    cursor: 'pointer'
  };

  return (
    <div style={{ 
      padding: '16px', 
      background: 'rgba(245, 158, 11, 0.1)', 
      borderRadius: '6px', 
      marginBottom: '12px',
      border: '1px solid rgba(245, 158, 11, 0.3)'
    }}>
      {loadingCaps && <div style={{ fontSize: '11px', textAlign: 'center', opacity: 0.6 }}>Loading capabilities...</div>}
      
      {/* Service & Method */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
        <div>
          <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>选择服务</label>
          <select
            value={formState.service}
            onChange={e => handleServiceChange(e.target.value)}
            style={{ ...selectStyle, borderColor: formState.service ? '#f59e0b' : '#444' }}
          >
            <option value="">-- 选择服务 --</option>
            {getServiceList().map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>选择方法</label>
          <select
            value={formState.method}
            onChange={e => handleMethodChange(e.target.value)}
            style={{ ...selectStyle, borderColor: formState.method ? '#f59e0b' : '#444' }}
            disabled={!formState.service}
          >
            <option value="">-- 选择方法 --</option>
            {getMethodsForService(formState.service).map(cap => (
              <option key={cap.method} value={cap.method}>{cap.method.split('.').slice(1).join('.')}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Dynamic Params Inputs */}
      {formState.method && (
        <div style={{ marginBottom: '12px' }}>
           <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '8px' }}>参数配置</label>
           <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {methodParams.length === 0 ? (
                 <div style={{ fontSize: '11px', opacity: 0.5 }}>该方法无参数</div>
              ) : (
                <>
                {/* Active Params */}
                {methodParams.filter(p => !excludedParams.has(p.name)).map(param => (
                    <StepParamField 
                        key={param.name}
                        param={param}
                        value={formState.params[param.name]}
                        onChange={handleParamChange}
                        onExclude={handleExcludeParam}
                        allSteps={allSteps}
                        currentStepId={formState.id}
                    />
                ))}
                
                {/* Optional Params */}
                <StepOptionalParams 
                    options={methodParams.filter(p => excludedParams.has(p.name))}
                    onAdd={handleRestoreParam}
                />
                </>
              )}
           </div>
        </div>
      )}
      
      {/* Footer Buttons */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
        {(!formState.id || !formState.service || !formState.method) && (
            <div style={{ fontSize: '11px', color: '#ef4444', opacity: 0.8 }}>
                * ID, Service, Method required
            </div>
        )}
        <div style={{ display: 'flex', gap: '8px' }}>
            <button className="service-btn small" onClick={onCancel}>CANCEL</button>
            <button 
              className="service-btn small" 
              onClick={handleSubmit} 
              disabled={!formState.id || !formState.service || !formState.method}
              style={{ 
                  borderColor: 'var(--success-color)', 
                  color: 'var(--success-color)',
                  opacity: (!formState.id || !formState.service || !formState.method) ? 0.5 : 1,
                  cursor: (!formState.id || !formState.service || !formState.method) ? 'not-allowed' : 'pointer'
              }}
            >
              {initialData ? 'UPDATE' : 'ADD'}
            </button>
        </div>
      </div>
    </div>
  );
}
