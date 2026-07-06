import { useState, useMemo, useEffect } from "react";
import { getMonday } from "../AgendaUtils";
import { formatDate, isSameDay, clearTime } from "../DateUtils";

interface DateInfo {
    full: string;
    originalDate: Date;
    day: number;
    isToday: boolean;
}

interface WindowInfo {
    offset: number;
    dates: DateInfo[];
}

interface UseWeekViewWindowsProps {
    viewDate: Date;
    now: Date;
}

export function useWeekViewWindows({ viewDate, now }: UseWeekViewWindowsProps) {
    const [centerDate, setCenterDate] = useState(() => clearTime(new Date(viewDate)));
    const todayStr = useMemo(() => now.toDateString(), [now]);

    const getWeekDates = (anchor: Date) => {
        const dates: DateInfo[] = [];
        const currentDay = anchor.getDay();
        const diff = anchor.getDate() - (currentDay === 0 ? 6 : currentDay - 1);
        const monday = new Date(anchor);
        monday.setDate(diff);

        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            dates.push({
                full: formatDate(d),
                originalDate: new Date(d),
                day: d.getDate(),
                isToday: isSameDay(d, now),
            });
        }
        return dates;
    };

    const anchorMonday = useMemo(() => getMonday(centerDate), [centerDate]);

    const slidingWindows = useMemo(() => {
        const baseTime = anchorMonday.getTime();
        return [-2, -1, 0, 1, 2].map((offset) => {
            const d = new Date(baseTime);
            d.setDate(new Date(baseTime).getDate() + offset * 7);
            return { offset, dates: getWeekDates(d) };
        });
    }, [anchorMonday, todayStr]);

    // Sync with external viewDate changes
    useEffect(() => {
        if (!isSameDay(viewDate, centerDate)) {
            setCenterDate(new Date(viewDate));
        }
    }, [viewDate]);

    return {
        centerDate,
        setCenterDate,
        anchorMonday,
        slidingWindows,
    };
}
