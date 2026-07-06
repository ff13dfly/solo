import React from "react";
import { Target, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
import { ViewType } from "./AgendaTypes";
import { useI18n } from "../../i18n/I18nProvider";
import { isSameDay } from "./DateUtils";

interface AgendaHeaderProps {
    now: Date;
    viewDate: Date;
    activeView: ViewType;
    setActiveView: (view: ViewType) => void;
    onScrollToToday: () => void;
    onNavigate: (direction: 'prev' | 'next') => void;
}

export default function AgendaHeader({ now, viewDate, activeView, setActiveView, onScrollToToday, onNavigate }: AgendaHeaderProps) {
    const { t, locale } = useI18n();
    const VIEWS: ViewType[] = ["日", "周", "月", "年"];
    const VIEW_LABELS: Record<ViewType, string> = {
        "日": t('agenda.views.day'),
        "周": t('agenda.views.week'),
        "月": t('agenda.views.month'),
        "年": t('agenda.views.year'),
    };

    const getWeekNumber = (d: Date, returnYear = false) => {
        const date = new Date(d.getTime());
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
        if (returnYear) return date.getFullYear();
        const week1 = new Date(date.getFullYear(), 0, 4);
        return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    };

    return (
        <div className="flex flex-col border-b border-[#d2d2d7] bg-white/80 backdrop-blur-md sticky top-0 z-20">
            <div className="flex items-center justify-between px-6 py-4">
                {/* Left Column: Title and Navigation */}
                <div className="flex items-center gap-4">
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight text-[#1d1d1f]">
                            {activeView === "年"
                                ? `${viewDate.getFullYear()}${t('agenda.year_suffix')}`
                                : (activeView === "月" || activeView === "周")
                                    ? viewDate.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long' })
                                    : viewDate.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'long' })
                            }
                        </h2>
                        <p className="text-[10px] font-medium text-[#86868b] flex items-center gap-1.5 mt-0.5 uppercase tracking-wider">
                            <Clock size={10} className="text-[#0071e3]" />
                            {activeView === "年"
                                ? t('agenda.header.annual_overview')
                                : activeView === "月"
                                    ? t('agenda.header.month_overview')
                                    : activeView === "周"
                                        ? t('agenda.header.week_overview')
                                            .replace('{y}', getWeekNumber(viewDate, true).toString())
                                            .replace('{n}', getWeekNumber(viewDate).toString())
                                        : (isSameDay(viewDate, now) ? t('agenda.header.todays_schedule') : viewDate.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' }))
                            }
                        </p>
                    </div>
                </div>

                {/* Right Column: Toolbar Actions */}
                <div className="flex items-center gap-4">
                    {/* Compact Today Button */}
                    <button
                        onClick={onScrollToToday}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold bg-[#f5f5f7] text-[#1d1d1f] rounded-lg border border-black/5 hover:bg-[#e8e8ed] transition-all hover:scale-105 active:scale-95"
                    >
                        <Target size={13} className="text-[#0071e3]" />
                        {t('agenda.header.today').toUpperCase()}
                    </button>

                    {/* Segmented Control Switcher */}
                    <div className="flex p-0.5 bg-[#f5f5f7] rounded-lg border border-black/5 relative h-8">
                        {VIEWS.map((view) => (
                            <button
                                key={view}
                                onClick={() => setActiveView(view)}
                                className={`relative z-10 px-4 text-[11px] font-bold transition-colors duration-200 ${activeView === view ? "text-[#1d1d1f]" : "text-[#86868b] hover:text-[#1d1d1f]"}`}
                            >
                                {activeView === view && (
                                    <motion.div
                                        layoutId="header-view-pill"
                                        className="absolute inset-0 bg-white rounded-[6px] shadow-sm z-0 border border-black/5"
                                        transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                                    />
                                )}
                                <span className="relative z-20">{VIEW_LABELS[view]}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
