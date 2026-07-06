import { useState, useEffect } from 'react';
import { Button } from '../../components/ui';
import { useLang } from '../../providers/LanguageProvider';

interface EntityPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  dataLoading: boolean;
  onPageChange: (page: number) => void;
  description?: string;
}

export function EntityPagination({
  page,
  pageSize,
  total,
  dataLoading,
  onPageChange,
  description
}: EntityPaginationProps) {
  const { t } = useLang();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [inputVal, setInputVal] = useState(String(page));

  useEffect(() => { setInputVal(String(page)); }, [page]);

  const commitPage = (val: string) => {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n >= 1 && n <= totalPages && n !== page) {
      onPageChange(n);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setInputVal(String(page));
    }
  };

  return (
    <div style={{ 
      padding: '16px 24px', 
      borderTop: '1px solid var(--border-color)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      background: '#f8fafc',
      flexShrink: 0,
      gap: '20px'
    }}>
      {/* Left spacer — keeps the 3-column space-between balance. The former Export button +
          "export all pages" checkbox were removed: both were no-op controls (no handler, no
          backing export endpoint) that looked functional. Re-add when export actually ships. */}
      <div style={{ flex: 1 }} />

      {description && (
        <div style={{ 
          fontSize: '11px', 
          color: '#94a3b8', 
          fontWeight: 400, 
          textAlign: 'center', 
          flex: 1.5,
          opacity: 0.8
        }}>
          {description}
        </div>
      )}

      <div style={{ display: 'flex', gap: '16px', flex: 1.5, justifyContent: 'flex-end', alignItems: 'center' }}>
        <div style={{ fontSize: '11px', color: '#94a3b8', marginRight: '8px' }}>
          {total > 0 ? (
            <>{(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} / {total}</>
          ) : (
            <>{t('default.no_data_found')}</>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Button 
            variant="secondary"
            size="sm"
            disabled={page === 1 || dataLoading}
            onClick={() => {
              onPageChange(page - 1);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            {t('common.prev')}
          </Button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 4px' }}>
            <input
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && commitPage(inputVal)}
              onBlur={() => commitPage(inputVal)}
              disabled={dataLoading}
              style={{
                width: '40px', textAlign: 'center', fontSize: '12px', fontWeight: 600,
                color: '#475569', border: '1px solid #e2e8f0', borderRadius: '6px',
                padding: '4px 6px', outline: 'none', background: '#fff',
              }}
            />
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>/ {totalPages}</span>
          </div>
          <Button 
            variant="secondary"
            size="sm"
            disabled={page >= totalPages || dataLoading || total === 0}
            onClick={() => {
              onPageChange(page + 1);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            {t('common.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}
