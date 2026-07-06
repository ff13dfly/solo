import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useI18n } from "../../../i18n/I18nProvider";

interface YearViewProps {
    now: Date;
    viewDate: Date;
    onSelectDate?: (date: Date) => void;
    todayTrigger?: number;
}

const WEEK_DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

interface DayInfo {
    day: number;
    isCurrentMonth: boolean;
    isToday: boolean;
    isWeekend: boolean;
    hasEvent?: boolean;
}

const getMonthDays = (year: number, month: number, today: Date): DayInfo[] => {
    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const days: DayInfo[] = [];

    const firstDayWeekday = firstDayOfMonth.getDay();
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = firstDayWeekday - 1; i >= 0; i--) {
        days.push({
            day: prevMonthLastDay - i,
            isCurrentMonth: false,
            isToday: false,
            isWeekend: false,
        });
    }

    const todayDate = today.getDate();
    const todayMonth = today.getMonth();
    const todayYear = today.getFullYear();

    for (let i = 1; i <= lastDayOfMonth.getDate(); i++) {
        const currentDayDate = new Date(year, month, i);
        const weekday = currentDayDate.getDay();
        days.push({
            day: i,
            isCurrentMonth: true,
            isToday: i === todayDate && month === todayMonth && year === todayYear,
            isWeekend: weekday === 0 || weekday === 6,
            hasEvent: (i + month + year) % 7 === 0 || (i * month) % 11 === 5
        });
    }

    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
        days.push({
            day: i,
            isCurrentMonth: false,
            isToday: false,
            isWeekend: false,
        });
    }
    return days;
};

const MonthCalendar = ({ year, month, monthName, today, onSelectDate }: { year: number; month: number; monthName: string; today: Date; onSelectDate?: (date: Date) => void }) => {
    const days = getMonthDays(year, month, today);
    return (
        <div className="flex flex-col gap-3 select-none group">
            <h3 className="text-lg font-bold text-[#ff3b30] tracking-tight ml-1">{monthName}</h3>
            <div className="grid grid-cols-7 text-center mb-1">
                {WEEK_DAY_LABELS.map((label) => (
                    <span key={label} className="text-[10px] font-medium text-[#86868b]">{label}</span>
                ))}
            </div>
            <div className="grid grid-cols-7 gap-y-1 text-center">
                {days.map((info, idx) => (
                    <div
                        key={idx}
                        onClick={() => onSelectDate?.(new Date(year, month, info.day))}
                        className="relative flex items-center justify-center h-6 w-full group/day cursor-pointer"
                    >
                        <span className={`text-[11px] font-bold z-10 transition-colors ${info.isToday ? 'text-white' : info.isCurrentMonth ? 'text-[#1d1d1f]' : 'text-[#d2d2d7]'} ${!info.isToday && info.isCurrentMonth && 'group-hover/day:text-[#ff3b30]'}`}>
                            {info.day}
                        </span>
                        {info.isToday && (
                            <motion.div className="absolute inset-0 m-auto w-5 h-5 bg-[#ff3b30] rounded-full z-0" />
                        )}
                        {info.hasEvent && !info.isToday && info.isCurrentMonth && (
                            <div className="absolute bottom-0 w-4 h-[1.5px] bg-[#d2d2d7] rounded-full" />
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

const YearBlock = ({ year, today, t, months, onSelectDate }: { year: number; today: Date; t: any; months: string[]; onSelectDate?: (date: Date) => void }) => (
    <div className="mb-0 pt-8">
        <div className="flex items-center gap-4 mb-8">
            <h2 className="text-3xl font-black text-[#1d1d1f] tracking-tighter">{year}年</h2>
            <div className="flex-1 h-[1px] bg-[#f2f2f7]"></div>
        </div>
        <div className="grid grid-cols-4 gap-x-8 gap-y-12" id={`year-grid-${year}`}>
            {months.map((monthName, idx) => (
                <MonthCalendar key={monthName} year={year} month={idx} monthName={monthName} today={today} onSelectDate={onSelectDate} />
            ))}
        </div>
    </div>
);

export default function YearView({ now, viewDate, onSelectDate, todayTrigger }: YearViewProps) {
    const { t } = useI18n();
    const MONTH_NAMES = t('agenda.months');
    const currentYear = now.getFullYear();
    const [years, setYears] = useState<number[]>(
        Array.from({ length: 11 }, (_, i) => currentYear - 5 + i)
    );
    const containerRef = useRef<HTMLDivElement>(null);
    const isInitialScroll = useRef(true);

    const handleScroll = () => {
        if (!containerRef.current || isInitialScroll.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;

        if (scrollTop < 400) {
            setYears(prev => {
                const first = prev[0];
                if (first > 1900) {
                    const newYears = [first - 3, first - 2, first - 1, ...prev];
                    return newYears.slice(0, 30);
                }
                return prev;
            });
        }

        if (scrollHeight - scrollTop - clientHeight < 400) {
            setYears(prev => {
                const last = prev[prev.length - 1];
                if (last < 2100) {
                    const newYears = [...prev, last + 1, last + 2, last + 3];
                    return newYears.slice(-30);
                }
                return prev;
            });
        }
    };

    useEffect(() => {
        const timer = setTimeout(() => {
            const gridEl = document.getElementById(`year-grid-${currentYear}`);
            if (gridEl && containerRef.current) {
                // Centering on the grid itself to hide the internal year header
                const container = containerRef.current;
                const rect = gridEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const relativeTop = rect.top - containerRect.top + container.scrollTop - 8; // Perfectly aligned with global header

                container.scrollTo({ top: relativeTop, behavior: 'auto' });

                // Keep scroll detection disabled for a moment to let the browser settle
                setTimeout(() => {
                    isInitialScroll.current = false;
                }, 200);
            }
        }, 50);
        return () => clearTimeout(timer);
    }, [currentYear, todayTrigger]);

    return (
        <motion.div
            key="year-view"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            ref={containerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto no-scrollbar bg-white"
        >
            <div className="max-w-[1200px] mx-auto p-10 pt-2">
                {years.map(year => (
                    <div key={year} id={`year-block-${year}`} className="scroll-mt-6">
                        <YearBlock year={year} today={now} t={t} months={MONTH_NAMES} onSelectDate={onSelectDate} />
                    </div>
                ))}
            </div>
        </motion.div>
    );
}
