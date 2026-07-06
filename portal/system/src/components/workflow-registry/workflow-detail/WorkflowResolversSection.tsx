import { useState, useEffect } from 'react';
import type { Resolver, Workflow } from './types';
import { callRpc } from '../../../utils/rpc';
import { useUI } from '../../../providers/UIProvider';
import ResolverForm from './ResolverForm';

interface WorkflowResolversSectionProps {
  workflow: Workflow;
  onUpdate: () => void;
  onEditStateChange?: (isEditing: boolean) => void;
}

export default function WorkflowResolversSection({ workflow, onUpdate, onEditStateChange }: WorkflowResolversSectionProps) {
  const { toast, confirm } = useUI();
  const [resolvers, setResolvers] = useState<Record<string, Resolver>>(workflow.resolvers || {});
  
  // UI State
  const [showResolverForm, setShowResolverForm] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [selectedResolverKey, setSelectedResolverKey] = useState<string | null>(null);

  useEffect(() => {
    setResolvers(workflow.resolvers || {});
  }, [workflow]);

  // Notify parent of edit state
  const toggleForm = (show: boolean) => {
    setShowResolverForm(show);
    onEditStateChange?.(show);
    if (!show) setEditingKey(null);
  };

  // Backend Persistence
  const saveResolversToBackend = async (newResolvers: Record<string, Resolver>, successMessage: string) => {
    try {
      await callRpc('orchestrator.workflow.update', {
        id: workflow.id,
        resolvers: newResolvers
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
  const handleSave = async (key: string, resolver: Resolver) => {
    const newResolvers = { ...resolvers };
    
    // If key changed during edit (rare but possible if we allowed key edit), remove old
    if (editingKey && editingKey !== key) {
      delete newResolvers[editingKey];
    }

    newResolvers[key] = resolver;

    // Optimistic Update
    setResolvers(newResolvers);
    toggleForm(false);

    // Persist
    const msg = editingKey ? 'Resolver updated' : 'Resolver added';
    await saveResolversToBackend(newResolvers, msg);
  };

  const handleDelete = async (key: string) => {
    const isConfirmed = await confirm({
      message: `Delete resolver "${key}"?`,
      confirmLabel: 'DELETE',
      isDangerous: true
    });
    if (!isConfirmed) return;

    const newResolvers = { ...resolvers };
    delete newResolvers[key];

    setResolvers(newResolvers);
    if (selectedResolverKey === key) setSelectedResolverKey(null);

    await saveResolversToBackend(newResolvers, 'Resolver deleted');
  };

  const startEdit = (key: string) => {
    setEditingKey(key);
    toggleForm(true);
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px', position: 'relative' }}>
       
      {/* Header Action */}
      <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        {!showResolverForm && workflow.status !== 'DELETED' && (
            <button 
              className="service-btn small"
              onClick={() => toggleForm(true)}
              disabled={workflow.steps.length === 0}
              title={workflow.steps.length === 0 ? "Steps are required to add a resolver" : ""}
              style={{ 
                  fontSize: '10px', 
                  padding: '2px 8px',
                  opacity: workflow.steps.length === 0 ? 0.4 : 1,
                  cursor: workflow.steps.length === 0 ? 'not-allowed' : 'pointer'
              }}
            >
              + ADD RESOLVER
            </button>
        )}
      </div>

      {/* Form Area */}
      {showResolverForm && (
        <ResolverForm
          workflow={workflow}
          initialData={editingKey ? { key: editingKey, resolver: resolvers[editingKey] } : null}
          existingKeys={Object.keys(resolvers)}
          onSave={handleSave}
          onCancel={() => toggleForm(false)}
        />
      )}
      
      {/* Resolver List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {Object.entries(resolvers).map(([key, resolver]) => {
          const isSelected = selectedResolverKey === key;
          return (
            <div 
              key={key} 
              onClick={() => setSelectedResolverKey(isSelected ? null : key)}
              style={{ 
                padding: '12px 16px', 
                background: isSelected ? 'rgba(245, 158, 11, 0.05)' : 'rgba(0,0,0,0.3)', 
                borderRadius: '6px',
                borderLeft: isSelected ? '3px solid #f59e0b' : '3px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                position: 'relative'
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 600, color: isSelected ? '#f59e0b' : '#ccc' }}>
                  {key}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '10px', opacity: 0.5 }}>→ {resolver.extract}</span>
                  {isSelected && !showResolverForm && workflow.status !== 'DELETED' && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button 
                        className="service-btn"
                        onClick={(e) => { e.stopPropagation(); startEdit(key); }}
                        style={{ fontSize: '11px', padding: '4px 12px' }}
                      >
                        EDIT
                      </button>
                      <button 
                        className="service-btn danger"
                        onClick={(e) => { e.stopPropagation(); handleDelete(key); }}
                        style={{ fontSize: '11px', padding: '4px 12px' }}
                      >
                        DEL
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
                <span style={{ opacity: 0.5 }}>source:</span>
                <span style={{ fontFamily: 'monospace' }}>{resolver.source}</span>
                <span style={{ opacity: 0.5 }}>method:</span>
                <span style={{ fontFamily: 'monospace', color: 'var(--accent-color)' }}>{resolver.method}</span>
                <span style={{ opacity: 0.5 }}>params:</span>
                <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>{JSON.stringify(resolver.params)}</span>
              </div>
            </div>
          );
        })}
        
        {Object.keys(resolvers).length === 0 && !showResolverForm && (
          <div style={{ padding: '20px', textAlign: 'center', opacity: 0.4, fontSize: '12px' }}>
            No resolvers defined. Click + ADD RESOLVER to create one.
          </div>
        )}
      </div>
    </div>
  );
}
