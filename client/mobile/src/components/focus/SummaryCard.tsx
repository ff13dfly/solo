/**
 * Focus Summary Card Component
 * Displays current Focus state with params, progress, and actions
 */

import React, { useState } from 'react';
import type { FocusState, FocusStatus } from '../../types/focus';
import './SummaryCard.css';

interface SummaryCardProps {
  focusState: FocusState;
  onConfirm: () => void;
  onCancel: () => void;
  onFieldClick?: (field: string) => void;
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
  focusState,
  onConfirm,
  onCancel,
  onFieldClick
}) => {
  const { workflowDef, currentParams, missingFields, status, executionProgress } = focusState;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (field: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  };

  // Helper to format values
  const formatParamValue = (val: any): string => {
    if (typeof val === 'string' && val.includes('T') && val.includes('+')) {
      // Try to parse as date
      try {
        const date = new Date(val);
        if (!isNaN(date.getTime())) {
           // Format: YYYY-MM-DD HH:mm
           return date.toLocaleString('zh-CN', {
             year: 'numeric',
             month: '2-digit',
             day: '2-digit',
             hour: '2-digit',
             minute: '2-digit',
             hour12: false
           }).replace(/\//g, '-');
        }
      } catch (e) {
        // ignore
      }
    }
    return String(val);
  };

  if (!workflowDef) return null;

  // Calculate progress
  const totalFields = workflowDef.required_inputs?.length || 0;
  const filledCount = totalFields - missingFields.length;
  const progressText = `[${filledCount}/${totalFields}]`;

  // Status icon
  const getStatusIcon = (status: FocusStatus) => {
    switch (status) {
      case 'collecting': return '📝';
      case 'pending': return '✅';
      case 'executing': return '⏳';
      case 'completed': return '🎉';
      case 'failed': return '❗';
      default: return '📋';
    }
  };

  // Render param value
  const renderParamValue = (field: string) => {
    // Check if this field is an object with sub-fields (e.g., "updates")
    const paramDef = workflowDef.params?.find(p => p.name === field);
    
    // If it has sub-fields, render them as a group
    if (paramDef?.fields && paramDef.fields.length > 0) {
       const parentValue = currentParams[field] || {};
       
       const isCollapsed = collapsedGroups.has(field);
       
       return (
          <div key={field} className="param-group">
            <div 
              className="param-group-header" 
              onClick={() => toggleGroup(field)}
              style={{ cursor: 'pointer' }}
            >
              <span className="toggle-icon">{isCollapsed ? '+' : '−'}</span>
              {paramDef.description || field}
            </div>
            {!isCollapsed && (
              <div className="param-group-content">
                {paramDef.fields.map((subField: any) => {
                   const subValue = parentValue[subField.name];
                   const isFilled = subValue !== undefined && subValue !== null && subValue !== '';
                   // Construct a unique key for the subfield click handler
                   const clickKey = `${field}.${subField.name}`;
                   
                   return (
                     <div 
                       key={subField.name}
                       className={`param-row ${isFilled ? 'filled' : 'missing'}`}
                       onClick={() => onFieldClick?.(clickKey)}
                     >
                       <span className="param-icon">{isFilled ? '✅' : '⬜'}</span>
                       <span className="param-label">{subField.description || subField.name}</span>
                       <span className="param-value">
                         {isFilled ? formatParamValue(subValue) : '待填写'}
                       </span>
                     </div>
                   );
                })}
              </div>
            )}
          </div>
       );
    }

    // Default rendering for simple fields
    const value = currentParams[field];
    const isFilled = value !== undefined && value !== null && value !== '';
    const confidence = focusState.confidence[field];

    // Helper to resolve display label from synonyms
    const getFieldLabel = (f: string): string => {
      const fieldSynonyms = workflowDef.synonyms?.[f];
      if (Array.isArray(fieldSynonyms) && fieldSynonyms.length > 0) {
        return fieldSynonyms[0]; // Use the first synonym as the primary label
      }
      return f;
    };

    return (
      <div 
        key={field}
        className={`param-row ${isFilled ? 'filled' : 'missing'}`}
        onClick={() => onFieldClick?.(field)}
      >
        <span className="param-icon">{isFilled ? '✅' : '⬜'}</span>
        <span className="param-label">{getFieldLabel(field)}</span>
        <span className="param-value">
          {isFilled ? formatParamValue(value) : '待填写'}
          {confidence && <span className="text-xs text-gray-400 ml-1">({Math.round(confidence * 100)}%)</span>}
        </span>
      </div>
    );
  };

  return (
    <div className={`summary-card status-${status}`}>
      {/* Header */}
      <div className="card-header">
        <span className="status-icon">{getStatusIcon(status)}</span>
        <span className="workflow-name">{workflowDef.name}</span>
        <span className="progress-indicator">{progressText}</span>
      </div>

      {/* Progress Bar */}
      {status === 'executing' && (
        <div className="progress-bar-container">
          <div 
            className="progress-bar" 
            style={{ width: `${executionProgress || 0}%` }}
          />
        </div>
      )}

      {/* Params List */}
      <div className="params-list">
        {workflowDef.required_inputs?.map(field => renderParamValue(field))}
      </div>



      {/* Action Buttons */}
      {(status === 'pending' || status === 'collecting') && (
        <div className="action-buttons">
          <button className="btn-cancel" onClick={onCancel}>取消</button>
          {status === 'pending' && (
            <button className="btn-confirm" onClick={onConfirm}>✓ 确认执行</button>
          )}
        </div>
      )}

      {status === 'completed' && (
        <div className="completed-message">
          ✨ 操作完成！
        </div>
      )}

      {status === 'failed' && (
        <div className="action-buttons">
          <button className="btn-cancel" onClick={onCancel}>关闭</button>
          <button className="btn-retry" onClick={onConfirm}>重试</button>
        </div>
      )}
    </div>
  );
};

export default SummaryCard;
