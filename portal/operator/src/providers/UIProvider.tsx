import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { FieldConfig } from '../pages/default/fieldConfig';
import { Button, IconButton } from '../components/ui';

// --- Types ---
type ToastType = 'success' | 'error' | 'info';
type ViewMode = 'table' | 'card' | 'gallery';

const DEFAULT_VIEW_MODE: ViewMode = 'card';
const VIEW_MODES_KEY = 'solomind:view_modes';      // per-{service}_{entity} map
const LEGACY_VIEW_MODE_KEY = 'solomind:view_mode'; // pre-scope global preference — now only the fallback default
const LIST_FIELDS_KEY = 'solomind:list_fields';    // per-{service}_{entity} field visibility + order

const fieldConfigEmpty = (c?: FieldConfig | null) =>
  !c || ((!c.order || !c.order.length) && (!c.hidden || !c.hidden.length));

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDangerous?: boolean;
}

interface UIContextType {
  toast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
  };
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  isCollapsed: boolean;
  setIsCollapsed: (v: boolean) => void;
  // View mode is remembered per `{serviceId}_{entity}` scope, so each list keeps its own
  // table/card/gallery habit instead of all lists sharing one global toggle.
  getViewMode: (scope?: string) => ViewMode;
  setViewMode: (scope: string, mode: ViewMode) => void;
  // Field visibility + order, also remembered per `{serviceId}_{entity}` scope.
  getFieldConfig: (scope: string) => FieldConfig | null;
  setFieldConfig: (scope: string, config: FieldConfig | null) => void;
}

const UIContext = createContext<UIContextType | null>(null);

export const useUI = () => {
  const context = useContext(UIContext);
  if (!context) throw new Error('useUI must be used within UIProvider');
  return context;
};

// --- Components ---

const ToastItem = ({ toast, onClose }: { toast: Toast; onClose: (id: string) => void }) => {
  const styles: any = {
    container: {
      background: '#ffffff', // White for office theme
      border: '1px solid #e5e7eb',
      borderLeftWidth: '4px',
      borderRadius: '6px',
      padding: '12px 16px',
      marginBottom: '12px',
      color: '#1f2937', // Dark gray text
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      minWidth: '300px',
      maxWidth: '400px',
      animation: 'slideIn 0.3s ease-out'
    },
    success: { borderLeftColor: '#10b981' },
    error: { borderLeftColor: '#ef4444' },
    info: { borderLeftColor: '#3b82f6' }
  };

  return (
    <div 
      style={{
        ...styles.container,
        ...styles[toast.type]
      }}
    >
      <div style={{ marginRight: '12px', fontSize: '14px', fontWeight: 500 }}>{toast.message}</div>
      <IconButton
        variant="ghost"
        size="sm"
        label="Close"
        onClick={() => onClose(toast.id)}
        style={{ color: '#9ca3af', fontSize: '18px', lineHeight: 1 }}
      >
        ×
      </IconButton>
    </div>
  );
};

const ConfirmModal = ({ 
  isOpen, 
  options, 
  onConfirm, 
  onCancel 
}: { 
  isOpen: boolean; 
  options: ConfirmOptions; 
  onConfirm: () => void; 
  onCancel: () => void; 
}) => {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 9999,
      backdropFilter: 'blur(2px)'
    }}>
      <div className="panel" style={{ width: '400px', background: '#ffffff', border: '1px solid #e5e7eb', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)', borderRadius: '12px' }}>
        <div className="panel-title" style={{ color: options.isDangerous ? '#ef4444' : '#1f2937', borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
          {options.title || 'Please Confirm'}
        </div>
        <div className="panel-content">
          <p style={{ margin: '0 0 24px 0', color: '#4b5563', fontSize: '14px' }}>{options.message}</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
            <Button variant="secondary" size="sm" onClick={onCancel}>
              {options.cancelLabel || 'Cancel'}
            </Button>
            <Button
              variant={options.isDangerous ? 'danger' : 'primary'}
              size="sm"
              onClick={onConfirm}
            >
              {options.confirmLabel || 'Confirm'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const UIProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('solo_sidebar_collapsed') === 'true';
  });
  // Per-scope view modes: { '<serviceId>_<entity>': 'table' | 'card' | 'gallery' }.
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>(() => {
    try { return JSON.parse(localStorage.getItem(VIEW_MODES_KEY) || '{}') || {}; }
    catch { return {}; }
  });
  // The old single-key global preference seeds the fallback so existing users keep their
  // habit on entities they haven't individually customized. Read once; never written here.
  const [defaultViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem(LEGACY_VIEW_MODE_KEY) as ViewMode) || DEFAULT_VIEW_MODE;
  });

  // Per-scope field config: { '<serviceId>_<entity>': { order, hidden } }.
  const [fieldConfigs, setFieldConfigs] = useState<Record<string, FieldConfig>>(() => {
    try { return JSON.parse(localStorage.getItem(LIST_FIELDS_KEY) || '{}') || {}; }
    catch { return {}; }
  });

  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    options: ConfirmOptions;
    resolve: ((value: boolean) => void) | null;
  }>({
    isOpen: false,
    options: { message: '' },
    resolve: null
  });

  const getViewMode = useCallback((scope?: string): ViewMode => {
    if (scope && viewModes[scope]) return viewModes[scope];
    return defaultViewMode;
  }, [viewModes, defaultViewMode]);

  const setViewMode = useCallback((scope: string, mode: ViewMode) => {
    setViewModes(prev => {
      const next = { ...prev, [scope]: mode };
      try { localStorage.setItem(VIEW_MODES_KEY, JSON.stringify(next)); } catch { /* quota — keep in-memory */ }
      return next;
    });
  }, []);

  const getFieldConfig = useCallback((scope: string): FieldConfig | null => {
    return (scope && fieldConfigs[scope]) || null;
  }, [fieldConfigs]);

  // Passing null (or an empty config) clears the scope back to the default field set.
  const setFieldConfig = useCallback((scope: string, config: FieldConfig | null) => {
    setFieldConfigs(prev => {
      const next = { ...prev };
      if (fieldConfigEmpty(config)) delete next[scope];
      else next[scope] = config as FieldConfig;
      try { localStorage.setItem(LIST_FIELDS_KEY, JSON.stringify(next)); } catch { /* quota — keep in-memory */ }
      return next;
    });
  }, []);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Date.now().toString() + Math.random();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Memoized so the context value below stays stable — otherwise every toast (a frequent
  // 5s add+remove) would rebuild `toast`, churn the context value, and re-render all useUI()
  // consumers even though none of them read the `toasts` array.
  const toast = useMemo(() => ({
    success: (msg: string) => addToast('success', msg),
    error: (msg: string) => addToast('error', msg),
    info: (msg: string) => addToast('info', msg)
  }), [addToast]);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState(prev => {
        // If a confirm was already pending (a second confirm opened before the first
        // resolved), settle the stale one as cancelled so its awaiter doesn't hang forever.
        if (prev.resolve) prev.resolve(false);
        return { isOpen: true, options, resolve };
      });
    });
  }, []);

  // Read `resolve` from the functional updater so these callbacks have stable [] identity
  // (depending on confirmState would churn them on every open/close).
  const handleConfirm = useCallback(() => {
    setConfirmState(prev => { prev.resolve?.(true); return { ...prev, isOpen: false }; });
  }, []);

  const handleCancel = useCallback(() => {
    setConfirmState(prev => { prev.resolve?.(false); return { ...prev, isOpen: false }; });
  }, []);

  const value = useMemo(
    () => ({ toast, confirm, isCollapsed, setIsCollapsed, getViewMode, setViewMode, getFieldConfig, setFieldConfig }),
    [toast, confirm, isCollapsed, setIsCollapsed, getViewMode, setViewMode, getFieldConfig, setFieldConfig],
  );

  return (
    <UIContext.Provider value={value}>
      {children}
      
      <div style={{
        position: 'fixed',
        top: '24px',
        right: '24px',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '12px'
      }}>
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onClose={removeToast} />
        ))}
      </div>

      <ConfirmModal 
        isOpen={confirmState.isOpen}
        options={confirmState.options}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </UIContext.Provider>
  );
};
