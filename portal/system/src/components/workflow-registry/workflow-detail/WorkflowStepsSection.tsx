import { useState, useEffect } from 'react';
import type { WorkflowStep, Workflow } from './types';
import { callRpc } from '../../../utils/rpc';
import { useUI } from '../../../providers/UIProvider';
import StepForm from './StepForm';

interface WorkflowStepsSectionProps {
  workflow: Workflow;
  onUpdate: () => void;
  onEditStateChange?: (isEditing: boolean) => void;
}

export default function WorkflowStepsSection({ workflow, onUpdate, onEditStateChange }: WorkflowStepsSectionProps) {
  const { toast, confirm } = useUI();
  const [steps, setSteps] = useState<WorkflowStep[]>(workflow.steps || []);
  
  // UI State
  const [showStepForm, setShowStepForm] = useState(false);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // States
  const [localSynonyms, setLocalSynonyms] = useState<Record<string, string[]>>(workflow.synonyms || {});
  const [inlineInputs, setInlineInputs] = useState<Record<string, string>>({});

  // Reset states when workflow ID changes
  useEffect(() => {
    setSteps(workflow.steps || []);
    setLocalSynonyms(workflow.synonyms || {});
    setRequiredSet(new Set(workflow.required_inputs || []));
  }, [workflow.id]);

  // Input Extraction
  const extractInputs = (currentSteps: WorkflowStep[]) => {
      const inputs = new Set<string>();
      const regex = /\$input\.([a-zA-Z0-9_]+)/g;
      
      const scan = (obj: any) => {
          if (!obj) return;
          if (typeof obj === 'string') {
              let match;
              while ((match = regex.exec(obj)) !== null) {
                  inputs.add(match[1]);
              }
          } else if (typeof obj === 'object') {
              Object.values(obj).forEach(scan);
          }
      };
      
      currentSteps.forEach(s => scan(s.params));
      return Array.from(inputs).sort();
  };

  const detectedInputs = extractInputs(steps);
  const [requiredSet, setRequiredSet] = useState<Set<string>>(new Set(workflow.required_inputs || []));

  // Toggle Required
  const toggleRequired = async (inputName: string, isRequired: boolean) => {
      const next = new Set(requiredSet);
      if (isRequired) next.add(inputName);
      else next.delete(inputName);
      
      setRequiredSet(next);
      
      // Calculate arrays
      const reqList = Array.from(next).filter(i => detectedInputs.includes(i));
      const optList = detectedInputs.filter(i => !next.has(i));

      // Auto-save input config
      try {
        await callRpc('orchestrator.workflow.update', {
            id: workflow.id,
            required_inputs: reqList,
            optional_inputs: optList,
            synonyms: localSynonyms
        });
        toast.success(`Marked ${inputName} as ${isRequired ? 'Required' : 'Optional'}`);
        onUpdate();
      } catch(e: any) {
        toast.error('Failed to update input config');
      }
  };

  // Synonyms Logic
  const addSynonym = async (keyInput?: string, valInput?: string) => {
    const key = (keyInput || '').trim();
    const val = (valInput || '').trim();
    if (!key || !val) return;
    
    // Parse commas for multi-alias input
    const newAliases = val.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (newAliases.length === 0) return;

    const nextSynonyms = { ...localSynonyms };
    const currentList = nextSynonyms[key] || [];
    const combined = [...currentList];
    for (const alias of newAliases) {
        if (!combined.includes(alias)) {
            combined.push(alias);
        }
    }
    nextSynonyms[key] = combined;

    setLocalSynonyms(nextSynonyms);
    setInlineInputs(prev => ({ ...prev, [key]: '' }));

    // Auto-save synonyms
    try {
        const reqList = Array.from(requiredSet).filter(i => detectedInputs.includes(i));
        const optList = detectedInputs.filter(i => !requiredSet.has(i));
        await callRpc('orchestrator.workflow.update', {
            id: workflow.id,
            synonyms: nextSynonyms,
            required_inputs: reqList,
            optional_inputs: optList
        });
        toast.success('Synonyms updated');
        onUpdate();
    } catch(e) {
        toast.error('Failed to save synonyms');
    }
  };


  const removeSynonymValue = async (key: string, val: string) => {
    const nextSynonyms = { ...localSynonyms };
    const list = nextSynonyms[key] || [];
    const nextList = list.filter(v => v !== val);
    if (nextList.length === 0) {
        delete nextSynonyms[key];
    } else {
        nextSynonyms[key] = nextList;
    }
    setLocalSynonyms(nextSynonyms);

    try {
        const reqList = Array.from(requiredSet).filter(i => detectedInputs.includes(i));
        const optList = detectedInputs.filter(i => !requiredSet.has(i));
        await callRpc('orchestrator.workflow.update', {
            id: workflow.id,
            synonyms: nextSynonyms,
            required_inputs: reqList,
            optional_inputs: optList
        });
        onUpdate();
    } catch(e) {}
  };

  // Notify parent of edit state
  const toggleForm = (show: boolean) => {
    setShowStepForm(show);
    onEditStateChange?.(show);
    if (!show) setEditingStepId(null);
  };

  // Backend Persistence
  const saveStepsToBackend = async (newSteps: WorkflowStep[], successMessage: string) => {
    try {
      // Calculate inputs for this update
      const allInputs = extractInputs(newSteps);
      const reqList = Array.from(requiredSet).filter(i => allInputs.includes(i));
      const optList = allInputs.filter(i => !requiredSet.has(i));

      await callRpc('orchestrator.workflow.update', {
        id: workflow.id,
        steps: newSteps,
        required_inputs: reqList,
        optional_inputs: optList,
        synonyms: localSynonyms
      });
      toast.success(successMessage);
      onUpdate();
    } catch (e: any) {
      toast.error('Update failed: ' + e.message);
      // Revert local state on error (optional)
      onUpdate(); 
    }
  };

  // Actions
  const handleSave = async (step: WorkflowStep) => {
    let newSteps = [...steps];
    
    if (editingStepId) {
      // Edit existing
      const idx = newSteps.findIndex(s => s.id === editingStepId);
      if (idx !== -1) {
        newSteps[idx] = step;
      }
    } else {
      // Add new
      if (selectedStepId) {
        const insertIdx = newSteps.findIndex(s => s.id === selectedStepId);
        if (insertIdx !== -1) {
          // Insert after selected
          newSteps.splice(insertIdx + 1, 0, step);
        } else {
          newSteps.push(step);
        }
      } else {
        newSteps.push(step);
      }
    }

    // Optimistic Update
    setSteps(newSteps);
    toggleForm(false);

    // Persist
    const msg = editingStepId ? 'Step updated' : 'Step added';
    await saveStepsToBackend(newSteps, msg);
  };

  const handleDelete = async (stepId: string) => {
    const isConfirmed = await confirm({
      message: `Delete step "${stepId}"?`,
      confirmLabel: 'DELETE',
      isDangerous: true
    });
    if (!isConfirmed) return;

    const newSteps = steps.filter(s => s.id !== stepId);

    setSteps(newSteps);
    if (selectedStepId === stepId) setSelectedStepId(null);

    await saveStepsToBackend(newSteps, 'Step deleted');
  };

  const startEdit = (stepId: string) => {
    setEditingStepId(stepId);
    toggleForm(true);
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px', position: 'relative' }}>
       
      {/* Input Configuration Panel (Keywords/Synonyms) */}
      {!showStepForm && detectedInputs.length > 0 && (
          <div style={{ padding: '16px', background: 'rgba(245, 158, 11, 0.05)', borderRadius: '6px', marginBottom: '16px', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
              <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#f59e0b', marginBottom: '4px' }}>
                    关键参数配置 (Keywords & Synonyms)
                  </div>
                  <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: '1.4' }}>
                    设置参数别名（关键词）有助于 Agent 准确理解用户意图。
                    例如：将“仓库名称”设置为 <code>query</code> 的别名，Agent 就能在用户提到该名称时自动提取数据。
                  </div>
              </div>

              <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', opacity: 0.7, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '4px' }}>
                  <span>检测到的输入项 (DETECTED INPUTS)</span>
                  <span style={{ fontSize: '10px', opacity: 0.5 }}>勾选设为必填 | 维护语义别名</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {detectedInputs.map(input => {
                      const isRequired = requiredSet.has(input);
                      const aliases = localSynonyms[input] || [];
                      return (
                          <div key={input} style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'space-between',
                            padding: '4px 8px',
                            background: 'rgba(255,255,255,0.02)',
                            borderRadius: '4px'
                          }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
                                  <input 
                                      type="checkbox" 
                                      checked={isRequired}
                                      onChange={(e) => toggleRequired(input, e.target.checked)}
                                      style={{ cursor: 'pointer' }}
                                  />
                                  <span style={{ color: isRequired ? '#f59e0b' : '#c9d1d9', fontFamily: 'monospace', fontWeight: isRequired ? 600 : 400 }}>
                                      {input}
                                  </span>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                  {aliases.length > 0 && (
                                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                          {aliases.map(v => (
                                              <span key={v} style={{ 
                                                  fontSize: '10px', 
                                                  background: 'rgba(245, 158, 11, 0.2)', 
                                                  color: '#fdb44b', 
                                                  padding: '2px 8px', 
                                                  borderRadius: '12px',
                                                  border: '1px solid rgba(245, 158, 11, 0.4)',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '6px',
                                                  fontWeight: 500
                                              }}>
                                                {v}
                                                <button 
                                                    onClick={() => removeSynonymValue(input, v)}
                                                    style={{ 
                                                        background: 'none', border: 'none', color: '#fdb44b', 
                                                        fontSize: '12px', cursor: 'pointer', padding: '0 2px',
                                                        opacity: 0.6, display: 'flex', alignItems: 'center',
                                                        transition: 'opacity 0.2s'
                                                    }}
                                                    onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                                    onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
                                                >×</button>
                                              </span>
                                          ))}
                                      </div>
                                  )}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
                                    <input 
                                      value={inlineInputs[input] || ''}
                                      onChange={e => setInlineInputs(prev => ({ ...prev, [input]: e.target.value }))}
                                      placeholder="Alias..."
                                      style={{ 
                                          background: 'rgba(255,255,255,0.05)',
                                          border: '1px solid #444c56',
                                          borderRadius: '4px 0 0 4px',
                                          color: 'white',
                                          fontSize: '11px',
                                          padding: '3px 10px',
                                          width: '90px',
                                          outline: 'none',
                                          transition: 'border-color 0.2s'
                                      }}
                                      onFocus={e => e.currentTarget.style.borderColor = '#58a6ff'}
                                      onBlur={e => e.currentTarget.style.borderColor = '#444c56'}
                                    />
                                    <button 
                                      onClick={() => addSynonym(input, inlineInputs[input])}
                                      disabled={!(inlineInputs[input] || '').trim()}
                                      className="service-btn"
                                      style={{ 
                                          padding: '3px 8px',
                                          fontSize: '10px',
                                          borderRadius: '0 4px 4px 0',
                                          fontWeight: 600,
                                          background: 'rgba(88, 166, 255, 0.1)',
                                          border: '1px solid #444c56',
                                          borderLeft: 'none',
                                          color: '#58a6ff',
                                          cursor: (inlineInputs[input] || '').trim() ? 'pointer' : 'default',
                                          opacity: (inlineInputs[input] || '').trim() ? 1 : 0.4
                                      }}
                                    >
                                      ADD
                                    </button>
                                  </div>
                              </div>
                          </div>
                      );
                  })}
              </div>
          </div>
      )}

      {/* Header Action */}
      <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        {!showStepForm && workflow.status !== 'DELETED' && (
            <button 
              className="service-btn small"
              onClick={() => toggleForm(true)}
              style={{ fontSize: '10px', padding: '2px 8px' }}
            >
              + ADD STEP
            </button>
        )}
      </div>

      {/* Form Area */}
      {showStepForm && (
        <StepForm
          initialData={editingStepId ? steps.find(s => s.id === editingStepId) : null}
          existingIds={steps.map(s => s.id)}
          allSteps={steps}
          onSave={handleSave}
          onCancel={() => toggleForm(false)}
        />
      )}
      
      {/* Step List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {steps.map((step, idx) => {
          const isSelected = selectedStepId === step.id;
          return (
            <div 
              key={step.id} 
              onClick={() => setSelectedStepId(isSelected ? null : step.id)}
              style={{ 
                padding: '12px 16px', 
                background: isSelected ? 'rgba(245, 158, 11, 0.05)' : 'rgba(0,0,0,0.3)', 
                borderRadius: '6px',
                borderLeft: isSelected ? '3px solid #f59e0b' : '3px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                position: 'relative'
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', minHeight: '28px' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                  <span style={{ opacity: 0.4 }}>#{idx + 1}</span>{' '}
                  <span style={{ color: isSelected ? '#f59e0b' : 'var(--accent-color)' }}>{step.service}</span>
                  <span style={{ opacity: 0.5 }}>.</span>
                  <span style={{ fontWeight: 500 }}>{step.method}</span>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '10px', opacity: 0.4 }}>{step.id}</span>
                    {isSelected && !showStepForm && workflow.status !== 'DELETED' && (
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button 
                          className="service-btn"
                          onClick={(e) => { e.stopPropagation(); startEdit(step.id); }}
                          style={{ fontSize: '11px', padding: '4px 12px' }}
                        >
                          EDIT
                        </button>
                        <button 
                          className="service-btn danger"
                          onClick={(e) => { e.stopPropagation(); handleDelete(step.id); }}
                          style={{ fontSize: '11px', padding: '4px 12px' }}
                        >
                          DEL
                        </button>
                      </div>
                    )}
                </div>
              </div>
              {Object.keys(step.params || {}).length > 0 && (
                <div style={{ fontSize: '11px', opacity: 0.6, marginTop: '4px' }}>
                  Params: {JSON.stringify(step.params)}
                </div>
              )}
            </div>
          );
        })}
        
        {steps.length === 0 && !showStepForm && (
          <div style={{ padding: '20px', textAlign: 'center', opacity: 0.4, fontSize: '12px' }}>
            No steps defined. Click + ADD STEP to create one.
          </div>
        )}
      </div>
    </div>
  );
}
