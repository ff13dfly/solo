import React, { useEffect } from 'react';
import { useError } from '../context/ErrorContext';
import { ErrorSeverity } from '../lib/errors';
import './GlobalErrorToast.css';

export const GlobalErrorToast: React.FC = () => {
  const { activeError, clearError } = useError();

  // Auto-dismiss for non-fatal errors
  useEffect(() => {
    if (activeError && activeError.severity !== ErrorSeverity.FATAL) {
      const timer = setTimeout(() => {
        clearError();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [activeError, clearError]);

  if (!activeError) return null;

  const getSeverityClass = (severity: ErrorSeverity) => {
    switch (severity) {
      case ErrorSeverity.ERROR: return 'error';
      case ErrorSeverity.WARNING: return 'warning';
      case ErrorSeverity.FATAL: return 'fatal';
      case ErrorSeverity.INFO: return 'info';
      default: return 'error';
    }
  };

  return (
    <div className={`global-error-toast ${getSeverityClass(activeError.severity)}`}>
      <div className="toast-content">
        <span className="toast-icon">
          {activeError.severity === ErrorSeverity.FATAL ? '⛔' : '⚠️'}
        </span>
        <div className="toast-message">
          <div className="message-title">{activeError.message}</div>
          {(activeError.originalError as any) && (
            <div className="message-detail">
              {String(activeError.originalError)}
            </div>
          )}
        </div>
        <button className="toast-close" onClick={clearError}>×</button>
      </div>
    </div>
  );
};
