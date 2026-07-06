import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { EntityDefinition } from '../../providers/ServicesProvider';
import './DefaultPage.css';

interface EntityFormProps {
  entityDef: EntityDefinition;
  formData: any;
  onChange: (data: any) => void;
  onSubmit: (data: any) => void;
  disabled?: boolean;
}

export function EntityForm({ entityDef, formData, onChange, onSubmit, disabled }: EntityFormProps) {
  // Convert EntityDefinition to JSON Schema
  const schema: RJSFSchema = {
    type: 'object',
    required: Object.entries(entityDef.fields)
      .filter(([name, f]) => name.toLowerCase() !== 'id' && f.required)
      .map(([name]) => name),
    properties: Object.entries(entityDef.fields)
      .filter(([name]) => name.toLowerCase() !== 'id')
      .reduce((acc, [name, f]) => {
        let type = 'string';
        if (f.type === 'number') type = 'number';
        if (f.type === 'boolean') type = 'boolean';
        if (f.type === 'array') {
          acc[name] = {
            type: 'array',
            items: { type: 'string' },
            title: name.toUpperCase(),
            description: f.description,
          };
        } else if (f.type === 'object') {
          acc[name] = {
            type: 'object',
            title: name.toUpperCase(),
            description: f.description,
            // If the schema is missing properties, treat it as a flexible JSON object
            additionalProperties: true,
            default: {}
          };
        } else {
          acc[name] = {
            type,
            title: name.toUpperCase(),
            description: f.description,
          };
        }

        if (f.type === 'datetime') {
          acc[name].format = 'date-time';
        }

        return acc;
      }, {} as any),
  };

  const uiSchema: UiSchema = {
    "ui:submitButtonOptions": {
      norender: true,
    },
    "ui:globalOptions": {
      "copyable": true
    },
    "ui:options": {
      "label": true
    }
  };

  return (
    <div className="rjsf-vertical-form">
      <Form
        schema={schema}
        uiSchema={uiSchema}
        validator={validator}
        formData={formData}
        onChange={(e) => onChange(e.formData)}
        onSubmit={(e) => onSubmit(e.formData)}
        disabled={disabled}
        className="flex flex-col gap-8 w-full"
      />
      {/* 
        Scoped CSS overrides for RJSF's internal structure:
        These are still kept as a style block but could eventually move to a global rjsf.css 
      */}
      <style>{`
        .rjsf-vertical-form fieldset { display: flex !important; flex-direction: column !important; gap: 0.75rem !important; border: none !important; padding: 0 !important; margin: 0 !important; min-width: 0 !important; width: 100% !important; }
        .rjsf-vertical-form legend { display: none !important; }
        .rjsf-vertical-form .form-group { display: block !important; width: 100% !important; margin-bottom: 0 !important; clear: both !important; }
        .rjsf-vertical-form .form-group > div { display: block !important; width: 100% !important; }

        /*
          Horizontal density (operator is an efficiency console, not a sparse form):
          turn each leaf field into a 2-column grid — label left, input right — so far
          more rows fit on screen. Guarded by :has(> .control-label) so it only hits real
          labelled leaf fields; nested objects, the additionalProperties map rows, and
          checkboxes (none of which have a *direct* .control-label child) keep stacking.
        */
        .rjsf-vertical-form .form-group:has(> .control-label) {
          display: grid !important;
          grid-template-columns: 150px minmax(0, 1fr) !important;
          column-gap: 1.5rem !important;
          row-gap: 0.25rem !important;
          align-items: start !important;
        }
        .rjsf-vertical-form .form-group > .control-label {
          grid-column: 1 !important;
          margin: 0 !important;
          padding-top: 0.35rem !important;   /* align label with the column-2 help text / input */
          font-size: 0.8125rem !important;
          font-weight: 600 !important;
          color: #475569 !important;
          letter-spacing: 0.02em !important;
          text-align: right !important;
          overflow-wrap: anywhere !important;
        }
        .rjsf-vertical-form .form-group > .control-label .required { color: #ef4444 !important; margin-left: 0.2rem !important; }
        .rjsf-vertical-form .form-group:has(> .control-label) > *:not(.control-label) { grid-column: 2 !important; }
        .rjsf-vertical-form .field-description { font-size: 0.75rem !important; color: #94a3b8 !important; line-height: 1.5 !important; margin-bottom: 0.5rem !important; }
        .rjsf-vertical-form input[type="text"], 
        .rjsf-vertical-form input[type="number"], 
        .rjsf-vertical-form textarea, 
        .rjsf-vertical-form select {
          width: 100% !important;
          padding: 0.5rem 0.75rem !important;
          border: 1px solid #e2e8f0 !important;
          border-radius: 0.5rem !important;
          font-size: 0.875rem !important;
          color: #1e293b !important;
          background-color: #f8fafc !important;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
          outline: none !important;
          display: block !important;
          box-sizing: border-box !important;
          box-shadow: 0 1px 2px rgba(0,0,0,0.02) !important;
        }
        .rjsf-vertical-form input:focus, 
        .rjsf-vertical-form textarea:focus, 
        .rjsf-vertical-form select:focus {
          border-color: #3b82f6 !important;
          background-color: #ffffff !important;
          box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1) !important;
          transform: translateY(-1px) !important;
        }
        .rjsf-vertical-form .checkbox label { display: flex !important; align-items: center !important; gap: 0.75rem !important; font-size: 0.875rem !important; font-weight: 600 !important; color: #1e293b !important; cursor: pointer !important; text-transform: none !important; letter-spacing: normal !important; }
        .rjsf-vertical-form .checkbox input { width: 1.25rem !important; height: 1.25rem !important; cursor: pointer !important; border-radius: 0.25rem !important; border: 2px solid #cbd5e1 !important; }
        .rjsf-vertical-form .has-error input { border-color: #ef4444 !important; background-color: #fef2f2 !important; }
        .rjsf-vertical-form .error-detail { color: #ef4444 !important; font-size: 0.75rem !important; margin-top: 0.5rem !important; list-style: none !important; padding: 0 !important; }
        .rjsf-vertical-form .field-object > div { display: flex !important; flex-direction: column !important; gap: 0.75rem !important; }

        /*
          RJSF v6's core theme emits Bootstrap-3 markup: action buttons are
          <button class="btn btn-danger"><i class="glyphicon glyphicon-remove"/></button>.
          This project ships neither Bootstrap nor the glyphicon font, and its own
          components/ui/Button.css already owns .btn / .btn-danger — so RJSF's remove/add
          buttons collided into empty pink pills (no padding + no visible glyph).
          Re-skin them here with text glyphs; scoped to .rjsf-vertical-form so the app's
          real <Button> component (rendered outside the form) is untouched.
        */
        .rjsf-vertical-form .glyphicon { font-style: normal !important; font-family: inherit !important; line-height: 1 !important; }
        .rjsf-vertical-form .glyphicon-remove::before { content: '\\00D7'; }      /* × */
        .rjsf-vertical-form .glyphicon-plus::before { content: '\\002B'; }        /* + */
        .rjsf-vertical-form .glyphicon-arrow-up::before { content: '\\2191'; }    /* ↑ */
        .rjsf-vertical-form .glyphicon-arrow-down::before { content: '\\2193'; }  /* ↓ */
        .rjsf-vertical-form .glyphicon-copy::before { content: '\\29C9'; }        /* ⧉ */
        .rjsf-vertical-form .btn { padding: 0.375rem 0.625rem !important; font-size: 0.8125rem !important; line-height: 1 !important; min-width: 2rem !important; }
        .rjsf-vertical-form .btn-info { background: #eff6ff !important; border-color: #bfdbfe !important; color: #2563eb !important; }
        .rjsf-vertical-form .btn-info:hover:not(:disabled) { background: #dbeafe !important; border-color: #93c5fd !important; }
      `}</style>
    </div>
  );
}
