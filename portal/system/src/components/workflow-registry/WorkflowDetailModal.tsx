import { useState } from 'react';
import { useUI } from '../../providers/UIProvider';
import type { Workflow } from './workflow-detail/types';
import WorkflowBasicSection from './workflow-detail/WorkflowBasicSection';
import WorkflowStepsSection from './workflow-detail/WorkflowStepsSection';
import WorkflowResolversSection from './workflow-detail/WorkflowResolversSection';
import WorkflowKeywordsSection from './workflow-detail/WorkflowKeywordsSection';
import WorkflowPromptsSection from './workflow-detail/WorkflowPromptsSection';

interface WorkflowDetailModalProps {
  workflow: Workflow;
  onClose: () => void;
  onUpdate: () => void;
}

export default function WorkflowDetailModal({ workflow, onClose, onUpdate }: WorkflowDetailModalProps) {
  type SectionType = 'BASIC' | 'PROMPTS' | 'STEPS' | 'RESOLVERS' | 'KEYWORDS';
  const [activeSection, setActiveSection] = useState<SectionType>('BASIC');
  const [isChildEditing, setIsChildEditing] = useState(false);
  const { } = useUI();

  const handleEditStateChange = (isEditing: boolean) => {
    setIsChildEditing(isEditing);
  };

  const handleMaskClick = () => {
    if (isChildEditing) return;
    onClose();
  };

  const sections: { id: SectionType; label: string; subtitle?: string; count?: number }[] = [
    { id: 'BASIC', label: 'WORKFLOW BASIC' },
    { id: 'PROMPTS', label: 'PROMPTS & INTENT', subtitle: 'AI matching config' },
    { id: 'STEPS', label: `WORKFLOW STEPS (${workflow.steps?.length || 0})` },
    { id: 'RESOLVERS', label: `RESOLVERS (${workflow.resolvers ? Object.keys(workflow.resolvers).length : 0})`, subtitle: 'Name → ID auto-lookup' },
    { id: 'KEYWORDS', label: `KEYWORDS (${workflow.keywords?.length || 0})`, subtitle: 'Semantic tags' },
  ];

  const sectionComponents: Record<SectionType, React.ReactNode> = {
    BASIC: <WorkflowBasicSection workflow={workflow} onUpdate={onUpdate} onEditStateChange={handleEditStateChange} />,
    PROMPTS: <WorkflowPromptsSection workflow={workflow} onUpdate={onUpdate} onEditStateChange={handleEditStateChange} />,
    STEPS: <WorkflowStepsSection workflow={workflow} onUpdate={onUpdate} onEditStateChange={handleEditStateChange} />,
    RESOLVERS: <WorkflowResolversSection workflow={workflow} onUpdate={onUpdate} onEditStateChange={handleEditStateChange} />,
    KEYWORDS: <WorkflowKeywordsSection workflow={workflow} onUpdate={onUpdate} onEditStateChange={handleEditStateChange} />,
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999] backdrop-blur-sm"
      onClick={handleMaskClick}
    >
      <div
        className="w-[800px] h-[80vh] flex flex-col bg-bg-primary border border-border shadow-[0_12px_48px_rgba(0,0,0,0.6)] rounded-lg"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span>WORKFLOW :: {workflow.id.toUpperCase()}</span>
            {workflow.status === 'DELETED' && (
              <span className="text-[10px] px-1.5 py-0.5 bg-error/20 text-error rounded">
                DELETED
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="border-none bg-transparent text-text-secondary p-0 text-lg cursor-pointer hover:text-error transition-colors"
          >
            ×
          </button>
        </div>

        {/* Content with Accordion */}
        <div className="flex-1 overflow-hidden flex flex-col p-0">
          {sections.map(section => (
            <div key={section.id} className={`flex flex-col overflow-hidden ${activeSection === section.id ? 'flex-1' : 'flex-[0_0_auto]'}`}>
              <div
                onClick={() => setActiveSection(section.id)}
                className={`px-4 py-3 bg-bg-secondary border-b border-border cursor-pointer flex items-center justify-between font-semibold text-xs ${activeSection === section.id ? 'text-accent' : 'text-text-primary'
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span>{section.label}</span>
                  {section.subtitle && (
                    <span className="text-[10px] opacity-50 font-normal">{section.subtitle}</span>
                  )}
                </div>
                <span className="text-[10px] opacity-70">{activeSection === section.id ? '▼' : '▶'}</span>
              </div>
              {activeSection === section.id && (
                <div className="flex-1 overflow-y-auto">
                  {sectionComponents[section.id]}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
