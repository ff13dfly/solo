import React from "react";
import { motion } from "framer-motion";
import { useI18n } from "../../../i18n/I18nProvider";
import { formatDate, parseDate, isSameDay } from "../DateUtils";

interface MonthViewProps {
    now: Date;
    viewDate: Date;
    onSelectDate?: (date: Date) => void;
    todayTrigger?: number;
}

interface MonthBlockProps {
    year: number;
    month: number;
    now: Date;
    weekdays: string[];
    onSelectDate?: (date: Date) => void;
}

const MonthBlock = ({ year, month, now, weekdays, onSelectDate }: MonthBlockProps) => {
    const daysOfMonth = React.useMemo(() => {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startOffset = firstDay.getDay(); // Sunday start to match YearView

        const days = [];
        // Prev month padding
        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for (let i = startOffset - 1; i >= 0; i--) {
            const d = new Date(year, month - 1, prevMonthLastDay - i);
            days.push({ day: prevMonthLastDay - i, isCurrentMonth: false, full: formatDate(d) });
        }
        // Current month
        for (let i = 1; i <= lastDay.getDate(); i++) {
            const d = new Date(year, month, i);
            days.push({ day: i, isCurrentMonth: true, full: formatDate(d) });
        }
        // Next month padding
        const remaining = 42 - days.length;
        for (let i = 1; i <= remaining; i++) {
            const d = new Date(year, month + 1, i);
            days.push({ day: i, isCurrentMonth: false, full: formatDate(d) });
        }
        return days;
    }, [year, month]);

    const monthName = new Date(year, month).toLocaleDateString('zh-CN', { month: 'long' });

    return (
        <div className="mb-0 pt-8" id={`month-block-${year}-${month}`}>
            <div className="flex items-center gap-4 mb-8 px-4">
                <h3 className="text-xl font-bold text-[#1d1d1f]">{year}年 {monthName}</h3>
                <div className="flex-1 h-[1px] bg-[#f2f2f7]"></div>
            </div>

            <div className="grid grid-cols-7 border-b border-[#f2f2f7] bg-[#fbfbfd]">
                {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
                    <div key={day} className="py-2 text-center text-[10px] font-bold text-[#86868b] uppercase border-l border-[#f2f2f7] first:border-l-0">
                        {day}
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-7 auto-rows-[120px]">
                {daysOfMonth.map((info, i) => {
                    const isToday = isSameDay(parseDate(info.full), now);
                    return (
                        <div
                            key={i}
                            onClick={() => onSelectDate?.(parseDate(info.full))}
                            className={`border-b border-r border-[#f2f2f7] p-3 flex flex-col gap-1 hover:bg-[#f5f5f7] transition-colors cursor-pointer group ${!info.isCurrentMonth ? 'opacity-30' : ''}`}
                        >
                            <div className={`text-[12px] font-bold w-6 h-6 flex items-center justify-center rounded-full transition-colors ${isToday ? 'bg-[#ff3b30] text-white' : 'text-[#1d1d1f] group-hover:text-[#ff3b30]'}`}>
                                {info.day}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default function MonthView({ now, viewDate, onSelectDate, todayTrigger }: MonthViewProps) {
    const { t } = useI18n();
    const currentYear = viewDate.getFullYear();
    const currentMonth = viewDate.getMonth();

    const [visibleMonths, setVisibleMonths] = React.useState<{ year: number, month: number }[]>(() => {
        const months = [];
        for (let i = -6; i <= 6; i++) {
            const date = new Date(currentYear, currentMonth + i, 1);
            months.push({ year: date.getFullYear(), month: date.getMonth() });
        }
        return months;
    });

    const containerRef = React.useRef<HTMLDivElement>(null);
    const isInitialScroll = React.useRef(true);

    const handleScroll = () => {
        if (!containerRef.current || isInitialScroll.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;

        if (scrollTop < 1000) {
            setVisibleMonths(prev => {
                const first = prev[0];
                const newMonths = [];
                for (let i = 3; i >= 1; i--) {
                    const date = new Date(first.year, first.month - i, 1);
                    newMonths.push({ year: date.getFullYear(), month: date.getMonth() });
                }
                return [...newMonths, ...prev].slice(0, 40);
            });
        }

        if (scrollHeight - scrollTop - clientHeight < 1000) {
            setVisibleMonths(prev => {
                const last = prev[prev.length - 1];
                const newMonths = [];
                for (let i = 1; i <= 3; i++) {
                    const date = new Date(last.year, last.month + i, 1);
                    newMonths.push({ year: date.getFullYear(), month: date.getMonth() });
                }
                return [...prev, ...newMonths].slice(-40);
            });
        }
    };

    React.useEffect(() => {
        const timer = setTimeout(() => {
            const currentMonthEl = document.getElementById(`month-block-${currentYear}-${currentMonth}`);
            if (currentMonthEl && containerRef.current) {
                const container = containerRef.current;
                const rect = currentMonthEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const relativeTop = rect.top - containerRect.top + container.scrollTop - 4; // Fine-tuned for header centering

                container.scrollTo({ top: relativeTop, behavior: 'auto' });

                setTimeout(() => {
                    isInitialScroll.current = false;
                }, 200);
            }
        }, 50);
        return () => clearTimeout(timer);
    }, [currentYear, currentMonth, todayTrigger]);

    return (
        <motion.div
            key="month-view"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            ref={containerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto no-scrollbar bg-white"
        >
            <div className="max-w-[1200px] mx-auto py-10">
                {visibleMonths.map(({ year, month }) => (
                    <MonthBlock
                        key={`${year}-${month}`}
                        year={year}
                        month={month}
                        now={now}
                        weekdays={[]} // Using hardcoded labels to match YearView style
                        onSelectDate={onSelectDate}
                    />
                ))}
            </div>
        </motion.div>
    );
}
