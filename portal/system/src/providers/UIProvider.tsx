import React, { createContext, useContext, useState, useCallback } from 'react';

// --- Types ---
type ToastType = 'success' | 'error' | 'info';

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
}

const UIContext = createContext<UIContextType | null>(null);

export const useUI = () => {
  const context = useContext(UIContext);
  if (!context) throw new Error('useUI must be used within UIProvider');
  return context;
};

// --- Components ---

const ToastItem = ({ toast, onClose }: { toast: Toast; onClose: (id: string) => void }) => {
  const borderColors = {
    success: 'border-[#1a7f37]',
    error: 'border-[#cf222e]',
    info: 'border-[#0969da]'
  };

  return (
    <div
      className={`bg-bg-secondary border ${borderColors[toast.type]} border-l-4 rounded-md px-4 py-3 mb-3 text-white shadow-[0_4px_12px_rgba(0,0,0,0.5)] flex items-center justify-between min-w-[300px] max-w-[400px] animate-[slideDown_0.3s_ease-out]`}
    >
      <div className="mr-3 text-sm">{toast.message}</div>
      <button
        onClick={() => onClose(toast.id)}
        className="bg-transparent border-none text-white/50 cursor-pointer p-0 text-base hover:text-white/80 transition-colors"
      >
        ×
      </button>
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
    <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999]">
      <div className="w-[400px] bg-bg-primary border border-border shadow-[0_8px_24px_rgba(0,0,0,0.5)] rounded-lg">
        <div className={`px-4 py-3 border-b border-border font-bold ${options.isDangerous ? 'text-error' : 'text-accent'}`}>
          {options.title || 'CONFIRM ACTION'}
        </div>
        <div className="p-4">
          <p className="mb-6 text-text-primary">{options.message}</p>
          <div className="flex justify-end gap-3">
            <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all" onClick={onCancel}>
              {options.cancelLabel || 'CANCEL'}
            </button>
            <button
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${options.isDangerous ? 'bg-error/10 border border-error/40 text-error hover:bg-error hover:text-white' : 'bg-success/10 border border-success/40 text-success hover:bg-success hover:text-white'}`}
              onClick={onConfirm}
            >
              {options.confirmLabel || 'CONFIRM'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const UIProvider = ({ children }: { children: React.ReactNode }) => {
  // Toast State
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Confirm State
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    options: ConfirmOptions;
    resolve: ((value: boolean) => void) | null;
  }>({
    isOpen: false,
    options: { message: '' },
    resolve: null
  });

  // --- Toast Logic ---
  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Date.now().toString() + Math.random();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000); // Auto remove after 5s
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = {
    success: (msg: string) => addToast('success', msg),
    error: (msg: string) => addToast('error', msg),
    info: (msg: string) => addToast('info', msg)
  };

  // --- Confirm Logic ---
  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({
        isOpen: true,
        options,
        resolve
      });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (confirmState.resolve) confirmState.resolve(true);
    setConfirmState(prev => ({ ...prev, isOpen: false }));
  }, [confirmState]);

  const handleCancel = useCallback(() => {
    if (confirmState.resolve) confirmState.resolve(false);
    setConfirmState(prev => ({ ...prev, isOpen: false }));
  }, [confirmState]);

  return (
    <UIContext.Provider value={{ toast, confirm }}>
      {children}

      {/* Toast Container */}
      <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[10000] flex flex-col items-center pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onClose={removeToast} />
          </div>
        ))}
      </div>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmState.isOpen}
        options={confirmState.options}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </UIContext.Provider>
  );
};
