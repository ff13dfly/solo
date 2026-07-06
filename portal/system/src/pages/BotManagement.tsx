import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { PERMIT_CONFIG } from '../config/permit';
import PermitEditorModal from '../components/permit/PermitEditorModal';
import IssueTokenModal from '../components/bot-management/IssueTokenModal';
import { useBots } from '../hooks/useBots';
import { formatDate } from '../utils/format';
import type { Bot, Permit, ServiceInfo } from '../types';

const BOT_UID_PREFIX = 'system.';

// Services with a relay token slot ({svc}.token.set / .status). Keep in sync with
// deploy/seed-bots.js BOTS — only these uids can be INJECTed into a service slot;
// other system.* uids are sentinel identities (injected via nexus.sentinel.token.set).
const RELAY_SERVICES = ['orchestrator', 'nexus', 'ingress', 'fulfillment', 'notification', 'approval'];

interface RelayStatus {
    hasToken: boolean;
    sub?: string;
    expiresAt?: number;
    ttlMs?: number;
    needsRotation?: boolean;
    expired?: boolean;
}

interface SentinelLite {
    id: string;
    name: string;
    authorityRole: string;
    identity?: { mode: 'bot' | 'shared'; uid?: string; hasToken?: boolean | null; expired?: boolean; expiresAt?: number | null };
}

function fmtTtl(ms?: number): string {
    if (!ms || ms <= 0) return '—';
    const m = ms / 60_000;
    if (m < 60) return `${Math.round(m)}m`;
    const h = m / 60;
    if (h < 48) return `${Math.round(h)}h`;
    return `${Math.round(h / 24)}d`;
}

export default function BotManagement() {
    const { toast, confirm } = useUI();
    const { t } = useLang();
    const { bots, loading, error, refresh, updateBotInfo } = useBots();
    const [availableServices, setAvailableServices] = useState<ServiceInfo[]>([]);

    // Create bot
    const [showCreate, setShowCreate] = useState(false);
    const [newUid, setNewUid] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [creating, setCreating] = useState(false);

    // Permit edit
    const [permitTarget, setPermitTarget] = useState<Bot | null>(null);

    // Issue token result
    const [tokenResult, setTokenResult] = useState<{ uid: string; token: string; expiresAt: number } | null>(null);
    const [issuing, setIssuing] = useState<string | null>(null);
    const [injecting, setInjecting] = useState<string | null>(null);

    // RAW view
    const [rawBot, setRawBot] = useState<Bot | null>(null);

    useEffect(() => {
        callRpc<ServiceInfo[]>('system.service.list', {})
            .then(result => {
                const filtered = result.filter(s => !PERMIT_CONFIG.restrictedServices.includes(s.id));
                setAvailableServices(filtered);
            })
            .catch(e => console.warn('Failed to load services', e));
    }, []);

    // Provisioning visibility: relay slot state per service + sentinel identity state.
    // Without this, INJECT had no visible effect and "sentinel declared an identity
    // but nobody provisioned it" was only discoverable via redis-cli.
    const [relayStatus, setRelayStatus] = useState<Record<string, RelayStatus | null>>({});
    const [sentinels, setSentinels] = useState<SentinelLite[] | null>(null);

    const refreshTokenState = useCallback(() => {
        RELAY_SERVICES.forEach(svc => {
            callRpc<RelayStatus>(`${svc}.token.status`, {})
                .then(r => setRelayStatus(prev => ({ ...prev, [svc]: r })))
                .catch(() => setRelayStatus(prev => ({ ...prev, [svc]: null })));
        });
        callRpc<{ items: SentinelLite[] }>('nexus.sentinel.list', { page: 1, pageSize: 100 })
            .then(r => setSentinels(r?.items ?? []))
            .catch(() => setSentinels(null));
    }, []);
    useEffect(() => { refreshTokenState(); }, [refreshTokenState]);

    const existingBotIds = new Set(bots.map(b => b.id));

    // Sentinels that declared their own system.* identity but are missing the bot
    // account or its injected token — the "needs provisioning" worklist.
    const sentinelIssues = (sentinels ?? [])
        .filter(s => s.identity?.mode === 'bot' || String(s.authorityRole || '').startsWith(BOT_UID_PREFIX))
        .map(s => ({
            sentinel: s,
            uid: s.authorityRole,
            missingAccount: !existingBotIds.has(s.authorityRole),
            missingToken: s.identity?.hasToken === false,
            expiredToken: s.identity?.expired === true,
        }))
        .filter(x => x.missingAccount || x.missingToken || x.expiredToken);

    const servicesAvailableForCreate = availableServices.filter(
        s => !existingBotIds.has(BOT_UID_PREFIX + s.id)
    );

    const handleCreate = async () => {
        const uid = newUid.trim();
        if (!uid) return toast.error(t('bot_mgmt.selectAService'));
        const fullUid = BOT_UID_PREFIX + uid;
        setCreating(true);
        try {
            await callRpc('user.bot.create', {
                uid: fullUid,
                desc: newDesc.trim(),
                permit: { allow_all: false, services: {} },
            });
            toast.success(t('bot_mgmt.botCreated', { uid: fullUid }));
            setShowCreate(false);
            setNewUid('');
            setNewDesc('');
            refresh();
        } catch (err: any) {
            toast.error(err.message || t('bot_mgmt.createFailed'));
        } finally {
            setCreating(false);
        }
    };

    // Derives the relay service name from a system.* UID, null otherwise.
    const serviceNameFromUid = (uid: string) =>
        uid.startsWith(BOT_UID_PREFIX) ? uid.slice(BOT_UID_PREFIX.length) || null : null;

    // A system.* uid is injectable when it has a real target: a service relay slot,
    // or a sentinel that declared it as authorityRole. (Previously ANY system.* uid
    // got an INJECT button that fired a nonexistent {name}.token.set.)
    const isRelayService = (uid: string) => {
        const svc = serviceNameFromUid(uid);
        return !!svc && RELAY_SERVICES.includes(svc);
    };
    const sentinelFor = (uid: string) => (sentinels ?? []).find(s => s.authorityRole === uid) || null;

    const handleInject = async (bot: Bot) => {
        const relay = isRelayService(bot.id);
        const sentinel = sentinelFor(bot.id);
        if (!relay && !sentinel) return;
        setInjecting(bot.id);
        try {
            const result = await callRpc<{ token: string; expiresAt: number }>('user.bot.issue.token', { uid: bot.id });
            try {
                if (relay) {
                    const serviceName = serviceNameFromUid(bot.id)!;
                    await callRpc(`${serviceName}.token.set`, { token: result.token, expiresAt: result.expiresAt, sub: bot.id });
                    toast.success(t('bot_mgmt.tokenIssuedAndInjected', { service: serviceName }));
                } else {
                    // Sentinel identity (§1.2): inject into NEXUS:SENTINEL:TOKEN:{uid} so the
                    // sentinel's fetchers/autorun run under THIS bot's permit.
                    await callRpc('nexus.sentinel.token.set', { authorityRole: bot.id, token: result.token, expiresAt: result.expiresAt });
                    toast.success(t('bot_mgmt.tokenInjectedAsSentinel', { name: sentinel!.name }));
                }
                refreshTokenState();
            } catch (deployErr: any) {
                // Target unreachable — fall back to manual modal so admin can copy and deploy later
                toast.error(t('bot_mgmt.issuedButDeployFailed', { error: deployErr.message || t('bot_mgmt.serviceUnreachable') }));
                setTokenResult({ uid: bot.id, token: result.token, expiresAt: result.expiresAt });
            }
        } catch (err: any) {
            toast.error(err.message || t('bot_mgmt.injectFailed'));
        } finally {
            setInjecting(null);
        }
    };

    // Banner quick-fix: create the bot account a sentinel's authorityRole points at.
    const handleCreateForSentinel = async (uid: string, sentinelName: string) => {
        try {
            await callRpc('user.bot.create', {
                uid,
                desc: t('bot_mgmt.sentinelIdentityDesc', { name: sentinelName }),
                permit: { allow_all: false, services: {} },
            });
            toast.success(t('bot_mgmt.botCreatedSetPermit', { uid }));
            refresh();
            refreshTokenState();
        } catch (err: any) {
            toast.error(err.message || t('bot_mgmt.createFailed'));
        }
    };

    const handleIssueToken = async (bot: Bot) => {
        const ok = await confirm({
            message: t('bot_mgmt.issueTokenConfirm', { id: bot.id }),
        });
        if (!ok) return;
        setIssuing(bot.id);
        try {
            const result = await callRpc<{ token: string; expiresAt: number }>('user.bot.issue.token', { uid: bot.id });
            setTokenResult({ uid: bot.id, token: result.token, expiresAt: result.expiresAt });
        } catch (err: any) {
            toast.error(err.message || t('bot_mgmt.issueTokenFailed'));
        } finally {
            setIssuing(null);
        }
    };

    const handleDelete = async (bot: Bot) => {
        const ok = await confirm({
            message: t('bot_mgmt.deleteConfirm', { id: bot.id }),
            isDangerous: true,
        });
        if (!ok) return;
        try {
            await callRpc('user.bot.delete', { uid: bot.id });
            toast.success(t('bot_mgmt.botDeleted', { id: bot.id }));
            refresh();
        } catch (err: any) {
            toast.error(err.message || t('bot_mgmt.deleteFailed'));
        }
    };

    // 主动吊销:删掉该 bot 的全部 live session token(泄露应急 / 停用),bot 账号仍在,
    // 可重新 issue token。区别于 DELETE(硬删账号)。
    const handleRevoke = async (bot: Bot) => {
        const ok = await confirm({
            message: t('bot_mgmt.revokeConfirm', { id: bot.id }),
            isDangerous: true,
        });
        if (!ok) return;
        try {
            const res = await callRpc<{ uid: string; revoked: number }>('user.token.revoke', { uid: bot.id });
            toast.success(t('bot_mgmt.revokedCount', { n: res?.revoked ?? 0 }));
        } catch (err: any) {
            toast.error(err.message || t('bot_mgmt.revokeFailed'));
        }
    };

    // TOKEN cell: where does this bot's credential live, and is it actually there?
    const tokenCell = (bot: Bot) => {
        const svc = serviceNameFromUid(bot.id);
        if (svc && RELAY_SERVICES.includes(svc)) {
            const st = relayStatus[svc];
            if (st === undefined) return <span className="text-[10px] text-text-secondary opacity-50">…</span>;
            if (st === null) return <span className="text-[10px] text-text-secondary opacity-50" title={t('bot_mgmt.tokenStatusUnreachable', { service: svc })}>n/a</span>;
            if (!st.hasToken) return <span className="text-[10px] px-1.5 py-0.5 border rounded border-warning/40 text-warning bg-warning/10" title={t('bot_mgmt.relaySlotEmpty')}>○ EMPTY</span>;
            if (st.sub && st.sub !== bot.id) return <span className="text-[10px] px-1.5 py-0.5 border rounded border-warning/40 text-warning bg-warning/10 truncate" title={t('bot_mgmt.relaySlotForeign', { sub: st.sub })}>⚠ {st.sub}</span>;
            if (st.expired) return <span className="text-[10px] px-1.5 py-0.5 border rounded border-error/40 text-error bg-error/10" title={t('bot_mgmt.tokenExpiredRelay')}>EXPIRED</span>;
            return (
                <span
                    className={`text-[10px] px-1.5 py-0.5 border rounded ${st.needsRotation ? 'border-warning/40 text-warning bg-warning/10' : 'border-success/40 text-success bg-success/10'}`}
                    title={t('bot_mgmt.injectedIntoRelay', { service: svc }) + (st.needsRotation ? t('bot_mgmt.nearingExpirySuffix') : '')}
                >
                    ● {fmtTtl(st.ttlMs)}
                </span>
            );
        }
        const snt = sentinelFor(bot.id);
        if (snt) {
            const has = snt.identity?.hasToken;
            if (snt.identity?.expired) return <span className="text-[10px] px-1.5 py-0.5 border rounded border-error/40 text-error bg-error/10" title={t('bot_mgmt.sentinelExpiredTitle', { name: snt.name })}>EXPIRED SENTINEL</span>;
            if (has === true) return <span className="text-[10px] px-1.5 py-0.5 border rounded border-success/40 text-success bg-success/10" title={t('bot_mgmt.sentinelProvisionedTitle', { name: snt.name }) + (snt.identity?.expiresAt ? t('bot_mgmt.sentinelExpiresSuffix', { date: new Date(snt.identity.expiresAt).toLocaleString() }) : '')}>● SENTINEL</span>;
            if (has === false) return <span className="text-[10px] px-1.5 py-0.5 border rounded border-error/40 text-error bg-error/10" title={t('bot_mgmt.sentinelNoTokenTitle', { name: snt.name })}>○ SENTINEL</span>;
            return <span className="text-[10px] px-1.5 py-0.5 border rounded border-border text-text-secondary" title={t('bot_mgmt.sentinelUnknownTitle', { name: snt.name })}>SENTINEL</span>;
        }
        return <span className="opacity-40 text-[10px]" title={t('bot_mgmt.noRelayBinding')}>—</span>;
    };

    return (
        <div className="border border-border bg-bg-primary flex flex-col h-full">
            {/* Header */}
            <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <span>{t('bot_mgmt.botAccounts')}</span>
                </div>
                <div className="flex gap-3 items-center bg-white/[0.03] px-3 py-1 rounded-md border border-white/5">
                    <button
                        onClick={() => setShowCreate(true)}
                        className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all whitespace-nowrap"
                    >
                        {t('bot_mgmt.newBot')}
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden flex flex-col">
                {error && (
                    <div className="p-4 text-error">{t('bot_mgmt.errorPrefix')}{error}</div>
                )}

                {/* Sentinel provisioning worklist — sentinels that declared a system.*
                    identity but lack the bot account or its injected token. */}
                {sentinelIssues.length > 0 && (
                    <div className="mx-4 mt-3 border border-warning/40 bg-warning/10 rounded-md px-4 py-3" data-test="sentinel-coverage-banner">
                        <div className="text-[12px] font-bold text-warning mb-2">
                            {t('bot_mgmt.sentinelWorklistHeader', { n: sentinelIssues.length })}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            {sentinelIssues.map(issue => (
                                <div key={issue.sentinel.id} data-test="provisioning-row" className="flex items-center gap-2 text-[11px] flex-wrap">
                                    <span className="text-text-primary">{issue.sentinel.name}</span>
                                    <code className="font-mono text-[10px] text-text-secondary">{issue.uid}</code>
                                    {issue.missingAccount ? (
                                        <>
                                            <span className="text-warning">{t('bot_mgmt.missingBotAccount')}</span>
                                            <button
                                                className="bg-accent-dim border border-accent/40 text-accent rounded px-2 py-0.5 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                                                onClick={() => handleCreateForSentinel(issue.uid, issue.sentinel.name)}
                                            >
                                                {t('bot_mgmt.create')}
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <span className="text-warning">{issue.expiredToken ? t('bot_mgmt.tokenExpiredAbort') : t('bot_mgmt.tokenNotInjectedAbort')}</span>
                                            <button
                                                className="bg-accent-dim border border-accent/40 text-accent rounded px-2 py-0.5 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
                                                onClick={() => handleInject({ id: issue.uid } as Bot)}
                                                disabled={injecting === issue.uid}
                                            >
                                                {injecting === issue.uid ? t('bot_mgmt.injecting') : t('bot_mgmt.inject')}
                                            </button>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Header Row */}
                <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-[11px] text-accent uppercase tracking-wider sticky top-0 z-10 grid-cols-[2fr_2.5fr_2.5fr_0.9fr_1.2fr_1.4fr]">
                    <div>{t('bot_mgmt.colUid')}</div>
                    <div>{t('bot_mgmt.colDescription')}</div>
                    <div>{t('bot_mgmt.colActions')}</div>
                    <div>{t('bot_mgmt.colStatus')}</div>
                    <div>{t('bot_mgmt.colToken')}</div>
                    <div>{t('bot_mgmt.colCreated')}</div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {bots.map(bot => (
                        <div key={bot.id} className="grid gap-4 px-5 border-b border-border hover:bg-white/[0.02] items-center text-sm transition-colors grid-cols-[2fr_2.5fr_2.5fr_0.9fr_1.2fr_1.4fr] h-[52px]">
                            <div className="font-mono text-[11px] text-accent truncate" title={bot.id}>
                                {bot.id}
                            </div>

                            <div className="text-[12px] text-text-secondary truncate" title={bot.desc}>
                                {bot.desc || <span className="opacity-40">—</span>}
                            </div>

                            <div className="flex gap-2 items-center">
                                <button
                                    className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                                    onClick={() => setRawBot(bot)}
                                >
                                    {t('bot_mgmt.raw')}
                                </button>
                                <button
                                    className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                                    onClick={() => setPermitTarget(bot)}
                                >
                                    {t('bot_mgmt.permit')}
                                </button>
                                {(isRelayService(bot.id) || sentinelFor(bot.id)) ? (
                                    <button
                                        className="bg-[rgba(56,139,253,0.15)] border border-[rgba(56,139,253,0.4)] text-[#58a6ff] rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
                                        onClick={() => handleInject(bot)}
                                        disabled={injecting === bot.id || issuing === bot.id}
                                        title={isRelayService(bot.id)
                                            ? t('bot_mgmt.injectRelayTitle')
                                            : t('bot_mgmt.injectSentinelTitle', { name: sentinelFor(bot.id)?.name ?? '' })}
                                    >
                                        {injecting === bot.id ? t('bot_mgmt.injecting') : t('bot_mgmt.inject')}
                                    </button>
                                ) : (
                                    <button
                                        className="bg-[rgba(56,139,253,0.15)] border border-[rgba(56,139,253,0.4)] text-[#58a6ff] rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50"
                                        onClick={() => handleIssueToken(bot)}
                                        disabled={issuing === bot.id}
                                    >
                                        {issuing === bot.id ? t('bot_mgmt.issuing') : t('bot_mgmt.issueToken')}
                                    </button>
                                )}
                                <button
                                    className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                                    onClick={() => handleRevoke(bot)}
                                    title={t('bot_mgmt.revokeTitle')}
                                >
                                    {t('bot_mgmt.revoke')}
                                </button>
                                <button
                                    className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-error hover:text-white transition-all"
                                    onClick={() => handleDelete(bot)}
                                >
                                    {t('bot_mgmt.delete')}
                                </button>
                            </div>

                            <div>
                                <span className={`text-[10px] px-2 py-0.5 rounded border ${bot.status === 'ACTIVE'
                                    ? 'text-success border-success/30 bg-success/10'
                                    : 'text-error border-error/30 bg-error/10'
                                    }`}>
                                    {bot.status}
                                </span>
                            </div>

                            <div data-test="bot-token-state">{tokenCell(bot)}</div>

                            <div className="text-[11px] text-text-secondary">{formatDate(bot.createdAt)}</div>
                        </div>
                    ))}

                    {!loading && bots.length === 0 && (
                        <div className="p-6 text-center opacity-50 text-[13px]">
                            {t('bot_mgmt.noBotsBefore')}<strong>{t('bot_mgmt.newBot')}</strong>{t('bot_mgmt.noBotsAfter')}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-2 border-t border-border bg-bg-secondary flex justify-between items-center">
                    <span className="text-xs text-text-secondary">{t('bot_mgmt.total', { n: bots.length })}</span>
                </div>
            </div>

            {/* Create Modal */}
            <Modal
                isOpen={showCreate}
                onClose={() => !creating && setShowCreate(false)}
                title={t('bot_mgmt.createBotAccount')}
                size="md"
                footer={
                    <>
                        <Button onClick={() => setShowCreate(false)} variant="secondary" disabled={creating}>{t('bot_mgmt.cancel')}</Button>
                        <Button onClick={handleCreate} disabled={creating || !newUid || servicesAvailableForCreate.length === 0}>
                            {creating ? t('bot_mgmt.creating') : t('bot_mgmt.create')}
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    {servicesAvailableForCreate.length === 0 ? (
                        <div className="text-[12px] text-text-secondary border border-border rounded-md p-4 bg-white/[0.02] text-center">
                            {t('bot_mgmt.allServicesHaveBot')}
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('bot_mgmt.serviceLabel')}</label>
                                <select
                                    value={newUid}
                                    onChange={(e) => setNewUid(e.target.value)}
                                    className="w-full font-mono bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                                >
                                    <option value="">{t('bot_mgmt.selectServiceOption')}</option>
                                    {servicesAvailableForCreate.map(s => (
                                        <option key={s.id} value={s.id}>
                                            {BOT_UID_PREFIX}{s.id}
                                        </option>
                                    ))}
                                </select>
                                <div className="mt-1 text-[10px] text-text-secondary">
                                    {t('bot_mgmt.onlyServicesWithoutBot')}
                                </div>
                            </div>

                            <div>
                                <label className="block text-[11px] uppercase tracking-wider text-text-secondary mb-2">{t('bot_mgmt.descriptionLabel')}</label>
                                <input
                                    value={newDesc}
                                    onChange={(e) => setNewDesc(e.target.value)}
                                    placeholder={t('bot_mgmt.descriptionPlaceholder')}
                                    className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                                />
                            </div>

                            <div className="text-[11px] text-text-secondary border border-border rounded-md p-3 bg-white/[0.02] leading-relaxed">
                                {t('bot_mgmt.emptyPermitBeforeStrong')}<strong>{t('bot_mgmt.permit')}</strong>{t('bot_mgmt.emptyPermitAfterStrong')}
                            </div>
                        </>
                    )}
                </div>
            </Modal>

            {/* Permit Modal */}
            {permitTarget && (
                <PermitEditorModal
                    userId={permitTarget.id}
                    userName={permitTarget.id}
                    title={t('bot_mgmt.editBotPermit')}
                    initialPermit={JSON.parse(JSON.stringify(permitTarget.permit || { allow_all: false, services: {} }))}
                    availableServices={availableServices}
                    disallowAllowAll={true}
                    onSave={async (permit) => {
                        await callRpc('user.bot.update', { uid: permitTarget.id, permit });
                    }}
                    onClose={() => setPermitTarget(null)}
                    onSaveSuccess={(updatedPermit) => {
                        updateBotInfo(permitTarget.id, { permit: updatedPermit });
                    }}
                />
            )}

            {/* Issue Token Result Modal */}
            {tokenResult && (
                <IssueTokenModal
                    botUid={tokenResult.uid}
                    token={tokenResult.token}
                    expiresAt={tokenResult.expiresAt}
                    onClose={() => setTokenResult(null)}
                />
            )}

            {/* RAW Modal */}
            <Modal
                isOpen={!!rawBot}
                onClose={() => setRawBot(null)}
                title={t('bot_mgmt.rawBotData', { id: rawBot?.id || '' })}
                size="lg"
                footer={<Button onClick={() => setRawBot(null)}>{t('bot_mgmt.close')}</Button>}
            >
                <pre className="bg-bg-primary p-4 rounded-md text-xs font-mono overflow-auto border border-border text-text-secondary h-[60vh]">
                    {rawBot && JSON.stringify(rawBot, null, 2)}
                </pre>
            </Modal>
        </div>
    );
}
