import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useLang } from '../providers/LanguageProvider';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

function ErrorFallback({ error }: { error: Error }) {
  const { t } = useLang();
  return (
    <div style={{ 
      padding: '8px', 
      fontSize: '11px', 
      color: '#ef4444', 
      background: '#fef2f2', 
      border: '1px solid #fee2e2',
      borderRadius: '4px'
    }}>
      <span title={error.message}>{t('error.rendering_error')}</span>
    </div>
  );
}

export function CommonErrorBoundary({ children, fallback }: Props) {
  return (
    <ErrorBoundary FallbackComponent={({ error }) => (fallback as any) || <ErrorFallback error={error as Error} />}>
      {children}
    </ErrorBoundary>
  );
}
