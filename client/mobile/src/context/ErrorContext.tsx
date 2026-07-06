import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { AppError, normalizeError } from '../lib/errors';

interface ErrorContextType {
  activeError: AppError | null;
  showError: (error: unknown) => void;
  clearError: () => void;
}

const ErrorContext = createContext<ErrorContextType | undefined>(undefined);

export const ErrorProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [activeError, setActiveError] = useState<AppError | null>(null);

  const showError = useCallback((error: unknown) => {
    const normalized = normalizeError(error);
    console.error('[Global Error]:', normalized);
    setActiveError(normalized);
  }, []);

  const clearError = useCallback(() => {
    setActiveError(null);
  }, []);

  return (
    <ErrorContext.Provider value={{ activeError, showError, clearError }}>
      {children}
    </ErrorContext.Provider>
  );
};

export function useError() {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error('useError must be used within an ErrorProvider');
  }
  return context;
}
