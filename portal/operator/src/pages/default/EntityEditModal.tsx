import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { EntityForm } from './EntityForm';
import { useLang } from '../../providers/LanguageProvider';
import { Button, IconButton } from '../../components/ui';
import type { EntityDefinition } from '../../providers/ServicesProvider';
import './DefaultPage.css';

interface EntityEditModalProps {
  activeEntity: string;
  editingData: any;
  editContent: string;
  setEditContent: (val: string) => void;
  saveLoading: boolean;
  saveError: string | null;
  onClose: () => void;
  onSave: () => void;
  mode?: 'edit' | 'create';
  entityDef: EntityDefinition;
  showVisualTab?: boolean;
  qrUrl?: string;
}

export function EntityEditModal({
  activeEntity,
  editingData,
  editContent,
  setEditContent,
  saveLoading,
  saveError,
  onClose,
  onSave,
  mode = 'edit',
  entityDef,
  showVisualTab = true,
  qrUrl
}: EntityEditModalProps) {
  const [tab, setTab] = useState<'visual' | 'raw'>(showVisualTab ? 'visual' : 'raw');
  const [localError, setLocalError] = useState<string | null>(null);
  const { t } = useLang();

  // Parse once per editContent change. Re-parsing on every render handed RJSF a brand-new
  // formData identity each keystroke, resetting its internal state — the cursor jumped to the
  // end and IME composition broke while typing in the visual form.
  // This hook MUST stay above the early return below (Rules of Hooks): clicking Add flips
  // editingData null→{}, which would otherwise change the hook count between renders and crash.
  const formData = useMemo(() => {
    try { return JSON.parse(editContent); } catch { return {}; }
  }, [editContent]);

  if (!editingData) return null;

  const isCreate = mode === 'create';

  const handleFormChange = (data: any) => {
    try {
      setEditContent(JSON.stringify(data, null, 2));
      setLocalError(null);
    } catch (err) {
      setLocalError(t('entity.err_form_sync'));
    }
  };

  const editorPane = (
    <>
      {tab === 'visual' ? (
        <div style={{ padding: '4px' }}>
          <EntityForm
            entityDef={entityDef}
            formData={formData}
            onChange={handleFormChange}
            onSubmit={onSave}
            disabled={saveLoading}
          />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '300px' }}>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
            className="raw-json-editor"
          />
        </div>
      )}

      {(saveError || localError) && (
        <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', color: '#b91c1c', padding: '12px 16px', borderRadius: '8px', fontSize: '13px', display: 'flex', gap: '8px' }}>
          ⚠️ <strong>{t('common.error')}:</strong> {saveError || localError}
        </div>
      )}
    </>
  );

  return createPortal(
    <div className="modal-overlay" onClick={() => !saveLoading && onClose()}>
      <div 
        className="modal" 
        onClick={e => e.stopPropagation()} 
        style={{ 
          width: qrUrl ? '1100px' : '900px', 
          height: '85vh', 
          display: 'flex', 
          flexDirection: 'column', 
          borderRadius: '16px' 
        }}
      >
        <div className="modal-header" style={{ padding: '20px 24px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '18px', color: '#1e293b', fontWeight: 700 }}>
              {isCreate ? t('default.modal_create_entity', { entity: activeEntity }) : t('default.modal_edit_entity', { entity: activeEntity })}
            </h3>
            {showVisualTab && (
              <div className="modal-header-tabs">
                <button
                  onClick={() => setTab('visual')}
                  className={`modal-tab-btn${tab === 'visual' ? ' active' : ''}`}
                >
                  {t('entity.tab_visual_form')}
                </button>
                <button
                  onClick={() => setTab('raw')}
                  className={`modal-tab-btn${tab === 'raw' ? ' active' : ''}`}
                >
                  {t('entity.tab_raw_json')}
                </button>
              </div>
            )}
          </div>
          <IconButton variant="ghost" onClick={onClose} disabled={saveLoading} style={{ fontSize: '24px', color: '#94a3b8' }}>×</IconButton>
        </div>

        {qrUrl ? (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* Left: editor */}
            <div className="modal-content" style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', background: '#ffffff', borderRight: '1px solid #f1f5f9' }}>
              {editorPane}
            </div>
            {/* Right: QR preview */}
            <div className="qr-preview-panel">
              <div className="qr-code-wrapper">
                <QRCodeSVG value={qrUrl} size={180} level="H" includeMargin={false} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '6px' }}>{t('entity.scan_to_preview')}</div>
                <div style={{ fontSize: '11px', color: '#64748b', wordBreak: 'break-all', lineHeight: 1.5, maxWidth: '220px' }}>{qrUrl}</div>
              </div>
              {editingData?.targetId && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                  <a
                    href={qrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'block', width: '100%', textAlign: 'center', padding: '8px 16px', borderRadius: '8px', background: 'var(--accent-surface, #eff6ff)', color: 'var(--accent-color, #2563eb)', border: '1px solid #dbeafe', fontSize: '12px', fontWeight: 600, textDecoration: 'none', cursor: 'pointer', boxSizing: 'border-box' }}
                  >
                    {t('entity.open_product_page')}
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="modal-content" style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', background: '#ffffff' }}>
            {editorPane}
          </div>
        )}

        <div className="modal-footer" style={{ borderTop: '1px solid #f1f5f9', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
          <div style={{ fontSize: '11px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '12px' }}>
            {!isCreate && <span>ID: <code>{editingData.id}</code></span>}
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <Button 
              variant="secondary" 
              onClick={onClose} 
              disabled={saveLoading}
            >
              {t('common.cancel')}
            </Button>
            <Button 
              variant="primary"
              onClick={onSave} 
              disabled={saveLoading}
              loading={saveLoading}
            >
              {isCreate ? t('default.modal_create_entity', { entity: activeEntity }) : t('common.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
