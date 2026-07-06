import { useState, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useLang } from '../../providers/LanguageProvider';
import { callRpc } from '../../utils/rpc';
import type { DailyStats, RecentEntry } from './types';
import { EmptyState } from './Common';
import { Button } from '../../components/ui';

const CNY_RATE = 7.25;
const toCny = (usd: number) => (usd * CNY_RATE).toFixed(4);

interface Props {
    daily: DailyStats[];
    recent: RecentEntry[];
    loading: boolean;
}

export default function AiUsagePanel({ daily, recent, loading }: Props) {
    const { t } = useLang();
    const [recentExpanded, setRecentExpanded] = useState(false);
    const [aiHourly, setAiHourly] = useState<{ hour: string, costUsd: number, models: Record<string, number> }[]>([]);
    const [aiSelectedDate, setAiSelectedDate] = useState<string | null>(null);
    const [aiHourlyLoading, setAiHourlyLoading] = useState(false);

    const week = daily.slice(0, 7);
    const sorted = [...week].reverse();

    const chartOption = useMemo(() => {
        const dates = sorted.map(d => d.date.slice(5));
        const costs = sorted.map(d => +(d.costUsd * CNY_RATE).toFixed(4));
        const calls = sorted.map(d => d.calls);
        const costLabel = t('dashboard.chart_cost');
        const callsLabel = t('dashboard.chart_calls');

        return {
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                backgroundColor: '#1e293b',
                borderColor: '#334155',
                textStyle: { color: '#e2e8f0', fontSize: 12 },
                formatter: (params: any[]) => {
                    return params.map((p: any) =>
                        `${p.marker}${p.seriesName}：${p.seriesName === costLabel ? '¥' + p.value : p.value}`
                    ).join('<br/>');
                }
            },
            legend: {
                data: [costLabel, callsLabel],
                right: 0, top: 0,
                textStyle: { color: '#6b7280', fontSize: 11 },
                itemHeight: 8,
            },
            grid: { left: 40, right: 50, top: 32, bottom: 24 },
            xAxis: {
                type: 'category',
                data: dates,
                axisLine: { lineStyle: { color: '#e5e7eb' } },
                axisTick: { show: false },
                axisLabel: { color: '#9ca3af', fontSize: 11 },
                triggerEvent: true,
            },
            yAxis: [
                {
                    type: 'value',
                    name: '¥',
                    nameTextStyle: { color: '#9ca3af', fontSize: 10 },
                    axisLabel: { color: '#9ca3af', fontSize: 10, formatter: (v: number) => v === 0 ? '0' : `¥${v}` },
                    splitLine: { lineStyle: { color: '#f3f4f6' } },
                    axisLine: { show: false },
                    axisTick: { show: false },
                },
                {
                    type: 'value',
                    axisLabel: { color: '#9ca3af', fontSize: 10 },
                    splitLine: { show: false },
                    axisLine: { show: false },
                    axisTick: { show: false },
                },
            ],
            series: [
                {
                    name: costLabel,
                    type: 'bar',
                    yAxisIndex: 0,
                    data: costs,
                    barMaxWidth: 32,
                    itemStyle: { color: '#f59e0b', borderRadius: [4, 4, 0, 0] },
                    emphasis: { itemStyle: { color: '#d97706' } },
                },
                {
                    name: callsLabel,
                    type: 'line',
                    yAxisIndex: 1,
                    data: calls,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: { color: '#8b5cf6', width: 2 },
                    itemStyle: { color: '#8b5cf6' },
                },
            ],
        };
    }, [sorted, t]);

    const aiHourlyChartOption = useMemo(() => {
        const hours = aiHourly.map(h => h.hour);
        const allModels = Array.from(new Set(aiHourly.flatMap(h => Object.keys(h.models || {}))));
        const series = allModels.map(model => ({
            name: model,
            type: 'bar',
            stack: 'ai_hourly',
            barMaxWidth: 12,
            data: aiHourly.map(h => +( (h.models?.[model] || 0) * CNY_RATE ).toFixed(3))
        }));

        return {
            tooltip: {
                trigger: 'axis',
                backgroundColor: '#1e293b',
                borderColor: '#334155',
                textStyle: { color: '#e2e8f0', fontSize: 11 },
                formatter: (params: any[]) => {
                    let res = `<div style="margin-bottom:4px; font-weight:600">${params[0].name}</div>`;
                    let total = 0;
                    params.forEach(p => {
                        total += p.value;
                        res += `${p.marker}${p.seriesName}: ¥${p.value}<br/>`;
                    });
                    if (params.length > 1) res += `<div style="margin-top:4px; border-top:1px solid #475569; padding-top:4px">Total: ¥${total.toFixed(4)}</div>`;
                    return res;
                }
            },
            legend: {
                show: allModels.length > 0,
                top: 0, right: 0,
                textStyle: { fontSize: 10, color: '#9ca3af' },
                itemWidth: 8, itemHeight: 8
            },
            grid: { left: 40, right: 16, top: 32, bottom: 24 },
            xAxis: {
                type: 'category',
                data: hours,
                axisLine: { lineStyle: { color: '#e5e7eb' } },
                axisTick: { show: false },
                axisLabel: { color: '#9ca3af', fontSize: 10, interval: 3 },
            },
            yAxis: {
                type: 'value',
                axisLabel: { color: '#9ca3af', fontSize: 10 },
                splitLine: { lineStyle: { color: '#f3f4f6' } },
                axisLine: { show: false },
                axisTick: { show: false },
            },
            series
        };
    }, [aiHourly, t]);

    const onChartClick = (params: any) => {
        const index = (params.componentType === 'xAxis') 
            ? sorted.findIndex(d => d.date.endsWith(params.value))
            : params.dataIndex;

        if (index === undefined || index < 0) return;
        const entry = sorted[index];
        if (!entry) return;

        setAiSelectedDate(entry.date);
        setAiHourlyLoading(true);

        const start = entry.ts;
        const end = start + 86400000;
        const step = 3600000;

        callRpc<{ ts: number, costUsd: number, models: Record<string, number> }[]>('agent.stats.range', { start, end, step })
            .then(d => setAiHourly((d || []).map(item => ({
                hour: new Date(item.ts).getHours() + ':00',
                costUsd: item.costUsd,
                models: item.models
            }))))
            .catch(() => {})
            .finally(() => setAiHourlyLoading(false));
    };

    const today = daily[0];

    return (
        <div className="panel" style={{ flex: 1, minWidth: 0, minHeight: 360, display: 'flex', flexDirection: 'column' }}>
            <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{aiSelectedDate ? `${t('dashboard.ai_usage_title')} - ${aiSelectedDate}` : t('dashboard.ai_usage_title')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {!loading && today && !aiSelectedDate && (
                        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-secondary)' }}>
                            {t('dashboard.token_summary', { input: today.inputTokens.toLocaleString(), output: today.outputTokens.toLocaleString(), cost: toCny(today.costUsd) })}
                        </span>
                    )}
                    {aiSelectedDate && (
                        <Button variant="secondary" size="sm" onClick={() => setAiSelectedDate(null)}>
                            {t('dashboard.qr_hourly_back')}
                        </Button>
                    )}
                </div>
            </div>
            <div className="panel-content" style={{ padding: '20px 24px', flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
                {loading || (aiSelectedDate && aiHourlyLoading) ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
                ) : (
                    <>
                        <div style={{ height: 200, display: 'flex', flexDirection: 'column' }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                                {aiSelectedDate ? t('dashboard.qr_hourly_title', { date: aiSelectedDate }) : t('dashboard.cost_trend_label')}
                            </div>
                            {week.length === 0 ? (
                                <EmptyState label={t('dashboard.no_trend_data')} />
                            ) : aiSelectedDate && aiHourly.every(h => Object.keys(h.models || {}).length === 0) ? (
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border-color)', borderRadius: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
                                    {t('dashboard.no_trend_data')}
                                </div>
                            ) : (
                                <ReactECharts 
                                    option={aiSelectedDate ? aiHourlyChartOption : chartOption} 
                                    style={{ height: '100%' }} 
                                    notMerge={true} 
                                    onEvents={aiSelectedDate ? {} : { 'click': onChartClick }}
                                />
                            )}
                        </div>

                        {/* 最近调用记录 - 紧凑版 */}
                        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                            <div
                                onClick={() => setRecentExpanded(e => !e)}
                                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: recentExpanded ? 10 : 0, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}
                            >
                                <span style={{ fontSize: 10, transition: 'transform 0.15s', display: 'inline-block', transform: recentExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                                {t('dashboard.recent_calls')}
                                {recent.length > 0 && <span style={{ fontWeight: 400, opacity: 0.6 }}>({recent.length})</span>}
                            </div>
                            {recentExpanded && (
                                <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 8, fontSize: 11, border: '1px solid var(--border-color)', borderRadius: 4 }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <tbody style={{ color: 'var(--text-primary)' }}>
                                            {recent.map((r, i) => (
                                                <tr key={i} style={{ borderBottom: i === recent.length - 1 ? 'none' : '1px solid var(--border-color)' }}>
                                                    <td style={{ padding: '6px 8px' }}>{r.method.replace('agent.', '')}</td>
                                                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{r.model}</td>
                                                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>¥{toCny(r.costUsd)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
