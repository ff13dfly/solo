
import { useState, useEffect, useMemo } from 'react';
import type { Workflow } from './types';
import { callRpc } from '../../../utils/rpc';
import { useUI } from '../../../providers/UIProvider';

interface WorkflowPromptsSectionProps {
  workflow: Workflow;
  onUpdate: () => void;
  onEditStateChange?: (isEditing: boolean) => void;
}

export default function WorkflowPromptsSection({ workflow, onUpdate, onEditStateChange }: WorkflowPromptsSectionProps) {
  const { toast } = useUI();
  const [saving, setSaving] = useState(false);

  // Lock modal close on mount (Always Edit Mode)
  useEffect(() => {
    onEditStateChange?.(true);
    return () => onEditStateChange?.(false);
  }, [onEditStateChange]);

  // Local State
  const [txtExamples, setTxtExamples] = useState('');
  const [txtNegative, setTxtNegative] = useState('');
  const [localPriority, setLocalPriority] = useState(0);

  // Initialization
  useEffect(() => {
    setTxtExamples((workflow.examples || []).join('\n'));
    setTxtNegative((workflow.negative || []).join('\n'));
    setLocalPriority(workflow.priority || 0);
  }, [workflow]);

  // Dirty Check
  const isDirty = useMemo(() => {
    const currentExamples = txtExamples.split('\n').map(t => t.trim()).filter(Boolean).join(',');
    const origExamples = (workflow.examples || []).join(',');

    const currentNegative = txtNegative.split('\n').map(t => t.trim()).filter(Boolean).join(',');
    const origNegative = (workflow.negative || []).join(',');

    const priorityChanged = localPriority !== (workflow.priority || 0);

    return currentExamples !== origExamples || currentNegative !== origNegative || priorityChanged;
  }, [txtExamples, txtNegative, localPriority, workflow]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await callRpc('orchestrator.workflow.update', {
        id: workflow.id,
        examples: txtExamples.split('\n').map(t => t.trim()).filter(Boolean),
        negative: txtNegative.split('\n').map(t => t.trim()).filter(Boolean),
        priority: localPriority
      });
      toast.success('Prompts updated');
      onUpdate();
    } catch (e: any) {
      toast.error('Update failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ padding: '16px', background: 'rgba(0,0,0,0.1)' }}>
          {/* Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
              <button 
                className="service-btn small success"
                onClick={handleSave}
                disabled={!isDirty || saving}
                style={{ 
                    opacity: isDirty ? 1 : 0.3, 
                    pointerEvents: isDirty ? 'auto' : 'none',
                    padding: '4px 16px',
                    fontSize: '11px'
                }}
               >
                 {saving ? 'SAVING...' : 'UPDATE'}
               </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
             
             {/* PRIORITY */}
             <div>
                <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', opacity: 0.7 }}>
                    MATCH PRIORITY <span style={{opacity:0.5, fontWeight:400}}>(0-100)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input 
                        type="number"
                        min="0"
                        max="100"
                        value={localPriority}
                        onChange={e => setLocalPriority(parseInt(e.target.value) || 0)}
                        style={{ 
                            width: '80px', 
                            background: '#1c2128', border: '1px solid #444', 
                            color: 'white', fontSize: '12px', padding: '6px 8px',
                            borderRadius: '4px'
                        }}
                    />
                    <div style={{ fontSize: '11px', opacity: 0.5 }}>
                        Higher priority wins when AI scores are similar.
                    </div>
                </div>
             </div>

             {/* EXAMPLES */}
             <div>
                <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', opacity: 0.7 }}>
                    POSITIVE EXAMPLES <span style={{opacity:0.5, fontWeight:400}}>(Triggers)</span>
                </div>
                <textarea
                    value={txtExamples}
                    onChange={e => setTxtExamples(e.target.value)}
                    placeholder="Book a meeting..."
                    style={{ 
                        width: '100%', minHeight: '80px', 
                        background: '#1c2128', border: '1px solid #444', 
                        color: 'white', fontSize: '12px', padding: '8px',
                        fontFamily: 'monospace', borderRadius: '4px'
                    }}
                />
             </div>

             {/* NEGATIVE */}
             <div>
                <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', opacity: 0.7 }}>
                    NEGATIVE EXAMPLES <span style={{opacity:0.5, fontWeight:400}}>(Anti-patterns)</span>
                </div>
                <textarea
                    value={txtNegative}
                    onChange={e => setTxtNegative(e.target.value)}
                    placeholder="Cancel meeting..."
                    style={{ 
                        width: '100%', minHeight: '60px', 
                        background: '#1c2128', border: '1px solid #444', 
                        color: 'white', fontSize: '12px', padding: '8px',
                        fontFamily: 'monospace', borderRadius: '4px'
                    }}
                />
             </div>

          </div>
    </div>
  );
}
