import { useState, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useLang } from '../../providers/LanguageProvider';
import { callRpc } from '../../utils/rpc';
import type { WalDailyStats } from './types';
import { EmptyState } from './Common';
import { Button } from '../../components/ui';

interface WalHourly { ts: number; create: number; update: number; destroy: number; total: number; }

interface Props {
    walDaily: WalDailyStats[];
    loading: boolean;
}

export default function WalStatsPanel({ walDaily, loading }: Props) {
    const { t } = useLang();
    const [walHourly, setWalHourly] = useState<WalHourly[]>([]);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [hourlyLoading, setHourlyLoading] = useState(false);

    const COLORS = { create: '#10b981', update: '#3b82f6', destroy: '#ef4444' };

    const dailyOption = useMemo(() => {
        const createLabel  = t('dashboard.wal_create');
        const updateLabel  = t('dashboard.wal_update');
        const destroyLabel = t('dashboard.wal_destroy');
        return {
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                backgroundColor: '#1e293b',
                borderColor: '#334155',
                textStyle: { color: '#e2e8f0', fontSize: 12 },
            },
            legend: {
                data: [createLabel, updateLabel, destroyLabel],
                right: 0, top: 0,
                textStyle: { color: '#6b7280', fontSize: 11 },
                itemHeight: 8,
            },
            grid: { left: 36, right: 16, top: 32, bottom: 24 },
            xAxis: {
                type: 'category',
                data: walDaily.map(d => d.date.slice(5)),
                axisLine: { lineStyle: { color: '#e5e7eb' } },
                axisTick: { show: false },
                axisLabel: { color: '#9ca3af', fontSize: 10, interval: 4 },
                triggerEvent: true,
            },
            yAxis: {
                type: 'value', minInterval: 1,
                axisLabel: { color: '#9ca3af', fontSize: 10 },
                splitLine: { lineStyle: { color: '#f3f4f6' } },
                axisLine: { show: false }, axisTick: { show: false },
            },
            series: [
                { name: createLabel,  type: 'bar', stack: 'wal', data: walDaily.map(d => d.create),  barMaxWidth: 20, itemStyle: { color: COLORS.create } },
                { name: updateLabel,  type: 'bar', stack: 'wal', data: walDaily.map(d => d.update),  barMaxWidth: 20, itemStyle: { color: COLORS.update } },
                { name: destroyLabel, type: 'bar', stack: 'wal', data: walDaily.map(d => d.destroy), barMaxWidth: 20, itemStyle: { color: COLORS.destroy, borderRadius: [4, 4, 0, 0] } },
            ],
        };
    }, [walDaily, t]);

    const hourlyOption = useMemo(() => {
        const createLabel  = t('dashboard.wal_create');
        const updateLabel  = t('dashboard.wal_update');
        const destroyLabel = t('dashboard.wal_destroy');
        return {
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                backgroundColor: '#1e293b',
                borderColor: '#334155',
                textStyle: { color: '#e2e8f0', fontSize: 12 },
            },
            legend: {
                data: [createLabel, updateLabel, destroyLabel],
                right: 0, top: 0,
                textStyle: { color: '#6b7280', fontSize: 11 },
                itemHeight: 8,
            },
            grid: { left: 36, right: 16, top: 32, bottom: 24 },
            xAxis: {
                type: 'category',
                data: walHourly.map(h => new Date(h.ts).getUTCHours() + ':00'),
                axisLine: { lineStyle: { color: '#e5e7eb' } },
                axisTick: { show: false },
                axisLabel: { color: '#9ca3af', fontSize: 10, interval: 3 },
            },
            yAxis: {
                type: 'value', minInterval: 1,
                axisLabel: { color: '#9ca3af', fontSize: 10 },
                splitLine: { lineStyle: { color: '#f3f4f6' } },
                axisLine: { show: false }, axisTick: { show: false },
            },
            series: [
                { name: createLabel,  type: 'bar', stack: 'wal_h', data: walHourly.map(h => h.create),  barMaxWidth: 12, itemStyle: { color: COLORS.create } },
                { name: updateLabel,  type: 'bar', stack: 'wal_h', data: walHourly.map(h => h.update),  barMaxWidth: 12, itemStyle: { color: COLORS.update } },
                { name: destroyLabel, type: 'bar', stack: 'wal_h', data: walHourly.map(h => h.destroy), barMaxWidth: 12, itemStyle: { color: COLORS.destroy, borderRadius: [4, 4, 0, 0] } },
            ],
        };
    }, [walHourly, t]);

    const onBarClick = (params: any) => {
        const index = params.componentType === 'xAxis'
            ? walDaily.findIndex(d => d.date.slice(5) === params.value)
            : params.dataIndex;
        if (index === undefined || index < 0) return;
        const entry = walDaily[index];
        if (!entry) return;

        setSelectedDate(entry.date);
        setHourlyLoading(true);

        callRpc<WalHourly[]>('system.wal.stats.range', {
            start: entry.ts,
            end: entry.ts + 86400000,
            step: 3600000,
        })
            .then(d => setWalHourly(d || []))
            .catch(() => {})
            .finally(() => setHourlyLoading(false));
    };

    const totalCreate  = selectedDate ? walHourly.reduce((s, h) => s + h.create,  0) : walDaily.reduce((s, d) => s + d.create,  0);
    const totalUpdate  = selectedDate ? walHourly.reduce((s, h) => s + h.update,  0) : walDaily.reduce((s, d) => s + d.update,  0);
    const totalDestroy = selectedDate ? walHourly.reduce((s, h) => s + h.destroy, 0) : walDaily.reduce((s, d) => s + d.destroy, 0);

    return (
        <div className="panel">
            <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{selectedDate ? t('dashboard.wal_hourly_title', { date: selectedDate }) : t('dashboard.wal_title')}</span>
                {selectedDate ? (
                    <Button variant="secondary" size="sm" onClick={() => setSelectedDate(null)}>
                        {t('dashboard.qr_hourly_back')}
                    </Button>
                ) : (
                    !loading && (
                        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-secondary)' }}>
                            {t('dashboard.wal_summary', { total: walDaily.reduce((s, d) => s + d.total, 0).toLocaleString() })}
                        </span>
                    )
                )}
            </div>
            <div className="panel-content" style={{ padding: '20px 24px' }}>
                {loading || (selectedDate && hourlyLoading) ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '24px 0' }}>{t('common.loading')}</div>
                ) : !selectedDate && walDaily.every(d => d.total === 0) ? (
                    <EmptyState label={t('dashboard.no_wal_data')} />
                ) : (
                    <>
                        {!selectedDate && (
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                                {t('dashboard.last_30_days')}
                            </div>
                        )}
                        <ReactECharts
                            option={selectedDate ? hourlyOption : dailyOption}
                            style={{ height: 160 }}
                            notMerge={true}
                            onEvents={selectedDate ? {} : { 'click': onBarClick }}
                        />
                        <div style={{ marginTop: 16, display: 'flex', gap: 32, fontSize: 12, color: 'var(--text-secondary)' }}>
                            {([
                                { label: t('dashboard.wal_create'),  val: totalCreate,  color: COLORS.create },
                                { label: t('dashboard.wal_update'),  val: totalUpdate,  color: COLORS.update },
                                { label: t('dashboard.wal_destroy'), val: totalDestroy, color: COLORS.destroy },
                            ] as const).map(({ label, val, color }) => (
                                <div key={label}>
                                    <span style={{ fontWeight: 700, color, fontSize: 20, fontFamily: 'var(--font-mono)' }}>{val.toLocaleString()}</span>
                                    <span style={{ marginLeft: 6 }}>{label}</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
