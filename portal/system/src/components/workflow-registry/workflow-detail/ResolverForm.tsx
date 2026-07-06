import { useState, useEffect } from 'react';
import type { Resolver, Workflow } from './types';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { useUI } from '../../../providers/UIProvider';

interface ResolverFormProps {
  workflow: Workflow;
  initialData?: { key: string; resolver: Resolver } | null;
  existingKeys: string[];
  onSave: (key: string, resolver: Resolver) => void;
  onCancel: () => void;
}

export default function ResolverForm({ workflow, initialData, existingKeys, onSave, onCancel }: ResolverFormProps) {
  const { toast } = useUI();
  const { 
    capabilities, 
    loading: loadingCaps, 
    fetchCapabilities, 
    getServiceList, 
    getMethodsForService, 
    getMethodParams, 
    getMethodReturns 
  } = useCapabilities();

  const [formState, setFormState] = useState({
    key: '',
    selectedStep: '',
    selectedParam: '',
    source: '',
    selectedService: '',
    method: '',
    selectedMethodParams: {} as Record<string, boolean>,
    params: '',
    extract: ''
  });

  // Load capabilities on mount
  useEffect(() => {
    fetchCapabilities();
  }, [fetchCapabilities]);

  // Initialize form state
  useEffect(() => {
    if (initialData) {
      const { key, resolver } = initialData;
      const sourceParts = resolver.source.match(/\$step\.(.+?)\.params\.(.+)/);
      const stepId = sourceParts?.[1] || '';
      const paramName = sourceParts?.[2] || '';
      const serviceName = resolver.method.split('.')[0] || '';
      
      const selectedMethodParams: Record<string, boolean> = {};
      Object.keys(resolver.params || {}).forEach(k => { selectedMethodParams[k] = true; });

      setFormState({
        key,
        selectedStep: stepId,
        selectedParam: paramName,
        source: resolver.source,
        selectedService: serviceName,
        method: resolver.method,
        selectedMethodParams,
        params: JSON.stringify(resolver.params || {}, null, 2),
        extract: resolver.extract || ''
      });
    } else {
      // Reset for new entry
      setFormState({
        key: '',
        selectedStep: '',
        selectedParam: '',
        source: '',
        selectedService: '',
        method: '',
        selectedMethodParams: {},
        params: '',
        extract: ''
      });
    }
  }, [initialData]);

  // Fetch caps when we have a selected param, just in case
  useEffect(() => {
    if (formState.selectedParam && capabilities.length === 0) {
      fetchCapabilities();
    }
  }, [formState.selectedParam, capabilities.length, fetchCapabilities]);


  // Logic Helpers
  const getAllVariables = () => {
    const vars: { label: string; value: string }[] = [];
    
    // Add Workflow Inputs
    if (workflow.steps) {
        const inputSet = new Set<string>();
        workflow.steps.forEach(s => {
            if (s.params) {
                Object.values(s.params).forEach(v => {
                    if (typeof v === 'string' && v.startsWith('$input.')) {
                        inputSet.add(v);
                    }
                });
            }
        });
        Array.from(inputSet).sort().forEach(v => {
            vars.push({ label: `Input: ${v.split('.')[1]}`, value: v });
        });
    }

    // Add Step Parameters
    workflow.steps?.forEach((step, index) => {
        if (!step.params) return;
        Object.keys(step.params).forEach(paramKey => {
            vars.push({ 
                label: `Step ${index}: ${paramKey}`, 
                value: `$step.${step.id}.params.${paramKey}` 
            });
        });
    });

    return vars;
  };

  const getStepOptions = () => {
    if (!workflow.steps || workflow.steps.length === 0) return [];
    return workflow.steps.map((step, index) => ({ 
        stepId: step.id, 
        stepMethod: step.method,
        label: `Step ${index}: ${step.method}`
    }));
  };

  const getParamOptionsForStep = (stepId: string) => {
    const step = workflow.steps?.find(s => s.id === stepId);
    if (!step || !step.params) return [];
    return Object.keys(step.params).map(paramKey => ({
      paramName: paramKey,
      value: `$step.${stepId}.params.${paramKey}`
    }));
  };


  const generateParamsTemplate = (methodName: string) => {
    const caps = getMethodParams(methodName);
    if (caps.length === 0) return '{}';
    
    const template: Record<string, string> = {};
    caps.forEach((p) => {
      template[p.name] = '';
    });
    return JSON.stringify(template, null, 2);
  };

  const getInitialParamSelection = (methodName: string) => {
    const caps = getMethodParams(methodName);
    const selection: Record<string, boolean> = {};
    caps.forEach(p => { selection[p.name] = true; });
    return selection;
  };

  // Handlers
  const handleStepChange = (stepId: string) => {
    setFormState(prev => ({
      ...prev,
      selectedStep: stepId,
      selectedParam: '',
      source: '',
      key: '',
      method: '',
      params: ''
    }));
  };

  const handleParamChange = (paramName: string) => {
    const step = workflow.steps?.find(s => s.id === formState.selectedStep);
    const methodBase = (step?.method || '').replace(/\./g, '_');
    const key = step ? `${methodBase}_${paramName}` : paramName;

    setFormState(prev => ({
      ...prev,
      selectedParam: paramName,
      source: `$step.${formState.selectedStep}.params.${paramName}`,
      key
    }));
  };

  const handleServiceChange = (service: string) => {
    setFormState(prev => ({
      ...prev,
      selectedService: service,
      method: '',
      selectedMethodParams: {},
      params: ''
    }));
  };

  const handleMethodChange = (method: string) => {
    const initialParams = getInitialParamSelection(method);
    setFormState(prev => ({
      ...prev,
      method,
      selectedMethodParams: initialParams,
      params: generateParamsTemplate(method)
    }));
  };

  const handleSubmit = () => {
    if (!formState.key.trim()) {
      toast.error('Resolver key is required');
      return;
    }
    // Check dupe only if adding new
    if (!initialData && existingKeys.includes(formState.key)) {
      toast.error('Resolver key already exists');
      return;
    }

    let parsedParams: Record<string, string> = {};
    try {
      if (formState.params.trim()) {
        parsedParams = JSON.parse(formState.params);
      }
    } catch {
      toast.error('Invalid JSON for params');
      return;
    }

    const resolver: Resolver = {
      source: formState.source,
      method: formState.method,
      params: parsedParams,
      extract: formState.extract
    };

    onSave(formState.key, resolver);
  };

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
  const inputStyle = {
    width: '100%',
    padding: '8px',
    background: '#1c2128',
    border: '1px solid #444',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px'
  };


  const stepOptions = getStepOptions();
  const paramOptions = getParamOptionsForStep(formState.selectedStep);
  const allWorkflowVars = getAllVariables();
  const hasSelectedStep = !!formState.selectedStep;
  const hasSelectedParam = !!formState.selectedParam;

  return (
    <div style={{ 
      padding: '16px', 
      background: 'rgba(245, 158, 11, 0.1)', 
      borderRadius: '6px', 
      marginBottom: '12px',
      border: '1px solid rgba(245, 158, 11, 0.3)'
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '48px' }}>
        
        {/* LEFT COLUMN: TARGET */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ paddingBottom: '8px', borderBottom: '1px solid rgba(245, 158, 11, 0.2)', marginBottom: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#f59e0b' }}>目的：目标参数 (Target)</span>
          </div>

          {/* Step Select */}
          <div>
            <label style={{ fontSize: '11px', opacity: 0.8, display: 'block', marginBottom: '4px', fontWeight: 600 }}>选择目标步骤</label>
            <select
              value={formState.selectedStep}
              onChange={e => handleStepChange(e.target.value)}
              style={{ ...selectStyle, borderColor: hasSelectedStep ? '#f59e0b' : '#444' }}
              disabled={!!initialData}
            >
              <option value="">-- 选择步骤 --</option>
              {stepOptions.map(opt => (
                <option key={opt.stepId} value={opt.stepId}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Param Select */}
          <div>
            <label style={{ fontSize: '11px', opacity: 0.8, display: 'block', marginBottom: '4px', fontWeight: 600 }}>选择需解析的参数</label>
            <select
              value={formState.selectedParam}
              onChange={e => handleParamChange(e.target.value)}
              style={{ ...selectStyle, borderColor: hasSelectedParam ? '#f59e0b' : '#444' }}
              disabled={!hasSelectedStep}
            >
              <option value="">-- 选择参数 --</option>
              {paramOptions.map(opt => (
                <option key={opt.paramName} value={opt.paramName}>{opt.paramName}</option>
              ))}
            </select>
          </div>

          {/* Key Preview */}
          {formState.key && (
            <div>
              <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>解析器标识 (System Key)</label>
              <input 
                value={formState.key}
                readOnly
                style={{ ...inputStyle, background: 'rgba(0,0,0,0.1)', border: '1px dashed #333', color: '#666', cursor: 'not-allowed' }}
              />
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: IMPLEMENTATION */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
             <div style={{ paddingBottom: '8px', borderBottom: '1px solid rgba(245, 158, 11, 0.2)', marginBottom: '4px' }}>
               <span style={{ fontSize: '12px', fontWeight: 600, color: '#f59e0b' }}>实现：解析策略 (Strategy)</span>
             </div>

             <>
                {loadingCaps && <div style={{ fontSize: '11px', textAlign: 'center', opacity: 0.6 }}>Loading capabilities...</div>}
                {/* Service Select */}
                <div>
                  <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>选择执行服务</label>
                  <select
                    value={formState.selectedService}
                    onChange={e => handleServiceChange(e.target.value)}
                    style={{ ...selectStyle, borderColor: formState.selectedService ? '#f59e0b' : '#444' }}
                  >
                    <option value="">-- 选择服务 --</option>
                    {getServiceList().map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                {/* Method Select */}
                <div>
                  <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>选择执行方法</label>
                  <select
                    value={formState.method}
                    onChange={e => handleMethodChange(e.target.value)}
                    style={{ ...selectStyle, borderColor: formState.method ? '#f59e0b' : '#444' }}
                    disabled={!formState.selectedService}
                  >
                    <option value="">-- 选择方法 --</option>
                    {getMethodsForService(formState.selectedService)
                      .filter(cap => {
                        const m = cap.method.toLowerCase();
                        // Exclude write/mutation methods
                        return !/(^|\.)(create|update|delete|remove|add|set|put|patch|reserve|restore)($|\.)/.test(m);
                      })
                      .map(cap => (
                      <option key={cap.method} value={cap.method}>{cap.method.split('.').slice(1).join('.')}</option>
                    ))}
                  </select>
                </div>

                {/* Request Params (Structured Editor) */}
                {formState.method && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>方法参数映射 (Params Mapping)</label>
                    <div style={{ 
                      background: 'rgba(0,0,0,0.2)', 
                      borderRadius: '4px', 
                      padding: '8px', 
                      maxHeight: '220px', 
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '12px'
                    }}>
                      {(() => {
                        const methodParams = getMethodParams(formState.method);
                        if (methodParams.length === 0) return <div style={{ fontSize: '11px', opacity: 0.5 }}>无参数</div>;
                        
                        let currentParsed: Record<string, any> = {};
                        try { currentParsed = JSON.parse(formState.params || '{}'); } catch (e) {}

                        return methodParams.map(param => {
                          const isSelected = !!formState.selectedMethodParams[param.name];
                          const value = currentParsed[param.name] ?? '';
                          const isVariable = typeof value === 'string' && value.startsWith('$');

                          return (
                            <div key={param.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: isSelected ? 1 : 0.6 }}>
                              {/* Left: Checkbox & Label */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '120px', flexShrink: 0 }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={e => {
                                    const newSelection = { ...formState.selectedMethodParams, [param.name]: e.target.checked };
                                    let newParams = { ...currentParsed };
                                    if (e.target.checked) {
                                      newParams[param.name] = newParams[param.name] || '';
                                    } else {
                                      delete newParams[param.name];
                                    }
                                    setFormState(p => ({ 
                                      ...p, 
                                      selectedMethodParams: newSelection, 
                                      params: JSON.stringify(newParams, null, 2) 
                                    }));
                                  }}
                                  style={{ accentColor: '#f59e0b' }}
                                />
                                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                                    <span style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={param.name}>{param.name}</span>
                                    <span style={{ fontSize: '9px', opacity: 0.4 }}>{param.type}</span>
                                </div>
                              </div>
                              
                              {/* Right: Variable Select or Constant Input */}
                              <div style={{ flex: 1, display: 'flex', gap: '4px' }}>
                                <select
                                  value={isVariable ? value : ''}
                                  disabled={!isSelected}
                                  onChange={e => {
                                    const val = e.target.value;
                                    const newParams = { ...currentParsed, [param.name]: val };
                                    setFormState(p => ({ ...p, params: JSON.stringify(newParams, null, 2) }));
                                  }}
                                  style={{ ...selectStyle, flex: 1, padding: '4px 6px', height: '28px' }}
                                >
                                    <option value="">-- 常量 --</option>
                                    {allWorkflowVars.map(v => (
                                        <option key={v.value} value={v.value}>{v.label}</option>
                                    ))}
                                </select>
                                
                                {!isVariable && (
                                  <input 
                                    value={value}
                                    disabled={!isSelected}
                                    placeholder="输入值"
                                    onChange={e => {
                                      const newParams = { ...currentParsed, [param.name]: e.target.value };
                                      setFormState(p => ({ ...p, params: JSON.stringify(newParams, null, 2) }));
                                    }}
                                    style={{ 
                                      flex: 1, 
                                      height: '28px', 
                                      fontSize: '11px', 
                                      background: 'rgba(255,255,255,0.05)', 
                                      border: '1px solid rgba(255,255,255,0.1)', 
                                      borderRadius: '3px',
                                      padding: '0 8px',
                                      color: '#fff'
                                    }}
                                  />
                                )}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}

                {/* JSON Override */}
                {formState.method && (
                    <div style={{ marginTop: '4px' }}>
                        <details>
                            <summary style={{ fontSize: '10px', opacity: 0.5, cursor: 'pointer' }}>Raw JSON View</summary>
                            <textarea
                                value={formState.params}
                                onChange={e => setFormState(p => ({ ...p, params: e.target.value }))}
                                spellCheck={false}
                                style={{ ...inputStyle, fontFamily: 'monospace', height: '60px', marginTop: '4px', resize: 'vertical' }}
                            />
                        </details>
                    </div>
                )}

                {/* Extract Keys (Conditional) */}
                {formState.method && (
                  <div>
                    <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '4px' }}>从结果提取字段 (EXTRACT)</label>
                    <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '8px', maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {getMethodReturns(formState.method).map(key => (
                        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0', cursor: 'pointer', fontSize: '11px' }}>
                          <input
                            type="checkbox"
                            checked={formState.extract === key || formState.extract === `$.${key}` || formState.extract === `[0].${key}`}
                            onChange={() => {
                                // Smart Extract: If result is likely a list (search/list), use [0].
                                const isCollectionMethod = /search|list|filter/i.test(formState.method);
                                setFormState(p => ({ ...p, extract: isCollectionMethod ? `[0].${key}` : key }));
                            }}
                            style={{ accentColor: '#f59e0b' }}
                          />
                          <span style={{ fontFamily: 'monospace' }}>{key}</span>
                        </label>
                      ))}
                      {getMethodReturns(formState.method).length > 0 && <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />}
                      <input
                        value={formState.extract}
                        onChange={e => setFormState(p => ({ ...p, extract: e.target.value }))}
                        placeholder="自定义路径 (e.g. $.id, [0].id)"
                        style={{ ...inputStyle, background: 'transparent', border: 'none', padding: '4px 0', fontSize: '11px', opacity: 0.8 }}
                      />
                    </div>
                  </div>
                )}
             </>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
        <button className="service-btn small" onClick={onCancel}>CANCEL</button>
        <button 
            className="service-btn small" 
            onClick={handleSubmit} 
            style={{ borderColor: 'var(--success-color)', color: 'var(--success-color)' }}
        >
            {initialData ? 'UPDATE' : 'ADD'}
        </button>
      </div>
    </div>
  );
}
