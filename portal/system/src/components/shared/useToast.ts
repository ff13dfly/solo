import { useState, useCallback, useRef } from 'react';

interface Toast {
  id: number;
  type: 'success' | 'error';
  text: string;
}

export function useToast(duration = 2500) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const show = useCallback((type: Toast['type'], text: string) => {
    const id = ++counter.current;
    setToasts(prev => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  }, [duration]);

  return { toasts, show };
}
