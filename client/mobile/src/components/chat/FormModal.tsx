import React from 'react';
import { DynamicForm, type FieldDefinition } from '../form/DynamicForm';

interface FormModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fields: FieldDefinition[];
  onSubmit: (values: Record<string, any>) => void;
  submitText?: string;
}

export const FormModal: React.FC<FormModalProps> = ({
  isOpen,
  onClose,
  title,
  fields,
  onSubmit,
  submitText
}) => {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '20px',
    }}>
      <div style={{
        background: 'white',
        borderRadius: '16px',
        padding: '24px',
        maxWidth: '400px',
        maxHeight: '90vh',
        width: '100%',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}>
        {/* Header */}
        <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
            flexShrink: 0
        }}>
            <h2 style={{
            margin: 0,
            fontSize: '20px',
            fontWeight: 600,
            color: '#1a1a1a',
            }}>
            {title}
            </h2>
            <button 
                onClick={onClose}
                style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '24px',
                    color: '#9ca3af',
                    cursor: 'pointer',
                    padding: '4px'
                }}
            >
                ×
            </button>
        </div>

        {/* Dynamic Form Scrollable Container */}
        <div style={{ flex: 1, minHeight: 0 }}>
            <DynamicForm 
                fields={fields}
                onSubmit={onSubmit}
                submitText={submitText}
            />
        </div>
      </div>
    </div>
  );
};
