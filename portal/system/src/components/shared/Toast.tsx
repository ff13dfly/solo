import { createPortal } from 'react-dom';

interface ToastItem {
  id: number;
  type: 'success' | 'error';
  text: string;
}

interface ToastContainerProps {
  toasts: ToastItem[];
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts }) => {
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="fixed top-4 right-4 flex flex-col gap-2 z-50 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-2.5 border font-mono text-xs ${
            t.type === 'success'
              ? 'text-success border-success/40 bg-bg-primary'
              : 'text-error border-error/40 bg-bg-primary'
          }`}
          style={{ animation: 'slideDown 0.2s ease' }}
        >
          {t.text}
        </div>
      ))}
    </div>,
    document.body
  );
};
