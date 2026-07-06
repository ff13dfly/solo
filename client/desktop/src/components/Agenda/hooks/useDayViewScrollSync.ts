import { useEffect, useRef, useCallback } from "react";
import { HOUR_HEIGHT } from "../AgendaTypes";
import { GRID_TOP_PADDING } from "../TimeGrid";

interface UseDayViewScrollSyncProps {
    scrollRef: React.RefObject<HTMLDivElement>;
    timeAxisScrollRef: React.RefObject<HTMLDivElement>;
    prevDayScrollRef: React.RefObject<HTMLDivElement>;
    nextDayScrollRef: React.RefObject<HTMLDivElement>;
    now: Date;
    viewDate: Date;
}

export function useDayViewScrollSync({
    scrollRef,
    timeAxisScrollRef,
    prevDayScrollRef,
    nextDayScrollRef,
    now,
    viewDate
}: UseDayViewScrollSyncProps) {
    const lastScrollTopRef = useRef(0);

    // Initial "jump to now" logic
    useEffect(() => {
        if (scrollRef.current && !lastScrollTopRef.current) {
            const hour = now.getHours();
            let targetScroll = 0;
            if (hour < 13) targetScroll = 6.5 * HOUR_HEIGHT + GRID_TOP_PADDING;
            else if (hour < 18) targetScroll = 10.5 * HOUR_HEIGHT + GRID_TOP_PADDING;
            else targetScroll = scrollRef.current.scrollHeight;

            scrollRef.current.scrollTop = targetScroll;
            lastScrollTopRef.current = targetScroll;
        }
    }, [now, scrollRef]);

    // Handle vertical scroll synchronization across all columns/axis
    const handleVerticalScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const scrollTop = e.currentTarget.scrollTop;
        lastScrollTopRef.current = scrollTop;
        if (timeAxisScrollRef.current) timeAxisScrollRef.current.scrollTop = scrollTop;
        if (prevDayScrollRef.current) prevDayScrollRef.current.scrollTop = scrollTop;
        if (nextDayScrollRef.current) nextDayScrollRef.current.scrollTop = scrollTop;
    }, [timeAxisScrollRef, prevDayScrollRef, nextDayScrollRef]);

    // Re-apply scroll position after carousel transition
    useEffect(() => {
        const top = lastScrollTopRef.current;
        if (scrollRef.current) scrollRef.current.scrollTop = top;
        if (timeAxisScrollRef.current) timeAxisScrollRef.current.scrollTop = top;
        if (prevDayScrollRef.current) prevDayScrollRef.current.scrollTop = top;
        if (nextDayScrollRef.current) nextDayScrollRef.current.scrollTop = top;
    }, [viewDate, scrollRef, timeAxisScrollRef, prevDayScrollRef, nextDayScrollRef]);

    return {
        handleVerticalScroll,
        lastScrollTop: lastScrollTopRef
    };
}
