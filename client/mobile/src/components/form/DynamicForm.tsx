import React, { useState } from 'react';
import { UI_CONFIG } from '../../config';

export interface FieldDefinition {
  name: string;
  type: 'text' | 'string' | 'number' | 'boolean' | 'selector' | 'mobile';
  label: string;
  required?: boolean;
  options?: { label: string; value: any }[]; // For selector
  defaultValue?: any;
  placeholder?: string;
}

interface DynamicFormProps {
  fields: FieldDefinition[];
  onSubmit: (values: Record<string, any>) => void;
  submitText?: string;
  initialValues?: Record<string, any>;
}

export const DynamicForm: React.FC<DynamicFormProps> = ({
  fields,
  onSubmit,
  submitText = '提交',
  initialValues = {},
}) => {
  const [formValues, setFormValues] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = { ...initialValues };
    fields.forEach(field => {
      if (initial[field.name] === undefined) {
        if (field.defaultValue !== undefined) {
          initial[field.name] = field.defaultValue;
        } else if (field.type === 'boolean') {
          initial[field.name] = false;
        } else {
          initial[field.name] = '';
        }
      }
    });
    return initial;
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    let isValid = true;

    fields.forEach(field => {
      const value = formValues[field.name];

      // Required check
      if (field.required && (value === undefined || value === '' || value === null)) {
        newErrors[field.name] = `${field.label} 是必填项`;
        isValid = false;
      }

      // Type specific validation
      if (value) {
        if (field.type === 'mobile') {
          // Standard CN phone regex
          const mobileRegex = /^1[3-9]\d{9}$/;
          if (!mobileRegex.test(value)) {
            newErrors[field.name] = '请输入正确的手机号码';
            isValid = false;
          }
        } else if (field.type === 'number') {
           if (isNaN(Number(value))) {
             newErrors[field.name] = '请输入有效的数字';
             isValid = false;
           }
        }
      }
    });

    setErrors(newErrors);
    return isValid;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(formValues);
    }
  };

  const handleChange = (name: string, value: any) => {
    setFormValues(prev => ({ ...prev, [name]: value }));
    // Clear error for field on change
    if (errors[name]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[name];
        return newErrors;
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ 
          height: `${UI_CONFIG.FORM_MODAL_HEIGHT_PERCENTAGE}vh`, 
          overflowY: 'auto', 
          paddingRight: '4px' 
      }}>
        {fields.map((field) => (
          <div key={field.name} style={{ marginBottom: '16px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: 500,
              color: '#374151',
            }}>
              {field.label}
              {field.required && <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>}
            </label>

            {/* Render Input based on type */}
            {field.type === 'boolean' ? (
               <div 
                 onClick={() => handleChange(field.name, !formValues[field.name])}
                 style={{
                   display: 'flex',
                   alignItems: 'center',
                   cursor: 'pointer'
                 }}
               >
                  <div style={{
                    width: '44px',
                    height: '24px',
                    borderRadius: '12px',
                    background: formValues[field.name] ? '#10b981' : '#e5e7eb',
                    position: 'relative',
                    transition: 'background-color 0.2s',
                    marginRight: '8px'
                  }}>
                    <div style={{
                      position: 'absolute',
                      top: '2px',
                      left: formValues[field.name] ? '22px' : '2px',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      background: 'white',
                      transition: 'left 0.2s',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
                    }} />
                  </div>
                  <span style={{ fontSize: '14px', color: '#6b7280' }}>
                    {formValues[field.name] ? '是' : '否'}
                  </span>
               </div>
            ) : field.type === 'selector' ? (
              <select
                value={formValues[field.name]}
                onChange={(e) => handleChange(field.name, e.target.value)}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: errors[field.name] ? '1px solid #ef4444' : '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '14px',
                  outline: 'none',
                  backgroundColor: 'white',
                  boxSizing: 'border-box',
                }}
              >
                <option value="">请选择</option>
                {field.options?.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={field.type === 'number' ? 'number' : field.type === 'mobile' ? 'tel' : 'text'}
                value={formValues[field.name]}
                onChange={(e) => handleChange(field.name, e.target.value)}
                placeholder={field.placeholder || `请输入${field.label}`}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: errors[field.name] ? '1px solid #ef4444' : '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '14px',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => {
                   if (!errors[field.name]) e.target.style.borderColor = '#667eea';
                }}
                onBlur={(e) => {
                   if (!errors[field.name]) e.target.style.borderColor = '#d1d5db';
                }}
              />
            )}

            {errors[field.name] && (
              <div style={{ fontSize: '12px', color: '#ef4444', marginTop: '4px' }}>
                {errors[field.name]}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ padding: '8px 0 0 0', flexShrink: 0 }}>
        <button
          onClick={handleSubmit}
          style={{
            width: '100%',
            padding: '14px',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'transform 0.2s',
          }}
          onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.98)'}
          onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}
          onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
        >
          {submitText}
        </button>
      </div>
    </div>
  );
};
