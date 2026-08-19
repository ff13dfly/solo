import { useLang } from '../../providers/LanguageProvider';
import { RpcError } from '../../utils/rpc';

/**
 * The "this failed" state for data views — the counterpart to an empty state.
 *
 * @why A list page that only reads `data` from react-query renders its empty state
 *      when the query FAILS, because a failed query leaves `data` undefined and the
 *      code goes on to test `items.length === 0`. A new account (empty permit) then
 *      sees "No profiles yet — click + New to create one" over a table it simply
 *      isn't allowed to read: the emptiness is a lie, the suggested action fails too,
 *      and it sends whoever is debugging at the write path instead of at permissions
 *      (docs/feedback/done/operator-onboarding-three-silent-traps.md §二).
 *      Forbidden gets its own wording — "you can't see this" is a different fact from
 *      "this is broken", and only one of them is worth a retry.
 *
 * Icons are inline SVG (lucide shapes) to match the rest of this portal, which has no
 * icon dependency.
 */
export function LoadError({ error, compact = false }: { error: unknown; compact?: boolean }) {
    const { t } = useLang();
    const forbidden = error instanceof RpcError && error.code === -32005;
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const size = compact ? 18 : 28;

    return (
        <div
            role="alert"
            style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                padding: compact ? '20px 0' : '40px 0', textAlign: 'center',
                color: forbidden ? 'var(--text-secondary)' : '#ef4444',
            }}
        >
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
                {forbidden ? (
                    <>
                        <rect x="3" y="11" width="18" height="11" rx="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </>
                ) : (
                    <>
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <path d="M12 9v4M12 17h.01" />
                    </>
                )}
            </svg>
            <span style={{ fontSize: 13 }}>
                {forbidden ? t('common.load_forbidden') : t('common.load_failed')}
            </span>
            {!forbidden && detail && (
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 420, wordBreak: 'break-word' }}>
                    {detail}
                </span>
            )}
        </div>
    );
}

export default LoadError;
