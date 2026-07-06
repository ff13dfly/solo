import { useState, useEffect } from 'react';
import type { Keyword, Workflow } from './types';
import { callRpc } from '../../../utils/rpc';
import { useUI } from '../../../providers/UIProvider';

interface WorkflowKeywordsSectionProps {
  workflow: Workflow;
  onUpdate: () => void;
  onEditStateChange?: (isEditing: boolean) => void;
}

export default function WorkflowKeywordsSection({ workflow, onUpdate, onEditStateChange }: WorkflowKeywordsSectionProps) {
  const { toast } = useUI();
  const [keywords, setKeywords] = useState<Keyword[]>(workflow.keywords || []);
  const [newKeyword, setNewKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setKeywords(workflow.keywords || []);
  }, [workflow]);

  // Report edit state (if user has typed something)
  useEffect(() => {
    onEditStateChange?.(!!newKeyword);
  }, [newKeyword, onEditStateChange]);

  const handleUpdateKeywords = async (updatedKeywords: Keyword[]) => {
    setLoading(true);
    try {
      await callRpc('orchestrator.workflow.update', {
        id: workflow.id,
        keywords: updatedKeywords
      });
      onUpdate();
    } catch (e: any) {
      toast.error('Failed to update keywords: ' + e.message);
      // Revert local state if needed, or just let onUpdate sync it
    } finally {
      setLoading(false);
    }
  };

  const handleAddKeyword = async () => {
    if (!newKeyword.trim()) return;
    if (keywords.some(k => k.word === newKeyword.trim())) {
      toast.error('Keyword already exists');
      return;
    }
    
    const updated = [...keywords, { word: newKeyword.trim(), source: 'seed' } as Keyword];
    setKeywords(updated); // Optimistic update
    await handleUpdateKeywords(updated);
    setNewKeyword('');
  };

  const handleDeleteKeyword = async (word: string) => {
    const updated = keywords.filter(k => k.word !== word);
    setKeywords(updated); // Optimistic update
    await handleUpdateKeywords(updated);
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
      {/* Title & Description */}
      <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(88, 166, 255, 0.05)', borderRadius: '6px', border: '1px solid rgba(88, 166, 255, 0.2)' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#58a6ff', marginBottom: '6px' }}>
             工作流触发关键词 (Workflow Keywords)
          </div>
          <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: '1.5' }}>
             这些关键词定义了该工作流的“语义边界”。当用户的对话中出现类似的词汇时，智能体会考虑调用此工作流。
             <br/>
             <span style={{ color: '#58a6ff' }}>提示：输入“业务动作 + 核心对象”（如：新建房间、查询设备）效果最佳。</span>
          </div>
      </div>

      {/* Keyword Input */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        <input
          value={newKeyword}
          onChange={e => setNewKeyword(e.target.value)}
          placeholder="Add seed keyword..."
          disabled={loading}
          style={{ flex: 1, padding: '6px', background: '#1c2128', border: '1px solid #444', borderRadius: '4px', color: 'white', fontSize: '12px' }}
        />
        <button
          className="service-btn small"
          onClick={handleAddKeyword}
          disabled={!newKeyword.trim() || loading}
          style={{ borderColor: 'var(--success-color)', color: 'var(--success-color)' }}
        >
          {loading ? '...' : 'ADD'}
        </button>
      </div>

      {/* Keyword List */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {keywords.map((k, idx) => (
          <div key={`${k.word}-${idx}`} style={{
            display: 'flex',
            alignItems: 'center',
            padding: '6px 14px',
            background: k.source === 'ai' ? 'rgba(88, 166, 255, 0.15)' : 'rgba(255, 255, 255, 0.08)',
            borderRadius: '20px',
            border: k.source === 'ai' ? '1px solid rgba(88, 166, 255, 0.4)' : '1px solid rgba(255, 255, 255, 0.2)',
            fontSize: '12px',
            gap: '8px',
            color: '#fff',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
          }}>
            <span style={{ fontWeight: 500 }}>{k.word}</span>
            {k.source === 'ai' && (
              <span style={{ fontSize: '9px', opacity: 0.6, background: 'rgba(255,255,255,0.1)', padding: '0 6px', borderRadius: '4px' }}>
                AI
              </span>
            )}
            {k.source !== 'ai' && (
              <button
                onClick={() => handleDeleteKeyword(k.word)}
                disabled={loading}
                style={{ 
                    border: 'none', background: 'transparent', color: '#ff6b6b', 
                    padding: 0, cursor: 'pointer', fontSize: '14px', lineHeight: 1,
                    opacity: 0.6, marginLeft: '4px'
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {keywords.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: '12px', fontStyle: 'italic' }}>No keywords</div>
        )}
      </div>
    </div>
  );
}
